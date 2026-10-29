# shared — Apple-asiakkaiden yhteiset paketit

## Rakenne

```
shared/ScopesCore2   Swift-paketti (tools 5.9, iOS 18.0, macOS 14): mallit, API-asiakas ja ytimen XCFramework-sidonta
shared/ScopesUI2     Swift-paketti, riippuu ../ScopesCore2: yhteiset SwiftUI-näkymät
shared/testit        kahden laitteen UI-testi ja testien mock-ohjaus (mock-ohjaus.mjs)
ios/                 xcodegen-projekti ScopesV2, bundle com.example.scopes-v2 (+ .uitests)
macos/               xcodegen-projekti ScopesV2Mac, bundle com.example.scopes-v2.mac (+ .uitests)
```

CFBundleDisplayName "scopes-V2"; ei widgetiä, app groupia eikä URL-skeemaa. Projektitiedostoissa `DEVELOPMENT_TEAM` on
`YOUR_TEAM_ID` ja `CODE_SIGN_STYLE` Automatic: vaihda oma tiimisi laitekäännöstä varten. Projektit viittaavat paketteihin polulla
`../shared/ScopesCore2` ja `../shared/ScopesUI2`. Paketit käyttävät `.iOS("18.0")`, koska `.iOS(.v18)` vaatii swift-tools 6.0:n
(5.9-manifesti ei käänny). `*.xcodeproj` ja `Info.plist` generoi `xcodegen`, eikä niitä versioida.

## Käännös Macilla

1. Rakenna ytimen XCFramework: `cd ydin && bash apple/rakenna-xcframework.sh` (ScopesCore2 linkittää sen, `shared/ScopesCore2/Package.swift`).
2. Generoi projektit: `cd ios && xcodegen` ja `cd macos && xcodegen`.
3. Käännä ja testaa Xcodella tai `xcodebuild`illa. Pakettitestit: `cd shared/ScopesCore2 && swift test`.

Ympäristö: `PATH=$HOME/.cargo/bin:$PATH` (Rust-työkaluketju iOS- ja macOS-kohteineen) ja `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`.

## Allekirjoitus

- macOS ilman tiimiä: `CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=` (ad hoc).
- iOS-simulaattori: `CODE_SIGNING_ALLOWED=NO`.
- Laitekäännös käyttää projektin Automatic-allekirjoitusta omalla tiimilläsi.

## Tunnetut ehdot

- macOS-UI-testi vaatii Developer-tilan (`sudo DevToolsSecurity -enable`). Ilman sitä testi kaatuu virheeseen
  "Timed out while enabling automation mode". iOS-simulaattorin UI-testi menee läpi ilman sitä.
- Käynnissä olevaa ydintä tarvitsevat UI-testit lukevat sen osoitteen ympäristömuuttujasta `SCOPES2_VERTAINEN`
  (oletus `http://127.0.0.1:18797`) ja avaimen muuttujasta `TEST_RUNNER_SCOPES2_AVAIN`. Avainta ei kirjoiteta koodiin eikä lokiin.
