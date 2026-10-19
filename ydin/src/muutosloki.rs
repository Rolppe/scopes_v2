//! Muutosloki ja vertaiskursorit (SUUNNITELMA.md §3.3, S-3): `seq` kasvaa solmukohtaisesti.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub type Result<T> = rusqlite::Result<T>;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Tapahtuma {
    pub seq: u64,
    pub polku: String,
    pub id: String,
    pub versio: BTreeMap<String, u64>,
    pub aika: String,
}

pub(crate) fn versio_tekstina(v: &BTreeMap<String, u64>) -> Result<String> {
    serde_json::to_string(v).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))
}

pub(crate) fn versio_tekstista(indeksi: usize, s: &str) -> Result<BTreeMap<String, u64>> {
    serde_json::from_str(s).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(indeksi, rusqlite::types::Type::Text, Box::new(e))
    })
}

/// Lisää muutoslokiin rivin ja palauttaa sen `seq`-arvon.
pub(crate) fn kirjaa(
    c: &Connection,
    polku: &str,
    id: &str,
    versio: &BTreeMap<String, u64>,
    aika: &str,
) -> Result<u64> {
    c.execute(
        "INSERT INTO muutosloki (polku, id, versio, aika) VALUES (?1, ?2, ?3, ?4)",
        params![polku, id, versio_tekstina(versio)?, aika],
    )?;
    Ok(c.last_insert_rowid() as u64)
}

/// Tapahtumat, joiden `seq` > `since`, nousevassa järjestyksessä, enintään `raja` kappaletta.
pub(crate) fn loki(c: &Connection, since: u64, raja: usize) -> Result<Vec<Tapahtuma>> {
    let mut kysely = c.prepare(
        "SELECT seq, polku, id, versio, aika FROM muutosloki WHERE seq > ?1 ORDER BY seq LIMIT ?2",
    )?;
    let rivit = kysely.query_map(params![since as i64, raja as i64], |r| {
        let versio: String = r.get(3)?;
        Ok(Tapahtuma {
            seq: r.get::<_, i64>(0)? as u64,
            polku: r.get(1)?,
            id: r.get(2)?,
            versio: versio_tekstista(3, &versio)?,
            aika: r.get(4)?,
        })
    })?;
    rivit.collect()
}

/// Suurin `seq`; 0, jos lokissa ei ole rivejä.
pub(crate) fn seq(c: &Connection) -> Result<u64> {
    let n: i64 = c.query_row("SELECT COALESCE(MAX(seq), 0) FROM muutosloki", [], |r| {
        r.get(0)
    })?;
    Ok(n as u64)
}

/// Vertaisen kursori; 0, jos vertaista ei ole kirjattu.
pub(crate) fn kursori(c: &Connection, vertainen: &str) -> Result<u64> {
    let n: Option<i64> = c
        .query_row(
            "SELECT seq FROM kursorit WHERE vertainen = ?1",
            params![vertainen],
            |r| r.get(0),
        )
        .optional()?;
    Ok(n.unwrap_or(0) as u64)
}

pub(crate) fn aseta_kursori(c: &Connection, vertainen: &str, seq: u64) -> Result<()> {
    c.execute(
        "INSERT INTO kursorit (vertainen, seq) VALUES (?1, ?2) \
         ON CONFLICT(vertainen) DO UPDATE SET seq = excluded.seq",
        params![vertainen, seq as i64],
    )?;
    Ok(())
}
