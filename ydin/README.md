# scopes-ydin (scopes2)

Rust-crate `scopes-ydin`, binääri `scopes-solmu`. Portti oletuksena 8797, reitti `GET /api/terveys` -> `{"ok":true,"v2":true,"seq":0}`.

## Käännös ja portti

- Käännös: `cargo build --release` crate-hakemistossa. `.cargo/config.toml` rajaa rinnakkaiset työt (`jobs = 2`) pienen muistin koneita varten.
- Testit: `cargo test`.
- Rust 1.88 tai uudempi: `Cargo.lock`in riippuvuudet vaativat sen (rustc 1.85 hylkää käännöksen).
- OpenSSL:ää ei tarvita: `reqwest` on käännetty ilman TLS-ominaisuutta (`default-features = false`, ks. `Cargo.toml`), eikä `Cargo.lock` sisällä `openssl`-, `native-tls`- eikä `system-configuration`-paketteja. Vertaisyhteydet ovat siis tavallista `http://`-liikennettä Bearer-avaimella; pidä ne loopbackissa tai yksityisessä tunnelissa.

## Ensimmäisen käännöksen mittaus (cargo build, jobs=2, kylmä target)

Mitattu 19.10.2026 ennen TLS-riippuvuuksien poistoa (loki: `kaannos-mittaus.txt` sisältää vielä `openssl-sys`in).

- Maximum resident set size: noin 411 MiB
- Kesto: 69 s
