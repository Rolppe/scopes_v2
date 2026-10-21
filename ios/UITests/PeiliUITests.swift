// T-58 (ARK-17, S-9): transkriptipeilin ikkuna äpissä. Simulaattori on oletuksena täysi solmu (P-17), joten ikkuna pakotetaan
// käynnistysargumentilla `-scopes2.peili-ikkuna-vrk <n>` (UserDefaultsin argumenttialue). Koeydin vertaisena kuten RunkoUITests (tunneli 18797).
// Avain: TEST_RUNNER_SCOPES2_AVAIN → testiajurin SCOPES2_AVAIN; ei koodissa eikä lokissa.
import XCTest

@MainActor
final class PeiliUITests: XCTestCase {
    private let osoite = ProcessInfo.processInfo.environment["SCOPES2_VERTAINEN"] ?? "http://127.0.0.1:18797"

    private func kaynnista(argumentit: [String]) throws -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["SCOPES2_AVAIN"] = try XCTUnwrap(ProcessInfo.processInfo.environment["SCOPES2_AVAIN"], "SCOPES2_AVAIN puuttuu")
        app.launchEnvironment["SCOPES2_VERTAINEN"] = osoite
        app.launchEnvironment["SCOPES2_KUITTAUS"] = "pois"   // ei kuluta koeytimen lukemattomia
        app.launchEnvironment["SCOPES2_DATA"] = NSTemporaryDirectory() + "scopes2-ui-peili-" + UUID().uuidString
        app.launchArguments += argumentit
        app.launch()
        return app
    }

    /// iPhonella NavigationSplitView näyttää ensin sivupalkin (skooppilista); välilehdet ovat detail-puolella skoopin valinnan jälkeen.
    private func avaaAsetukset(_ app: XCUIApplication) {
        let rivi = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'skooppi-' AND identifier != 'skooppi-suodatin'")).firstMatch
        XCTAssertTrue(rivi.waitForExistence(timeout: 60), "skooppilista ei latautunut 60 s:ssa")
        rivi.tap()
        let valilehti = app.tabBars.buttons["Asetukset"]
        XCTAssertTrue(valilehti.waitForExistence(timeout: 20), "Asetukset-välilehti ei näy skoopin valinnan jälkeen")
        valilehti.tap()
    }

    /// Lomakkeen rivit piirtyvät laiskasti: vieritetään alas, kunnes elementti löytyy.
    private func loyda(_ app: XCUIApplication, _ tunnus: String) -> XCUIElement {
        let e = app.descendants(matching: .any)[tunnus].firstMatch
        for _ in 0..<8 where !e.waitForExistence(timeout: 3) { app.swipeUp() }
        return e
    }

    /// Odottaa, kunnes elementin selite täyttää ehdon (palvelimelta haettu koko tulee asynkronisesti).
    private func odotaSelite(_ e: XCUIElement, sekuntia: TimeInterval = 60, _ kelpaa: (String) -> Bool) -> String {
        let loppu = Date().addingTimeInterval(sekuntia)
        var selite = e.label
        while Date() < loppu {
            selite = e.label
            if kelpaa(selite) { break }
            Thread.sleep(forTimeInterval: 0.5)
        }
        return selite
    }

    /// "x,y Mt / 38 Mt" → (käytetty, katto) megatavuina.
    private func lue(koko: String) -> (kaytetty: Double, katto: Double)? {
        let osat = koko.components(separatedBy: " / ")
        guard osat.count == 2,
              let a = Double(osat[0].replacingOccurrences(of: " Mt", with: "").replacingOccurrences(of: ",", with: ".")),
              let b = Double(osat[1].replacingOccurrences(of: " Mt", with: "")) else { return nil }
        return (a, b)
    }

    /// Pakotettu ikkuna (7 vrk): osio näkyy, ikkuna ja katto ovat oletukset, käytetty koko ≤ katto.
    func testPeiliOsioPakotetullaIkkunalla() throws {
        let app = try kaynnista(argumentit: ["-scopes2.peili-ikkuna-vrk", "7"])
        avaaAsetukset(app)
        let otsikko = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] 'Transkriptipeili'")).firstMatch
        XCTAssertTrue(loyda(app, "peili-ikkuna").exists, "Transkriptipeili-osio ei näy asetuksissa")
        XCTAssertTrue(otsikko.exists, "osion otsikko puuttuu")
        XCTAssertEqual(loyda(app, "peili-ikkuna").label, "7 vrk")
        XCTAssertEqual(loyda(app, "peili-katto").label, "38 Mt")
        let koko = loyda(app, "peili-koko")
        XCTAssertTrue(koko.exists, "käytetty koko puuttuu")
        let selite = odotaSelite(koko) { self.lue(koko: $0) != nil }
        let arvo = try XCTUnwrap(lue(koko: selite), "käytetty koko ei ole muotoa 'x,y Mt / katto': '\(selite)'")
        XCTAssertEqual(arvo.katto, 38, "ydin raportoi katon, jolla se käynnistettiin")
        XCTAssertLessThanOrEqual(arvo.kaytetty, arvo.katto, "käytetty koko ylittää katon")
        let ohje = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Muutos tulee voimaan, kun äppi käynnistyy uudelleen'")).firstMatch
        XCTAssertTrue(ohje.exists, "uudelleenkäynnistysohje puuttuu")
    }

    /// Ilman argumenttia simulaattori on täysi solmu: ikkunan arvo on "koko peili" eikä kattoa käytetä.
    func testPeiliOsioIlmanArgumenttiaKokoPeili() throws {
        let app = try kaynnista(argumentit: [])
        avaaAsetukset(app)
        XCTAssertEqual(loyda(app, "peili-ikkuna").label, "koko peili")
        let koko = loyda(app, "peili-koko")
        XCTAssertTrue(koko.exists, "käytetty koko puuttuu")
        let selite = odotaSelite(koko) { $0 != "–" }
        XCTAssertTrue(selite.contains(" Mt"), "käytetty koko ei ole muotoa 'x,y Mt': '\(selite)'")
        XCTAssertFalse(selite.contains(" / "), "täydellä solmulla ei ole kattoa: '\(selite)'")
        let ohje = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'koko peili'")).firstMatch
        XCTAssertTrue(ohje.exists, "'koko peili' ei näy osiossa")
    }
}
