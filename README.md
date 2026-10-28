# Scopes V2 (scopes_v2)

Claude Code -skooppien rekisterit, istuntojen peilit ja etäohjaus iOS- ja macOS-äppinä, jotka upottavat oman
Rust-solmun. Solmu (`ydin/`) tallentaa rekisterit ja viestit paikallisesti ja replikoi ne toisten solmujen kanssa;
äpit (`ios/`, `macos/`) käyttävät sitä SwiftPM-pakettien `shared/ScopesCore2` ja `shared/ScopesUI2` kautta, ja
`web/` on sama asiakas selaimeen. Tämä repo on jaettu kehitysrepo ilman kehitysaineistoa ja palvelinkohtaisia
skriptejä.

## Sisältö

- `ydin/` – Rust-crate `scopes-ydin`: HTTP-solmu `scopes-solmu` (portti 8797) ja staattinen kirjasto, joka
  paketoidaan `apple/ScopesSolmu.xcframework`iksi (`apple/rakenna-xcframework.sh`, C-otsake `include/`).
- `shared/ScopesCore2/` – solmun Swift-rajapinta, mallit ja tilasynkka; `binaryTarget` osoittaa
  `../../ydin/apple/ScopesSolmu.xcframework`iin. `shared/ScopesUI2/` – yhteiset SwiftUI-näkymät.
- `ios/`, `macos/` – xcodegen-projektit (`project.yml`), lähteet ja UI-testit. `shared/testit/` – kahden laitteen
  UI-testit ja etäohjauksen mock-adapteri.
- `web/` – TypeScript-PWA ilman kehystä (`node build.mjs` → `dist/`), jonka solmu tarjoilee `--web`-lipulla.

## Rakentaminen (Mac, Xcode 26, Rust stable)

1. `rustup target add aarch64-apple-ios aarch64-apple-ios-sim aarch64-apple-darwin`
2. `cd ydin && bash apple/rakenna-xcframework.sh` – kääntää kirjaston kolmelle kohteelle ja luo xcframeworkin
   (tarvitsee Xcoden clangin; `DEVELOPER_DIR` asetetaan skriptissä).
3. `cd ios && xcodegen` (vastaavasti `macos/`) – generoi `ScopesV2.xcodeproj`:n `project.yml`:stä. Vaihda
   `project.yml`:n `DEVELOPMENT_TEAM: YOUR_TEAM_ID` omaan Apple-tiimiisi; bundle-etuliite on `com.example`.
4. Avaa projekti Xcodessa tai aja
   `xcodebuild -project ScopesV2.xcodeproj -scheme ScopesV2 -destination "platform=iOS Simulator,id=<simctl list devices -tulosteen UDID>" CODE_SIGNING_ALLOWED=NO build-for-testing`.

Äppi käynnistää solmun itse; vertaissolmun osoite on oletuksena `http://127.0.0.1:18797` ja sen voi antaa
ympäristömuuttujalla `SCOPES2_VERTAINEN` tai UserDefaults-avaimella `scopes2.vertainen`
(`shared/ScopesCore2/Sources/ScopesCore2/Solmu.swift`).

## Solmu ja web-asiakas erikseen

    cd ydin && cargo test && cargo run --release --bin scopes-solmu -- --help
    cd web && npm ci && node build.mjs && node --test test/*.test.ts

Linuxilla `reqwest`in TLS tarvitsee OpenSSL-kehitysotsakkeet (ks. `ydin/README.md`). Solmu lukee Bearer-avaimen
tiedostosta, jonka polku annetaan käynnistyksessä (`ydin/src/main.rs`).

Huomaa: solmun tietolähteet (Claude Code -transkriptit, tmux, adb) tuottaa erillinen adapteri, joka ei ole tässä
repossa; ilman sitä solmu ja äpit näyttävät vain testidatan tai tyhjän tilan. Yksikkö- ja UI-testit ajavat
fixtureilla (`ydin/tests/fixture/`).

## Lisenssi

MIT, ks. `LICENSE`.
