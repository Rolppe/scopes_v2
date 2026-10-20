# scopes2/shared - Apple-runko ja portti (T-45-G, ARK-08)

## Rakenne

```
scopes2/shared/ScopesCore2   Swift-paketti (tools 5.9, iOS 18.0, macOS 14): public enum ScopesCore2 { versio = "0.1.0" }
scopes2/shared/ScopesUI2     Swift-paketti, riippuu ../ScopesCore2: JuuriNakyma (Text "scopes-V2")
scopes2/shared/gate.sh       yhteinen portti (P-15)
scopes2/ios/                 xcodegen-projekti ScopesV2, bundle com.example.scopes-v2 (+ .uitests)
scopes2/macos/               xcodegen-projekti ScopesV2Mac, bundle com.example.scopes-v2.mac (+ .uitests)
```

CFBundleDisplayName "scopes-V2"; ei widgetiä, app groupia eikä URL-skeemaa; DEVELOPMENT_TEAM YOUR_TEAM_ID ja
CODE_SIGN_STYLE Automatic projektitiedostoissa (laitekäännös, H-17). Projektit viittaavat paketteihin polulla
`../shared/ScopesCore2` ja `../shared/ScopesUI2`; koko scopes2-puu on Macilla samassa rakenteessa (`~/scopes2-rakennus`).
Paketit käyttävät `.iOS("18.0")`, koska `.iOS(.v18)` vaatii swift-tools 6.0:n (5.9-manifesti ei käänny).
`*.xcodeproj` ja `Info.plist` generoi `xcodegen` Macilla, eikä niitä versioida.

## Portin käyttö

```
bash scopes2/shared/gate.sh --itsetesti   # ei tarvitse Macia
bash scopes2/shared/gate.sh T-45          # runko: paketit, xcodegen, macOS ja iOS build + UI-testi → "APPLE-RUNKO: ok"
```

Tapaukset: T-45 runko; T-46 XCFramework (`ydin/apple/rakenna-xcframework.sh`); T-47 + ScopesCore2-testit avaimella;
T-48 + ScopesUI2 ja äppien build; T-49 + UI-testit. Koeydin, tunneli ja avain (P-14): T-47, T-49 ja T-52 käynnistävät palvelimelle koeytimen (koeportti oletus 18798, ei 8787/8797/18795/18796/18797, varattu → seuraava vapaa; oma tilapäinen `--data`, ajon aikana luotu kertakäyttöavain, RLIMIT_DATA, `--vanha http://127.0.0.1:8787` palvelimen vanhalla avaimella), avaavat Macilla tilapäisen tunnelin `-L <Mac-portti>:127.0.0.1:<koeportti>` (Mac-portti = ajon porttipaikka 18900–18919, testeille `SCOPES2_VERTAINEN`/`TEST_RUNNER_SCOPES2_VERTAINEN`) ja antavat koeytimen kertakäyttöavaimen stdinin kautta ympäristöön `SCOPES2_AVAIN` (ei komentorivillä, ei lokissa). Trap sammuttaa koeytimen ja tunnelin ja poistaa datan. Tuotannon V2-avain ja 8797 eivät ole mukana. Rinnakkaiset ajot (V-605): jokainen ajo pitää Macilla oman lukkonsa `~/scopes2-rakennus-<ajo>/.lukko` ja porttipaikan `~/scopes2-lukot/portti-<p>.lukko` koko ajon (yli 30 min odotus → `MAC-LUKKO: varattu` exit 1); jaetut vaiheet ovat omien lukkojensa takana: XCFramework `~/scopes2-rakennus/.lukko` (sama kuin ytimen gate.sh:n cargo), macOS-UI-testit ja kaksi laitetta `~/scopes2-lukot/naytto.lukko`, iOS-testit `~/scopes2-lukot/sim-<nimi>.lukko` (ensimmäinen vapaa `GATE_SIMIT`-listasta). Odotus enintään `GATE_LUKKO_ODOTUS` (oletus 2700 s). `<ajo>` = `GATE_AJO` tai ID. Ei launchd-agenttia eikä Keychainia (H-14, H-15 aamulla H-17:n yhteydessä). `gate.sh --tunnelitesti` (tarvitsee Macin) todistaa koeytimen, tunnelin ja lukon synnyn ja sulkeutumisen;
T-52 + `shared/testit/kaksi-laitetta.sh`. Exit 0 vihreä, 1 tuntematon ID/testi punainen, 2 aita.

- Palvelin ajaa aidat (lähtötila ajon alussa; `scopes/`-muutos → "VANHA PUU MUUTTUNUT"; `GATE_MAY`, oletus
  `scopes2/shared/ scopes2/ios/ scopes2/macos/`, ulkopuolinen → exit 2). Huom: aita huomaa myös muiden keskustelujen
  samaan aikaan tekemät muutokset koko puussa; punainen exit 2 muualta tulleesta rivistä vaatii uusinta-ajon.
- Sama ajo kerrallaan: `flock /tmp/scopes2-apple-mac-<ajo>.lock` (odotus 15 min); eri ajot rinnakkain (V-605). Koeportin valinta ja koeytimen käynnistys `flock /tmp/scopes2-koeportti.lock`:n alla.
- Siirto: tar ssh:n yli Macin ajokohtaiseen `~/scopes2-rakennus-<ajo>`-hakemistoon (`ydin` mukana kaikissa tapauksissa; uusi hakemisto saa `ydin/target`in APFS-kloonina `~/scopes2-rakennus/ydin`:stä cargo-lukon alla). **Poikkeama T-45-G:stä (19.10.2026, koordinaattorin päätös):** T-45 siirtää ydinlähteet ja ajaa XCFramework-vaiheen (rakennetaan, jos puuttuu tai ydin/src on uudempi), koska ScopesUI2 → ScopesCore2 linkittää XCFrameworkin eikä T-45 muuten rakennu tuoreella Macilla.
  Ennen purkua poistetaan Macilta `shared/ScopesCore2`, `shared/ScopesUI2`, `ios|macos/Sources` ja `UITests`;
  `ydin/target` säilyy. Darwinilla portti ajaa suoraan ilman ssh:ta ja siirtoa.
- Mac-ympäristö: `PATH=$HOME/.cargo/bin:/opt/homebrew/bin:$PATH`, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`.
- Simulaattori: `SCOPES2_SIM` (oletus "iPhone 15 Pro", build-kohde) ja `GATE_SIMIT` (testien vaihtoehdot, oletus `$SCOPES2_SIM|iPhone 17 Pro|iPhone 17`). Jokaisella ssh-komennolla aikaraja `GATE_MAC_TIMEOUT` + `GATE_LUKKO_ODOTUS` (oletus 1800 + 2700 s).
- Avain testeille (T-47 alkaen): palvelimen `~/.config/scopes2/avain` annetaan Macille stdinissä
  (`TEST_RUNNER_SCOPES2_AVAIN=$(cat)`), ei komentorivillä eikä lokissa.

## Allekirjoitus (P-16)

- macOS: `CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=` (ad hoc, ei tiimiä).
- iOS-simulaattori: `CODE_SIGNING_ALLOWED=NO`.
- Laitekäännös (H-17) käyttää projektin Automatic-allekirjoitusta tiimillä YOUR_TEAM_ID.

## Tunnetut ehdot Macilla

- macOS-UI-testi vaatii Macilla Developer-tilan (`DevToolsSecurity -enable`, sudo, ihmisen toimi). Ilman sitä
  testi kaatuu virheeseen "Timed out while enabling automation mode" (19.10.2026: `DevToolsSecurity -status` = disabled).
  iOS-simulaattorin UI-testi menee läpi ilman sitä.

## LuLu-havainto (P-14, H-7 käyttäjälle)

19.10.2026 (T-45 vihreä, Developer mode päällä): macOS UI-testin aikaiset LuLu-lokirivit olivat vain AppKit/FrontBoard-tilarivejä (status item, TouchBar), ei hälytys- tai kehoteriviä; kehotteen ilmestymistä ei voi lokista varmasti sulkea pois, joten H-7 jää käyttäjälle. Portti tulostaa havainnon (`LULU: ...`) macOS-UI-testin jälkeen; se käyttää `/usr/bin/log`ia, koska zsh:n `log` on sisäänrakennettu komento.
