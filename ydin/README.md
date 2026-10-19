# scopes-ydin (scopes2)

Rust-crate `scopes-ydin`, binääri `scopes-solmu`. Portti oletuksena 8797, reitti `GET /api/terveys` -> `{"ok":true,"v2":true,"seq":0}`.

## Käännös ja portti

- Käännös aina: `flock /tmp/scopes2-cargo.lock cargo ...` (yksi käännös kerrallaan). `.cargo/config.toml`: `jobs = 2`.
- Verkko estetty: `CARGO_NET_OFFLINE=true`. Riippuvuudet ovat välimuistissa `~/.cargo/registry`.
- `bash scopes2/ydin/gate.sh <T-ID>` ajaa fmt, clippy, testit ja aidat; `--pohja` kirjoittaa lähtötilan; `--itsetesti` testaa aidat.
- openssl-sys (reqwest:in oletus-TLS) tarvitsee `OPENSSL_LIB_DIR=/usr/lib/aarch64-linux-gnu` ja `OPENSSL_INCLUDE_DIR=/usr/include`, koska `pkg-config` puuttuu koneelta; gate.sh asettaa ne, jos ne ovat asettamatta. Käsin ajettaessa aseta samat.

## Ensimmäisen käännöksen mittaus (cargo build, jobs=2, kylmä target)

- Maximum resident set size: 420740 kB (noin 411 MiB)
- Kesto: 69 s
- Raaka rivi: `kaannos-mittaus.txt`
