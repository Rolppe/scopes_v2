# scopes-ydin (scopes2)

Rust-crate `scopes-ydin`, binääri `scopes-solmu`. Portti oletuksena 8797, reitti `GET /api/terveys` -> `{"ok":true,"v2":true,"seq":0}`.

## Käännös ja portti

- Käännös: `cargo build --release` crate-hakemistossa. `.cargo/config.toml` rajaa rinnakkaiset työt (`jobs = 2`) pienen muistin koneita varten.
- Testit: `cargo test`.
- openssl-sys (reqwest:in oletus-TLS) löytää OpenSSL:n `pkg-config`illa. Jos sitä ei ole, aseta `OPENSSL_LIB_DIR` ja `OPENSSL_INCLUDE_DIR` koneen OpenSSL-polkuihin.

## Ensimmäisen käännöksen mittaus (cargo build, jobs=2, kylmä target)

- Maximum resident set size: noin 411 MiB
- Kesto: 69 s
