//! SQLite-varasto (SUUNNITELMA.md §3.2–3.3, S-3): yksiköt, muutosloki, kursorit ja tiivisteet.

use crate::muutosloki::{self, versio_tekstina, versio_tekstista, Result, Tapahtuma};
use crate::yksikko::{vertaa, Hlc, Tulos, Vertailu, Yhdistaja, Yksikko};
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

const SKEEMAVERSIO: &str = "2";

/// Skeema 2 (T-73): peili-yksikön sisältöaika ms (muilla poluilla NULL).
const SKEEMA_2_MUUTOS: &str = "ALTER TABLE yksikot ADD COLUMN sisaltoaika INTEGER";

/// Siirtymän 1 → 2 eräkoko: yksiköitä enintään näin monta yhtä commitia kohden.
const SIIRTYMA_ERA: usize = 500;

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
/// Peili-yksikön `sisaltoaika` (T-73) on annettu arvo tai, jos sitä ei anneta, laskettu tallennettavasta
/// sisällöstä (HLC-ajan varapolku); muilla poluilla sarake on NULL.
fn talleta(c: &Connection, y: &Yksikko, sisaltoaika: Option<u64>) -> Result<u64> {
    let aika = y.aika.to_string();
    let sisaltoaika: Option<i64> = (y.polku == crate::peili::POLKU).then(|| {
        sisaltoaika.unwrap_or_else(|| {
            y.sisalto
                .as_deref()
                .map_or(y.aika.ms, |s| crate::peili::sisaltoaika(s, y.aika.ms))
        }) as i64
    });
    c.execute(
        "INSERT INTO yksikot (polku, id, versio, aika, sisalto, poistettu, sisaltoaika) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
         ON CONFLICT(polku, id) DO UPDATE SET versio = excluded.versio, aika = excluded.aika, \
         sisalto = excluded.sisalto, poistettu = excluded.poistettu, sisaltoaika = excluded.sisaltoaika",
        params![
            y.polku,
            y.id,
            versio_tekstina(&y.versio)?,
            aika,
            y.sisalto,
            i64::from(y.poistettu),
            sisaltoaika
        ],
    )?;
    muutosloki::kirjaa(c, &y.polku, &y.id, &y.versio, &aika)
}

fn heksa(tavut: &[u8]) -> String {
    tavut.iter().map(|b| format!("{b:02x}")).collect()
}

impl Varasto {
    /// Avaa (tai luo) tietokannan: WAL, vierasavaimet päälle ja migraatio versioon 2.
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
            tx.execute_batch(SKEEMA_2_MUUTOS)?;
            tx.execute_batch("CREATE TABLE meta (avain TEXT PRIMARY KEY, arvo TEXT);")?;
            tx.execute(
                "INSERT INTO meta (avain, arvo) VALUES ('skeemaversio', ?1)",
                params![SKEEMAVERSIO],
            )?;
            return tx.commit();
        }
        let versio: Option<String> = tx
            .query_row(
                "SELECT arvo FROM meta WHERE avain = 'skeemaversio'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        match versio.as_deref() {
            Some(SKEEMAVERSIO) => tx.commit(),
            Some("1") => {
                tx.commit()?;
                Self::migroi_1_2(c)
            }
            _ => Err(muunnosvirhe(
                0,
                format!("tuntematon skeemaversio: {versio:?}"),
            )),
        }
    }

    /// Siirtymä 1 → 2 (T-73): sarake `sisaltoaika`, vanhojen peili-yksiköiden täyttö yksi kerrallaan
    /// (yksi sisältö muistissa kerrallaan, commit enintään `SIIRTYMA_ERA` yksikön välein) ja HLC-pohjaisen
    /// karsintarajan poisto. Versio nousee vasta lopuksi, joten keskeytynyt siirtymä jatkuu seuraavassa
    /// avauksessa. Kirjaa stderriin yksiköiden määrän ja keston.
    fn migroi_1_2(c: &mut Connection) -> Result<()> {
        let alku = std::time::Instant::now();
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let sarake_on: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM pragma_table_info('yksikot') WHERE name = 'sisaltoaika')",
            [],
            |r| r.get(0),
        )?;
        if !sarake_on {
            tx.execute_batch(SKEEMA_2_MUUTOS)?;
        }
        tx.commit()?;

        let mut yksikoita = 0usize;
        let mut viimeinen = String::new();
        loop {
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let era: Vec<(String, String)> = {
                let mut kysely = tx.prepare(
                    "SELECT id, aika FROM yksikot WHERE polku = ?1 AND sisaltoaika IS NULL \
                     AND id > ?2 ORDER BY id LIMIT ?3",
                )?;
                let rivit = kysely.query_map(
                    params![crate::peili::POLKU, viimeinen, SIIRTYMA_ERA as i64],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                )?;
                rivit.collect::<rusqlite::Result<_>>()?
            };
            let Some((viimeinen_id, _)) = era.last() else {
                tx.commit()?;
                break;
            };
            let viimeinen_id = viimeinen_id.clone();
            for (id, aika) in &era {
                let hlc_ms = Hlc::parse(aika).map_or(0, |h| h.ms);
                let sisaltoaika = {
                    let sisalto: Option<Vec<u8>> = tx.query_row(
                        "SELECT sisalto FROM yksikot WHERE polku = ?1 AND id = ?2",
                        params![crate::peili::POLKU, id],
                        |r| r.get(0),
                    )?;
                    sisalto
                        .as_deref()
                        .map_or(hlc_ms, |s| crate::peili::sisaltoaika(s, hlc_ms))
                };
                tx.execute(
                    "UPDATE yksikot SET sisaltoaika = ?3 WHERE polku = ?1 AND id = ?2",
                    params![crate::peili::POLKU, id, sisaltoaika as i64],
                )?;
            }
            yksikoita += era.len();
            viimeinen = viimeinen_id;
            tx.commit()?;
        }

        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "DELETE FROM yksikot WHERE polku = ?1 AND id = ?2",
            params![crate::peili::KARSINTA_POLKU, crate::peili::KARSINTA_ID],
        )?;
        tx.execute(
            "UPDATE meta SET arvo = ?1 WHERE avain = 'skeemaversio'",
            params![SKEEMAVERSIO],
        )?;
        tx.commit()?;
        eprintln!(
            "varasto: siirtymä skeema 1 → 2: {yksikoita} peili-yksikköä täytetty, {} ms",
            alku.elapsed().as_millis()
        );
        Ok(())
    }

    fn yhteys(&self) -> MutexGuard<'_, Connection> {
        self.yhteys.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Yhdistää `y`:n nykyiseen yksikköön. Muutos kirjoittaa rivin ja muutoslokin ja palauttaa `seq`:n;
    /// ei muutosta palauttaa `None`. Rinnakkaiset: nykyinen jää paikalleen ja saapuva talletetaan
    /// tunnuksella `<id>~<laite>` (laite = saapuvan HLC:n laite).
    pub fn kirjoita(&self, y: &Yksikko, yh: Yhdistaja) -> Result<Option<u64>> {
        self.kirjoita_sisaltoajalla(y, yh, None)
    }

    /// Kuten `kirjoita`, mutta peili-yksikön sisältöaika (T-73) annetaan: ikkunoitu solmu riisuu sisällön
    /// ennen tallennusta, joten sisältöaika lasketaan riisumattomista riveistä (`peili::ikkunoi`). `None` =
    /// lasketaan tallennettavasta sisällöstä. Annettu arvo kelpaa vain, jos tallennettava sisältö on `y`:n.
    pub fn kirjoita_sisaltoajalla(
        &self,
        y: &Yksikko,
        yh: Yhdistaja,
        sisaltoaika: Option<u64>,
    ) -> Result<Option<u64>> {
        let sa = |r: &Yksikko| {
            if r.sisalto == y.sisalto {
                sisaltoaika
            } else {
                None
            }
        };
        let mut c = self.yhteys();
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let nykyinen = hae(&tx, &y.polku, &y.id)?;
        let seq = match crate::yksikko::yhdista(nykyinen.as_ref(), y, yh) {
            Tulos::Yksi(r) => {
                if nykyinen.as_ref() == Some(&r) {
                    None
                } else {
                    Some(talleta(&tx, &r, sa(&r))?)
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
                    _ => Some(talleta(&tx, &sisar, sa(&sisar))?),
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

    /// Kuten `listaa_otsakkeet`, mutta mukana sarake `sisaltoaika` (T-73; NULL = ei tiedossa).
    pub fn listaa_otsakkeet_sisaltoajalla(
        &self,
        polku: &str,
    ) -> Result<Vec<(Yksikko, Option<u64>)>> {
        let c = self.yhteys();
        let mut kysely = c.prepare(
            "SELECT polku, id, versio, aika, NULL, poistettu, sisaltoaika FROM yksikot \
             WHERE polku = ?1 ORDER BY id",
        )?;
        let rivit = kysely.query_map(params![polku], |r| {
            Ok((
                yksikko_rivilta(r)?,
                r.get::<_, Option<i64>>(6)?.map(|n| n.max(0) as u64),
            ))
        })?;
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

    /// Kuten `listaa_vali`, mutta vain otsakkeet (`sisalto` = None): välin sisältöjä ei lueta muistiin.
    pub fn listaa_vali_otsakkeet(
        &self,
        polku: &str,
        alku: &str,
        loppu: &str,
    ) -> Result<Vec<Yksikko>> {
        let c = self.yhteys();
        let mut kysely = c.prepare(
            "SELECT polku, id, versio, aika, NULL, poistettu FROM yksikot WHERE polku = ?1 AND id >= ?2 AND id < ?3 ORDER BY id",
        )?;
        let rivit = kysely.query_map(params![polku, alku, loppu], yksikko_rivilta)?;
        rivit.collect()
    }

    /// Polun elävien (ei hautakivien) yksiköiden `(id, sisältöaika ms, sisalto-tavut)`; sisältöjä ei lueta
    /// muistiin (SQL `length(sisalto)`). Sisältöaika on sarake `sisaltoaika` tai, jos se puuttuu, HLC-aika
    /// (`None` = ei kumpaakaan). Karsinnan (S-9c) ja `GET /api/peili/koko`:n summat.
    pub fn sisalto_koot(&self, polku: &str) -> Result<Vec<(String, Option<u64>, u64)>> {
        let c = self.yhteys();
        let mut kysely = c.prepare(
            "SELECT id, aika, sisaltoaika, COALESCE(length(sisalto), 0) FROM yksikot \
             WHERE polku = ?1 AND poistettu = 0",
        )?;
        let rivit = kysely.query_map(params![polku], |r| {
            let aika: String = r.get(1)?;
            let sisaltoaika = r
                .get::<_, Option<i64>>(2)?
                .map(|n| n.max(0) as u64)
                .or_else(|| Hlc::parse(&aika).map(|h| h.ms));
            Ok((
                r.get::<_, String>(0)?,
                sisaltoaika,
                r.get::<_, i64>(3)?.max(0) as u64,
            ))
        })?;
        rivit.collect()
    }

    /// S-9c: poistaa rivin fyysisesti (ei hautakiveä, ei muutoslokiriviä). Palauttaa oliko rivi olemassa.
    pub fn poista_paikallisesti(&self, polku: &str, id: &str) -> Result<bool> {
        let c = self.yhteys();
        let n = c.execute(
            "DELETE FROM yksikot WHERE polku = ?1 AND id = ?2",
            params![polku, id],
        )?;
        Ok(n > 0)
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
