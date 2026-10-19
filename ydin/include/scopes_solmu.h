/* scopes_solmu.h - scopes2-ytimen C-rajapinta (S-8a). Yksi solmu per prosessi. */
#ifndef SCOPES_SOLMU_H
#define SCOPES_SOLMU_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Kaynnistaa solmun ja palaa, kun portti kuuntelee.
 * asetukset_json: {"data":"<hakemisto>","avain":"<Bearer>","portti":0,
 *                  "vertaiset":["http://127.0.0.1:8797"],"vanha":"http://127.0.0.1:8797"|null,
 *                  "vanha_avain":"<Bearer>"|null,"headless":false,"laite":"<laite-id>"}
 * ulos: puskuri, johon kirjoitetaan NUL-paatteinen JSON; ulos_koko on sen koko tavuina.
 * Palauttaa kuunnellun portin (>= 1); ulos = {"portti":<n>,"versio":"<crate-versio>"}.
 * Virheessa < 0: -1 JSON, -2 data-hakemisto, -3 portti, -4 jo kaynnissa, -5 ulos liian pieni,
 * -99 panic; ulos = {"virhe":"<teksti>"} jos mahtuu.
 */
int32_t scopes_solmu_kaynnista(const char *asetukset_json, char *ulos, size_t ulos_koko);

/* Pysayttaa solmun (enintaan 5 s). Palauttaa 0, tai 1 jos solmu ei ole kaynnissa. */
int32_t scopes_solmu_pysayta(void);

#ifdef __cplusplus
}
#endif

#endif /* SCOPES_SOLMU_H */
