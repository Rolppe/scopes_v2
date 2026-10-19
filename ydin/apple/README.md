# ScopesSolmu.xcframework

Ydin Apple-äpin sisällä (S-8a): C-rajapinta `include/scopes_solmu.h` (`scopes_solmu_kaynnista`, `scopes_solmu_pysayta`)
ja `127.0.0.1`-API äpin omassa prosessissa.

## Rakennus

Macilla, ytimen juuressa (`~/scopes2-rakennus/ydin`):

    bash apple/rakenna-xcframework.sh

Skripti rakentaa `libscopes_ydin.a`:n kohteille `aarch64-apple-ios`, `aarch64-apple-ios-sim` ja `aarch64-apple-darwin`
(`IPHONEOS_DEPLOYMENT_TARGET=18.0`, `MACOSX_DEPLOYMENT_TARGET=14.0`) ja kokoaa ne `apple/ScopesSolmu.xcframework`:ksi
otsakkeineen (`include/scopes_solmu.h`, `module.modulemap`). Tuloste päättyy riviin `XCFRAMEWORK: <polku> <koko Mt>`.
Jokin kohde kaatuu: exit 1 ja kohteen virhe. `rusqlite` (bundled) tarvitsee Xcoden clangin (`DEVELOPER_DIR`).
Rust-kohteet pitää olla asennettuna (`rustup target add ...`); skripti ei asenna mitään.
Tuotos on gitignoressa (`/apple/*.xcframework`, `/apple/build`).

## Linkitys äpissä

Äpin linkitysvaiheeseen:

- `Security.framework`
- `SystemConfiguration.framework`
- `libresolv` (`-lresolv`)

(`reqwest` native-tls ja system-configuration.) Moduuli: `import ScopesSolmu`.

## Käyttö

`scopes_solmu_kaynnista(asetukset_json, ulos, ulos_koko)` palauttaa kuunnellun portin ja kirjoittaa
`{"portti":<n>,"versio":"<crate-versio>"}`; virheet -1 JSON, -2 data-hakemisto, -3 portti, -4 jo käynnissä,
-5 ulos liian pieni, -99 panic. Yksi solmu per prosessi. `scopes_solmu_pysayta()` palauttaa 0 (tai 1, jos ei käynnissä).
