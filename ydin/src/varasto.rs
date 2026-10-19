//! SQLite-varasto (SUUNNITELMA.md §3.2–3.3, S-3): yksiköt, muutosloki, kursorit ja tiivisteet.

use crate::muutosloki::{self, versio_tekstina, versio_tekstista, Result, Tapahtuma};
use crate::yksikko::{vertaa, Hlc, Tulos, Vertailu, Yhdistaja, Yksikko};
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

const SKEEMAVERSIO: &str = "1";

const SKEEMA_1: &str = "
CREATE TABLE yksikot  (polku TEXT NOT NULL, id TEXT NOT NULL, versio TEXT NOT NULL, aika TEXT NOT NULL, sisalto BLOB, poistettu INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (polku, id));
CREATE TABLE muutosloki (seq INTEGER PRIMARY KEY AUTOINCREMENT, polku TEXT NOT NULL, id TEXT NOT NULL, versio TEXT NOT NULL, aika TEXT NOT NULL);
CREATE TABLE laitteet (laite TEXT PRIMARY KEY, nimi TEXT, alusta TEXT, rooli TEXT, julkinen_avain TEXT, wg_avain TEXT, mallit TEXT, nahty TEXT);
CREATE TABLE liitteet (sha256 TEXT PRIMARY KEY, koko INTEGER NOT NULL, tyyppi TEXT, polku TEXT);
CREATE TABLE kursorit (vertainen TEXT PRIMARY KEY, seq INTEGER NOT NULL);
CREATE INDEX muutosloki_polku ON muutosloki(polku, seq);
";

const YKSIKKO_KENTAT: &str = "polku, id, versio, aika, sisalto, poistettu";

pub struct Varasto {
    yhteys: Mutex<Connection>,
    polku: PathBuf,
}

fn muunnosvirhe(
    indeksi: usize,
    e: impl Into<Box<dyn std::error::Error + Send + Sync>>,
) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(indeksi, rusqlite::types::Type::Text, e.into())
}

fn yksikko_rivilta(r: &Row<'_>) -> Result<Yksikko> {
    let versio: String = r.get(2)?;
    let aika: String = r.get(3)?;
    Ok(Yksikko {
        polku: r.get(0)?,
        id: r.get(1)?,
        versio: versio_tekstista(2, &versio)?,
        aika: Hlc::parse(&aika)
            .ok_or_else(|| muunnosvirhe(3, format!("virheellinen HLC: {aika}")))?,
        sisalto: r.get(4)?,
        poistettu: r.get::<_, i64>(5)? != 0,
    })
}

fn hae(c: &Connection, polku: &str, id: &str) -> Result<Option<Yksikko>> {
    c.query_row(
        &format!("SELECT {YKSIKKO_KENTAT} FROM yksikot WHERE polku = ?1 AND id = ?2"),
        params![polku, id],
        yksikko_rivilta,
    )
    .optional()
}

/// Tallettaa yksikön (lisäys tai korvaus) ja kirjaa muutoslokiin; palauttaa `seq`.
fn talleta(c: &Connection, y: &Yksikko) -> Result<u64> {
    let aika = y.aika.to_string();
    c.execute(
        "INSERT INTO yksikot (polku, id, versio, aika, sisalto, poistettu) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
         ON CONFLICT(polku, id) DO UPDATE SET versio = excluded.versio, aika = excluded.aika, \
         sisalto = excluded.sisalto, poistettu = excluded.poistettu",
        params![
            y.polku,
            y.id,
            versio_tekstina(&y.versio)?,
            aika,
            y.sisalto,
            i64::from(y.poistettu)
        ],
    )?;
    muutosloki::kirjaa(c, &y.polku, &y.id, &y.versio, &aika)
}

fn heksa(tavut: &[u8]) -> String {
    tavut.iter().map(|b| format!("{b:02x}")).collect()
}

impl Varasto {
    /// Avaa (tai luo) tietokannan: WAL, vierasavaimet päälle ja migraatio versioon 1.
    pub fn avaa(polku: &Path) -> Result<Varasto> {
        let mut c = Connection::open(polku)?;
        c.pragma_update(None, "journal_mode", "WAL")?;
        c.pragma_update(None, "foreign_keys", "ON")?;
        c.busy_timeout(std::time::Duration::from_secs(5))?;
        Self::migroi(&mut c)?;
        Ok(Varasto {
            yhteys: Mutex::new(c),
            polku: polku.to_path_buf(),
        })
    }

    /// Solmun datahakemisto: tietokantatiedoston hakemisto.
    pub fn data(&self) -> Option<&Path> {
        self.polku.parent()
    }

    fn migroi(c: &mut Connection) -> Result<()> {
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let meta_on: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta')",
            [],
            |r| r.get(0),
        )?;
        if !meta_on {
            tx.execute_batch(SKEEMA_1)?;
            tx.execute_batch("CREATE TABLE meta (avain TEXT PRIMARY KEY, arvo TEXT);")?;
            tx.execute(
                "INSERT INTO meta (avain, arvo) VALUES ('skeemaversio', ?1)",
                params![SKEEMAVERSIO],
            )?;
        } else {
            let versio: Option<String> = tx
                .query_row(
                    "SELECT arvo FROM meta WHERE avain = 'skeemaversio'",
                    [],
                    |r| r.get(0),
                )
                .optional()?;
            if versio.as_deref() != Some(SKEEMAVERSIO) {
                return Err(muunnosvirhe(
                    0,
                    format!("tuntematon skeemaversio: {versio:?}"),
                ));
            }
        }
        tx.commit()
    }

    fn yhteys(&self) -> MutexGuard<'_, Connection> {
        self.yhteys.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Yhdistää `y`:n nykyiseen yksikköön. Muutos kirjoittaa rivin ja muutoslokin ja palauttaa `seq`:n;
    /// ei muutosta palauttaa `None`. Rinnakkaiset: nykyinen jää paikalleen ja saapuva talletetaan
    /// tunnuksella `<id>~<laite>` (laite = saapuvan HLC:n laite).
    pub fn kirjoita(&self, y: &Yksikko, yh: Yhdistaja) -> Result<Option<u64>> {
        let mut c = self.yhteys();
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let nykyinen = hae(&tx, &y.polku, &y.id)?;
        let seq = match crate::yksikko::yhdista(nykyinen.as_ref(), y, yh) {
            Tulos::Yksi(r) => {
                if nykyinen.as_ref() == Some(&r) {
                    None
                } else {
                    Some(talleta(&tx, &r)?)
                }
            }
            Tulos::Rinnakkaiset(v) => {
                let Some(saapuva) = v.get(1) else {
                    return Ok(None);
                };
                let sisar = Yksikko {
                    id: format!("{}~{}", saapuva.id, saapuva.aika.laite),
                    ..saapuva.clone()
                };
                match hae(&tx, &sisar.polku, &sisar.id)? {
                    Some(vanha)
                        if vanha == sisar
                            || vertaa(&sisar.versio, &vanha.versio) != Vertailu::Uudempi =>
                    {
                        None
                    }
                    _ => Some(talleta(&tx, &sisar)?),
                }
            }
        };
        tx.commit()?;
        Ok(seq)
    }

    pub fn lue(&self, polku: &str, id: &str) -> Result<Option<Yksikko>> {
        hae(&self.yhteys(), polku, id)
    }

    /// Polun yksiköt (hautakivet mukana) tunnuksen järjestyksessä.
    pub fn listaa(&self, polku: &str) -> Result<Vec<Yksikko>> {
        let c = self.yhteys();
        let mut kysely = c.prepare(&format!(
            "SELECT {YKSIKKO_KENTAT} FROM yksikot WHERE polku = ?1 ORDER BY id"
        ))?;
        let rivit = kysely.query_map(params![polku], yksikko_rivilta)?;
        rivit.collect()
    }

    /// Polun yksiköiden otsakkeet (hautakivet mukana, `sisalto` = None) tunnuksen järjestyksessä;
    /// sisältöjä ei lueta, joten muisti ei kasva polun datan mukana (esim. `peili`).
    pub fn listaa_otsakkeet(&self, polku: &str) -> Result<Vec<Yksikko>> {
        let c = self.yhteys();
        let mut kysely = c.prepare(
            "SELECT polku, id, versio, aika, NULL, poistettu FROM yksikot WHERE polku = ?1 ORDER BY id",
        )?;
        let rivit = kysely.query_map(params![polku], yksikko_rivilta)?;
        rivit.collect()
    }

    /// Polun yksiköt, joiden tunnus on välillä `alku <= id < loppu`, tunnuksen järjestyksessä
    /// (PRIMARY KEY -indeksin väli, ei polun täyttä läpikäyntiä).
    pub fn listaa_vali(&self, polku: &str, alku: &str, loppu: &str) -> Result<Vec<Yksikko>> {
        let c = self.yhteys();
        let mut kysely = c.prepare(&format!(
            "SELECT {YKSIKKO_KENTAT} FROM yksikot WHERE polku = ?1 AND id >= ?2 AND id < ?3 ORDER BY id"
        ))?;
        let rivit = kysely.query_map(params![polku, alku, loppu], yksikko_rivilta)?;
        rivit.collect()
    }

    /// Kaikki erilliset polut (hautakivien polut mukana) lataamatta yksiköitä.
    pub fn polut(&self) -> Result<BTreeSet<String>> {
        let c = self.yhteys();
        let mut kysely = c.prepare("SELECT DISTINCT polku FROM yksikot")?;
        let rivit = kysely.query_map([], |r| r.get::<_, String>(0))?;
        rivit.collect()
    }

    /// Yksiköt, joiden polku alkaa etuliitteellä (kirjainkoko merkitsee; esim. `rekisterit/`, `lahde/`).
    pub fn listaa_etuliite(&self, etuliite: &str) -> Result<Vec<Yksikko>> {
        let c = self.yhteys();
        let mut kysely = c.prepare(&format!(
            "SELECT {YKSIKKO_KENTAT} FROM yksikot WHERE substr(polku, 1, ?2) = ?1 ORDER BY polku, id"
        ))?;
        let pituus = etuliite.chars().count() as i64;
        let rivit = kysely.query_map(params![etuliite, pituus], yksikko_rivilta)?;
        rivit.collect()
    }

    pub fn loki(&self, since: u64, raja: usize) -> Result<Vec<Tapahtuma>> {
        muutosloki::loki(&self.yhteys(), since, raja)
    }

    pub fn seq(&self) -> Result<u64> {
        muutosloki::seq(&self.yhteys())
    }

    pub fn kursori(&self, vertainen: &str) -> Result<u64> {
        muutosloki::kursori(&self.yhteys(), vertainen)
    }

    pub fn aseta_kursori(&self, vertainen: &str, seq: u64) -> Result<()> {
        muutosloki::aseta_kursori(&self.yhteys(), vertainen, seq)
    }

    /// SHA-256 polun (id, versio) -pareista tunnuksen mukaan lajiteltuina; tyhjä polku = tyhjän tiiviste.
    pub fn tiiviste(&self, polku: &str) -> Result<String> {
        let c = self.yhteys();
        let mut kysely =
            c.prepare("SELECT id, versio FROM yksikot WHERE polku = ?1 ORDER BY id")?;
        let parit = kysely.query_map(params![polku], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut sha = Sha256::new();
        for pari in parit {
            let (id, versio) = pari?;
            sha.update(format!("{id}\t{versio}\n").as_bytes());
        }
        Ok(heksa(&sha.finalize()))
    }
}
