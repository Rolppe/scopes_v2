// T-87: ARK-19:n koneellinen hyväksyntä simulaattorissa: Android-etäohjaus ja palvelimen paneeli Infra-välilehdellä.
// Koeydin on käynnistetty `--adapteri`-lipulla mockiin (scopes2/shared/testit/mock-ohjaus.mjs, gate.sh t87), joka vastaa fixtureista ja kirjaa
// saamansa toiminnot; testi lukee kirjan koeytimen kautta (GET /api/android/koe-loki). Ei oikeaa Androidia, palvelinta eikä 8787:ää.
// Avain: TEST_RUNNER_SCOPES2_AVAIN → testiajurin SCOPES2_AVAIN; ei koodissa eikä lokissa.
// pohja: scopes2/ios/UITests/RunkoUITests.swift (käynnistys, avain, osoite); macOS-pari: scopes2/macos/UITests/OhjausUITests.swift
import XCTest

@MainActor
final class OhjausUITests: XCTestCase {
    private let osoite = ProcessInfo.processInfo.environment["SCOPES2_VERTAINEN"] ?? "http://127.0.0.1:18797"

    private func avain() throws -> String {
        try XCTUnwrap(ProcessInfo.processInfo.environment["SCOPES2_AVAIN"], "SCOPES2_AVAIN puuttuu")
    }

    override func setUp() async throws {
        continueAfterFailure = false
        // Vain gate.sh t87:n koeytimellä (mock-adapteri); T-49:n koeytimessä ei ole mock-reittejä (koe-nollaa → 404).
        guard ProcessInfo.processInfo.environment["SCOPES2_OHJAUS"] == "mock" else {
            throw XCTSkip("T-87: vain mock-ohjauksella (TEST_RUNNER_SCOPES2_OHJAUS=mock, gate.sh t87)")
        }
        _ = try await mock("/api/android/koe-nollaa", metodi: "POST")   // tyhjä loki ja palvelin takaisin tilaan "linux"
    }

    // MARK: mockin loki (koeytimen kautta)

    private func mock(_ polku: String, metodi: String = "GET") async throws -> [String: Any] {
        var req = URLRequest(url: URL(string: osoite + polku)!, timeoutInterval: 30)
        req.httpMethod = metodi
        req.setValue("Bearer " + (try avain()), forHTTPHeaderField: "Authorization")
        if metodi == "POST" {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = Data("{}".utf8)
        }
        let (data, vastaus) = try await URLSession.shared.data(for: req)
        let koodi = (vastaus as? HTTPURLResponse)?.statusCode ?? 0
        XCTAssertEqual(koodi, 200, "\(polku): HTTP \(koodi) \(String(decoding: data.prefix(200), as: UTF8.self))")
        return (try JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    private struct Kirjaus { let metodi: String; let polku: String; let runko: Any? }

    private func loki() async throws -> (pyynnot: [Kirjaus], ruutuHaut: Int) {
        let o = try await mock("/api/android/koe-loki")
        let rivit = (o["pyynnot"] as? [[String: Any]]) ?? []
        let pyynnot = rivit.map { Kirjaus(metodi: $0["metodi"] as? String ?? "", polku: $0["polku"] as? String ?? "", runko: $0["runko"]) }
        return (pyynnot, o["ruutuHaut"] as? Int ?? 0)
    }

    /// Odottaa, että lokissa on POST annettuun polkuun (vähintään `maara` kappaletta); palauttaa ne.
    private func odotaPost(_ polku: String, maara: Int = 1, sekuntia: Double = 20) async throws -> [Kirjaus] {
        let loppu = Date().addingTimeInterval(sekuntia)
        var osumat: [Kirjaus] = []
        repeat {
            osumat = try await loki().pyynnot.filter { $0.metodi == "POST" && $0.polku.hasPrefix(polku) }
            if osumat.count >= maara { return osumat }
            try await Task.sleep(nanoseconds: 300_000_000)
        } while Date() < loppu
        return osumat
    }

    // MARK: äppi

    private func kaynnista() throws -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["SCOPES2_AVAIN"] = try avain()
        app.launchEnvironment["SCOPES2_VERTAINEN"] = osoite
        app.launchEnvironment["SCOPES2_KUITTAUS"] = "pois"
        app.launchEnvironment["SCOPES2_DATA"] = NSTemporaryDirectory() + "scopes2-ui-" + UUID().uuidString
        app.launch()
        return app
    }

    private func elementti(_ app: XCUIApplication, _ tunnus: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: tunnus).firstMatch
    }

    private func teksti(_ e: XCUIElement) -> String {
        e.label.isEmpty ? ((e.value as? String) ?? "") : e.label
    }

    /// Avaa Infra-välilehden. Kapealla näytöllä (iPhone) NavigationSplitView näyttää ensin sivupalkin: mock vastaa vanhan 8787:n
    /// skooppilistaan yhdellä skoopilla ("t87"), jonka valinta avaa detailin ja välilehtirivin.
    private func avaaInfra(_ app: XCUIApplication) {
        let valilehti = app.tabBars.buttons["Infra"]
        if !valilehti.waitForExistence(timeout: 20) {
            let rivi = elementti(app, "skooppi-t87")
            XCTAssertTrue(rivi.waitForExistence(timeout: 60), "skooppilistalla ei ole mockin skooppia t87")
            rivi.tap()
        }
        XCTAssertTrue(valilehti.waitForExistence(timeout: 30), "Infra-välilehti puuttuu")
        valilehti.tap()
        XCTAssertTrue(elementti(app, "linux-tila").waitForExistence(timeout: 30), "palvelimen osio ei näy Infra-välilehdellä")
    }

    private func vahvistusnappi(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'linux-vahvista' OR label == 'Sammuta palvelin'")).firstMatch
    }

    private func peruutusnappi(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'linux-peruuta' OR label == 'Peruuta'")).firstMatch
    }

    private func odotaPoissa(_ e: XCUIElement, sekuntia: Double = 10) -> Bool {
        let loppu = Date().addingTimeInterval(sekuntia)
        repeat {
            if !e.exists { return true }
            Thread.sleep(forTimeInterval: 0.3)
        } while Date() < loppu
        return !e.exists
    }

    /// Odottaa, että elementin value alkaa annetulla (ruudun accessibilityValue on "kuva LxK" kun kuva on latautunut).
    private func odotaArvo(_ e: XCUIElement, alkaa osa: String, sekuntia: Double = 30) -> Bool {
        let loppu = Date().addingTimeInterval(sekuntia)
        repeat {
            if e.exists, ((e.value as? String) ?? "").hasPrefix(osa) { return true }
            Thread.sleep(forTimeInterval: 0.3)
        } while Date() < loppu
        return e.exists && ((e.value as? String) ?? "").hasPrefix(osa)
    }

    /// Odottaa elementin tekstiä (label tai value sisältää annetun).
    private func odotaTeksti(_ e: XCUIElement, _ osa: String, sekuntia: Double = 20) -> Bool {
        let loppu = Date().addingTimeInterval(sekuntia)
        repeat {
            if e.exists, teksti(e).contains(osa) { return true }
            Thread.sleep(forTimeInterval: 0.3)
        } while Date() < loppu
        return e.exists && teksti(e).contains(osa)
    }

    // MARK: palvelin

    func testLinuxServerTilaNakyy() throws {
        let app = try kaynnista()
        avaaInfra(app)
        let tila = elementti(app, "linux-tila")
        XCTAssertTrue(odotaTeksti(tila, "Linux päällä"), "tila: \(teksti(tila))")
        XCTAssertTrue(elementti(app, "linux-sammuta").isEnabled, "sammuta pitää olla käytettävissä, kun Linux on päällä")
        XCTAssertFalse(elementti(app, "linux-kaynnista").isEnabled, "käynnistä ei kuulu näkyä käytettävänä, kun Linux on jo päällä")
    }

    func testSammutusKysyyVahvistuksenEikaPeruutusLahetaMitaan() async throws {
        let app = try kaynnista()
        avaaInfra(app)
        XCTAssertTrue(odotaTeksti(elementti(app, "linux-tila"), "Linux päällä"))
        elementti(app, "linux-sammuta").tap()
        XCTAssertTrue(vahvistusnappi(app).waitForExistence(timeout: 10), "sammutus ei kysynyt vahvistusta")
        let ennenVahvistusta = try await loki().pyynnot.filter { $0.polku.hasPrefix("/api/palvelin") }
        XCTAssertEqual(ennenVahvistusta.count, 0, "sammutus lähti ennen vahvistusta")
        // iOS esittää dialogin popoverina ilman näkyvää cancel-roolin nappia (T-87-ajo 21.10.2026): silloin peruutus = napautus ulkopuolelle.
        let peruuta = peruutusnappi(app)
        if peruuta.waitForExistence(timeout: 3) {
            peruuta.tap()
        } else {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap()
        }
        XCTAssertTrue(odotaPoissa(vahvistusnappi(app)), "vahvistusdialogi ei sulkeutunut peruutuksesta")
        XCTAssertTrue(odotaTeksti(elementti(app, "linux-tila"), "Linux päällä"), "tila muuttui peruutuksesta")
        try await Task.sleep(nanoseconds: 3_000_000_000)   // aika, jonka sisällä väärä lähetys olisi ehtinyt lokiin
        let peruutuksenJalkeen = try await loki().pyynnot.filter { $0.metodi == "POST" && $0.polku.hasPrefix("/api/palvelin") }
        XCTAssertEqual(peruutuksenJalkeen.count, 0, "peruutus lähetti toiminnon")
    }

    func testVahvistusLahettaaSammuta() async throws {
        let app = try kaynnista()
        avaaInfra(app)
        XCTAssertTrue(odotaTeksti(elementti(app, "linux-tila"), "Linux päällä"))
        elementti(app, "linux-sammuta").tap()
        let vahvista = vahvistusnappi(app)
        XCTAssertTrue(vahvista.waitForExistence(timeout: 10), "sammutus ei kysynyt vahvistusta")
        vahvista.tap()
        let osumat = try await odotaPost("/api/palvelin/")
        XCTAssertEqual(osumat.map(\.polku), ["/api/palvelin/sammuta"], "vahvistus lähettää täsmälleen yhden sammuta-kutsun")
        XCTAssertTrue(odotaTeksti(elementti(app, "linux-tila"), "Sammuu"), "tila vastauksesta: \(teksti(elementti(app, "linux-tila")))")
        XCTAssertFalse(elementti(app, "linux-sammuta").isEnabled, "sammutus ei saa olla enää käytettävissä")
    }

    // MARK: Android

    private func avaaAndroid(_ app: XCUIApplication) {
        avaaInfra(app)
        let linkki = elementti(app, "infra-android")
        XCTAssertTrue(linkki.waitForExistence(timeout: 20), "Android-linkki puuttuu Infra-välilehdeltä")
        linkki.tap()
        XCTAssertTrue(elementti(app, "android-ruutu").waitForExistence(timeout: 30), "Android-näkymä ei avautunut")
    }

    func testAndroidTilaJaRuutuNakyvat() throws {
        let app = try kaynnista()
        avaaAndroid(app)
        XCTAssertTrue(odotaTeksti(elementti(app, "android-tila"), "Hereillä"), "tila: \(teksti(elementti(app, "android-tila")))")
        XCTAssertTrue(odotaTeksti(elementti(app, "android-tila"), "1080×2400"))
        XCTAssertTrue(odotaArvo(elementti(app, "android-ruutu"), alkaa: "kuva"),
                      "ruutukuva ei latautunut: \(String(describing: elementti(app, "android-ruutu").value))")
        XCTAssertFalse(elementti(app, "android-virhe").exists, "virhe näkyvissä: \(teksti(elementti(app, "android-virhe")))")
    }

    func testNapautusLahettaaMurtoosat() async throws {
        let app = try kaynnista()
        avaaAndroid(app)
        let ruutu = elementti(app, "android-ruutu")
        XCTAssertTrue(odotaTeksti(elementti(app, "android-tila"), "Hereillä"))
        XCTAssertTrue(odotaArvo(ruutu, alkaa: "kuva"), "ruutukuva ei latautunut")
        // kuva on aspectFit keskellä ja täyttää korkeuden (108×240-kuva leveää aluetta vasten): x 0,5 = kuvan keskikohta, y 0,25 = neljännes
        ruutu.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25)).tap()
        let osumat = try await odotaPost("/api/android/napauta")
        XCTAssertEqual(osumat.count, 1, "napautus lähti \(osumat.count) kertaa")
        let runko = try XCTUnwrap(osumat.first?.runko as? [String: Any], "napautuksen runko puuttuu")
        let x = try XCTUnwrap(runko["x"] as? Double), y = try XCTUnwrap(runko["y"] as? Double)
        XCTAssertEqual(x, 0.5, accuracy: 0.05, "x on murto-osa kuvasta")
        XCTAssertEqual(y, 0.25, accuracy: 0.05, "y on murto-osa kuvasta")
        XCTAssertTrue((0.0...1.0).contains(x) && (0.0...1.0).contains(y))
    }

    func testNappiLahettaaNimen() async throws {
        let app = try kaynnista()
        avaaAndroid(app)
        let koti = elementti(app, "android-koti")
        XCTAssertTrue(koti.waitForExistence(timeout: 20), "Koti-nappi puuttuu")
        koti.tap()
        let osumat = try await odotaPost("/api/android/nappi")
        XCTAssertEqual((osumat.first?.runko as? [String: Any])?["nimi"] as? String, "koti")
    }

    func testRuutuEiPaivityTaustalla() async throws {
        let app = try kaynnista()
        avaaAndroid(app)
        // ruutu päivittyy näkyvissä ollessaan
        let loppu = Date().addingTimeInterval(20)
        var haut = try await loki().ruutuHaut
        while haut < 2, Date() < loppu {
            try await Task.sleep(nanoseconds: 500_000_000)
            haut = try await loki().ruutuHaut
        }
        XCTAssertGreaterThanOrEqual(haut, 2, "ruutu ei päivittynyt näkyvissä")
        // näkymä poistuu, eikä taustakyselyä pitäisi tulla. Välilehtipalkki ei näy Android-näkymässä (T-87-ajo 21.10.2026),
        // joten poistutaan navigointipalkin paluunapilla, jos välilehteä ei ole.
        let asetukset = app.tabBars.buttons["Asetukset"]
        if asetukset.waitForExistence(timeout: 3) {
            asetukset.tap()
        } else {
            let paluu = app.navigationBars.buttons.element(boundBy: 0)
            XCTAssertTrue(paluu.waitForExistence(timeout: 10), "paluunappi puuttuu: \(app.navigationBars.buttons.allElementsBoundByIndex.map(\.label))")
            paluu.tap()
        }
        XCTAssertTrue(odotaPoissa(elementti(app, "android-ruutu")), "Android-näkymä ei poistunut")
        try await Task.sleep(nanoseconds: 2_500_000_000)
        let ennen = try await loki().ruutuHaut
        try await Task.sleep(nanoseconds: 4_000_000_000)
        let jalkeen = try await loki().ruutuHaut
        XCTAssertEqual(jalkeen, ennen, "ruutua haettiin taustalla \(jalkeen - ennen) kertaa")
    }
}
