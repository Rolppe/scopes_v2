// T-59 (S-9, simulaattoriosa): ikkunoitu solmu (7 vrk) koeydintä vasten TCP-välityksen P kautta. Testit ajaa vain
// scopes2/ios/testit/t59/t59.sh, joka asettaa T59_VAIHE (1-4); muuten jokainen testi ohitetaan, jotta gate T-49/T-58
// ei aja niitä. Kaikissa vaiheissa sama SCOPES2_DATA (T59_DATA), jotta ikkuna, pohja ja replikoidut yksiköt säilyvät.
// Ympäristö TEST_RUNNER_-etuliitteellä: T59_VAIHE, T59_DATA, T59_ULOS (mittaustiedostojen hakemisto), T59_S2 (S2:n skooppi),
// T59_TEST_MAARA (vaiheen 1 "test"-viestimäärä vaiheelle 2), SCOPES2_VERTAINEN (P), SCOPES2_AVAIN (ei lokiin).
import XCTest

@MainActor
final class T59UITests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }
    private let vanhaTeksti = "T59-VANHA", tuoreTeksti = "T59-TUORE"

    private func vain(_ vaihe: Int) throws {
        try XCTSkipUnless(env["T59_VAIHE"] == String(vaihe), "T-59 vaihe \(vaihe): aja t59.sh:lla (T59_VAIHE=\(vaihe))")
    }

    private func kaynnista() throws -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["SCOPES2_AVAIN"] = try XCTUnwrap(env["SCOPES2_AVAIN"], "SCOPES2_AVAIN puuttuu")
        app.launchEnvironment["SCOPES2_VERTAINEN"] = try XCTUnwrap(env["SCOPES2_VERTAINEN"], "SCOPES2_VERTAINEN puuttuu")
        app.launchEnvironment["SCOPES2_KUITTAUS"] = "pois"
        app.launchEnvironment["SCOPES2_DATA"] = try XCTUnwrap(env["T59_DATA"], "T59_DATA puuttuu")
        app.launchArguments += ["-scopes2.peili-ikkuna-vrk", "7"]
        app.launch()
        return app
    }

    private func s2() throws -> String { try XCTUnwrap(env["T59_S2"], "T59_S2 puuttuu") }

    /// Mittaus: tiedostoon T59_ULOS/vaihe<n>.txt (script lukee) ja lokiin; ei avainta.
    private func kirjaa(_ avain: String, _ arvo: String) {
        let rivi = "\(avain)=\(arvo)\n"
        NSLog("T59 %@", rivi)
        let a = XCTAttachment(string: rivi); a.name = "T59 \(avain)"; a.lifetime = .keepAlways; add(a)
        guard let dir = env["T59_ULOS"], let n = env["T59_VAIHE"] else { return }
        let url = URL(fileURLWithPath: dir).appendingPathComponent("vaihe\(n).txt")
        if let h = try? FileHandle(forWritingTo: url) {
            _ = try? h.seekToEnd(); try? h.write(contentsOf: Data(rivi.utf8)); try? h.close()
        } else {
            try? rivi.write(to: url, atomically: false, encoding: .utf8)
        }
    }

    // MARK: navigointi

    private func kentta(_ app: XCUIApplication) -> XCUIElement { app.textFields["skooppi-suodatin"] }

    /// Äppi voi avautua suoraan edellisen vaiheen valittuun skooppiin (tilasynkka): palataan listaan.
    /// Käynnistyksessä lista vilahtaa ennen palautetun valinnan työntöä: lista on perillä vasta, kun se näkyy vakaasti.
    private func listaan(_ app: XCUIApplication) {
        let loppu = Date().addingTimeInterval(60)
        var nahty = 0
        while Date() < loppu {
            if kentta(app).exists, kentta(app).isHittable {
                nahty += 1
                if nahty >= 3 { return }
            } else {
                nahty = 0
                let takaisin = app.buttons["BackButton"].firstMatch
                if takaisin.exists { takaisin.tap() }
            }
            Thread.sleep(forTimeInterval: 1)
        }
    }

    /// Rajaa listan suodattimella ja avaa skoopin (rivin tunniste skooppi-<nimi>).
    private func avaa(_ app: XCUIApplication, _ nimi: String) {
        listaan(app)
        let k = kentta(app)
        XCTAssertTrue(k.waitForExistence(timeout: 60), "skooppilista ei latautunut 60 s:ssa")
        k.tap()
        if let v = k.value as? String, !v.isEmpty, v != "Suodata skoopit" {
            k.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: v.count))
        }
        k.typeText(nimi)
        let rivi = app.descendants(matching: .any)["skooppi-\(nimi)"].firstMatch
        XCTAssertTrue(rivi.waitForExistence(timeout: 90), "skooppi \(nimi) ei listalla")
        rivi.tap()
        XCTAssertTrue(app.tabBars.buttons["Asetukset"].waitForExistence(timeout: 20), "välilehdet eivät näy skoopin valinnan jälkeen")
    }

    private func takaisin(_ app: XCUIApplication) {
        let b = app.buttons["BackButton"].firstMatch
        if b.waitForExistence(timeout: 5) { b.tap() }
        _ = kentta(app).waitForExistence(timeout: 10)
    }

    private func viestiValilehti(_ app: XCUIApplication) {
        let v = app.tabBars.buttons["Viestit"]
        if v.waitForExistence(timeout: 10) { v.tap() }
    }

    // MARK: viestien luku

    private struct Rivi { let label: String; let y: CGFloat }

    private func ikkuna(_ app: XCUIApplication, _ tunnus: String) throws -> [Rivi] {
        var tulos: [Rivi] = []
        func kay(_ e: XCUIElementSnapshot) {
            if e.identifier == tunnus { tulos.append(Rivi(label: e.label, y: e.frame.minY)) }
            e.children.forEach(kay)
        }
        kay(try app.snapshot())
        return tulos
    }

    private func vieritaPuoli(_ app: XCUIApplication, alas: Bool) {
        let alku = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: alas ? 0.75 : 0.3))
        let loppu = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: alas ? 0.3 : 0.75))
        alku.press(forDuration: 0.05, thenDragTo: loppu)
    }

    /// Kaikki "viesti"-rivien selitteet vierittäen ylös ja alas (LazyVStack): yksilölliset selitteet.
    private func keraa(_ app: XCUIApplication) throws -> Set<String> {
        var nahdyt = Set<String>()
        for alas in [false, true] {
            var vakaa = 0
            for _ in 0..<80 where vakaa < 3 {
                let ennen = nahdyt.count
                for r in try ikkuna(app, "viesti") { nahdyt.insert(r.label) }
                vakaa = nahdyt.count == ennen ? vakaa + 1 : 0
                vieritaPuoli(app, alas: alas)
            }
        }
        return nahdyt
    }

    private func viesteja(_ app: XCUIApplication) -> Bool {
        app.descendants(matching: .any)["viesti"].firstMatch.exists
    }

    /// Odottaa vähintään yhtä viestiriviä; `uudelleenAvaus` palaa listaan ja avaa skoopin uudelleen tämän välein.
    private func odotaViesteja(_ app: XCUIApplication, _ nimi: String, sekuntia: TimeInterval, uudelleenAvaus: TimeInterval) -> Bool {
        let loppu = Date().addingTimeInterval(sekuntia)
        var avattu = Date()
        while Date() < loppu {
            if viesteja(app) { return true }
            if Date().timeIntervalSince(avattu) > uudelleenAvaus {
                takaisin(app); avaa(app, nimi); viestiValilehti(app); avattu = Date()
            }
            Thread.sleep(forTimeInterval: 2)
        }
        return viesteja(app)
    }

    // MARK: asetusnäkymä

    private func loyda(_ app: XCUIApplication, _ tunnus: String) -> XCUIElement {
        let e = app.descendants(matching: .any)[tunnus].firstMatch
        for _ in 0..<8 where !e.waitForExistence(timeout: 3) { app.swipeUp() }
        return e
    }

    private func lue(koko: String) -> (kaytetty: Double, katto: Double)? {
        let osat = koko.components(separatedBy: " / ")
        guard osat.count == 2,
              let a = Double(osat[0].replacingOccurrences(of: " Mt", with: "").replacingOccurrences(of: ",", with: ".")),
              let b = Double(osat[1].replacingOccurrences(of: " Mt", with: "")) else { return nil }
        return (a, b)
    }

    /// Asetukset-välilehti: ikkuna, katto ja käytetty koko. Palauttaa (ikkuna, selite).
    private func asetukset(_ app: XCUIApplication) throws -> (ikkuna: String, katto: String, koko: String) {
        app.tabBars.buttons["Asetukset"].tap()
        let ikkuna = loyda(app, "peili-ikkuna"), katto = loyda(app, "peili-katto"), koko = loyda(app, "peili-koko")
        XCTAssertTrue(koko.exists, "peili-koko puuttuu")
        let loppu = Date().addingTimeInterval(60)
        var selite = koko.label
        while Date() < loppu, lue(koko: selite) == nil { Thread.sleep(forTimeInterval: 0.5); selite = koko.label }
        return (ikkuna.label, katto.label, selite)
    }

    // MARK: vaiheet

    /// Vaihe 1 (P auki): (a) asetusnäkymän koko ≤ katto; replikointi: "test" näyttää viestejä; S2:ta ei avata.
    func testVaihe1() throws {
        try vain(1)
        let app = try kaynnista()
        avaa(app, "test")
        let a1 = try asetukset(app)
        kirjaa("a_alku", "ikkuna=\(a1.ikkuna) katto=\(a1.katto) koko=\(a1.koko)")
        XCTAssertEqual(a1.ikkuna, "7 vrk")
        XCTAssertEqual(a1.katto, "38 Mt")
        viestiValilehti(app)
        XCTAssertTrue(odotaViesteja(app, "test", sekuntia: 120, uudelleenAvaus: 40), "test: viestejä ei näy 120 s:ssa (replikointi)")
        // viestimäärä vakaaksi; S-9d:n pohja ehtii taustalla
        var maara = try keraa(app).count
        for _ in 0..<3 {
            Thread.sleep(forTimeInterval: 7)
            let uusi = try keraa(app).count
            if uusi == maara { break }
            maara = uusi
        }
        Thread.sleep(forTimeInterval: 20)
        let lopullinen = try keraa(app).count
        kirjaa("test_viesteja", String(lopullinen))
        XCTAssertGreaterThanOrEqual(lopullinen, 1)
        let a2 = try asetukset(app)
        kirjaa("a_loppu", "ikkuna=\(a2.ikkuna) katto=\(a2.katto) koko=\(a2.koko)")
        let arvo = try XCTUnwrap(lue(koko: a2.koko), "käytetty koko ei ole muotoa 'x,y Mt / katto': '\(a2.koko)'")
        XCTAssertEqual(arvo.katto, 38)
        XCTAssertLessThanOrEqual(arvo.kaytetty, arvo.katto, "käytetty koko ylittää katon")
    }

    /// Vaihe 2 (P kiinni jo äpin käynnistyessä): äppi avautuu edellisen vaiheen valittuun skooppiin ("test"); viestit näkyvät
    /// ytimen omasta varastosta samoin kuin vaiheessa 1. Skooppilistan koko kirjataan (sen hakee silta vertaisen kautta).
    func testVaihe2() throws {
        try vain(2)
        let app = try kaynnista()
        // Palautettu valinta: viestirivit ilman listaa. Muuten yritetään listan kautta.
        var nakyy = odotaViesteja(app, "test", sekuntia: 40, uudelleenAvaus: 1_000_000)
        kirjaa("palautettu_valinta", nakyy ? "kylla" : "ei")
        if !nakyy {
            listaan(app)
            kirjaa("lista_otsikko", otsikko(app))
            avaa(app, "test"); viestiValilehti(app)
            nakyy = odotaViesteja(app, "test", sekuntia: 60, uudelleenAvaus: 1_000_000)
        }
        XCTAssertTrue(nakyy, "test: viestejä ei näy, kun tunneli on kiinni")
        let test = try keraa(app).count
        kirjaa("test_viesteja", String(test))
        if let ennen = env["T59_TEST_MAARA"].flatMap(Int.init) {
            XCTAssertEqual(test, ennen, "test-viestimäärä muuttui tunnelin sulkemisen jälkeen (vaihe 1: \(ennen))")
        } else {
            XCTFail("T59_TEST_MAARA puuttuu")
        }
        takaisin(app)
        _ = kentta(app).waitForExistence(timeout: 10)
        Thread.sleep(forTimeInterval: 5)
        kirjaa("lista_otsikko", otsikko(app))
    }

    /// "Skoopit (n)" -osion otsikko listanäkymästä.
    private func otsikko(_ app: XCUIApplication) -> String {
        let t = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Skoopit ('")).firstMatch
        return t.exists ? t.label : "-"
    }

    /// Pyytää scriptiltä P:n sulkemista (tiedostokättely T59_ULOS/p-kiinni.pyynto → p-kiinni.valmis).
    private func suljeP() throws {
        let dir = try XCTUnwrap(env["T59_ULOS"], "T59_ULOS puuttuu")
        try? "x".write(toFile: dir + "/p-kiinni.pyynto", atomically: true, encoding: .utf8)
        let loppu = Date().addingTimeInterval(60)
        while Date() < loppu, !FileManager.default.fileExists(atPath: dir + "/p-kiinni.valmis") { Thread.sleep(forTimeInterval: 0.5) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir + "/p-kiinni.valmis"), "P ei sulkeutunut 60 s:ssa")
    }

    /// Vaihe 3 (P auki käynnistyessä, suljetaan kesken ajon): skooppilista on jo muistissa, joten S2 voidaan avata, kun tunneli on
    /// kiinni. S2:n vanha yksikkö ei ole paikallinen (ikkuna) eikä sitä saada haettua: VANHA ei näy, haettavissa-rivi.
    func testVaihe3() throws {
        try vain(3)
        let app = try kaynnista()
        let nimi = try s2()
        avaa(app, "test"); viestiValilehti(app)
        XCTAssertTrue(odotaViesteja(app, "test", sekuntia: 60, uudelleenAvaus: 1_000_000), "test: viestejä ei näy")
        try suljeP()
        takaisin(app)
        avaa(app, nimi); viestiValilehti(app)
        XCTAssertTrue(odotaViesteja(app, nimi, sekuntia: 90, uudelleenAvaus: 1_000_000), "\(nimi): viestejä ei näy (tuore yksikkö)")
        let loppu = Date().addingTimeInterval(60)
        while Date() < loppu, !app.descendants(matching: .any)["haettavissa"].exists { Thread.sleep(forTimeInterval: 2) }
        let haettavissa = app.descendants(matching: .any)["haettavissa"].exists
        let selitteet = try keraa(app)
        let vanha = selitteet.contains { $0.contains(vanhaTeksti) }
        let tuore = selitteet.contains { $0.contains(tuoreTeksti) }
        kirjaa("s2_viesteja", String(selitteet.count))
        kirjaa("s2_haettavissa", haettavissa ? "kylla" : "ei")
        kirjaa("s2_vanha_nakyy", vanha ? "kylla" : "ei")
        kirjaa("s2_tuore_nakyy", tuore ? "kylla" : "ei")
        XCTAssertFalse(vanha, "\(vanhaTeksti) näkyy ikkunoidussa solmussa, vaikka vertainen on poissa")
        XCTAssertTrue(tuore, "\(tuoreTeksti) ei näy")
        XCTAssertTrue(haettavissa, "haettavissa-rivi ei näy 60 s:ssa vertaisen kadottua")
    }

    /// Vaihe 4 (P takaisin, kylmäkäynnistys): äppi avautuu S2:een (palautettu valinta); vanhat viestit haetaan; haettavissa poistuu.
    func testVaihe4() throws {
        try vain(4)
        let app = try kaynnista()
        let nimi = try s2()
        let alku = Date()
        let loppu = alku.addingTimeInterval(180)
        var avattu = Date()
        var selitteet = Set<String>()
        var vanha = false
        while Date() < loppu {
            if viesteja(app) {
                selitteet = try keraa(app)
                vanha = selitteet.contains { $0.contains(vanhaTeksti) }
                if vanha { break }
            } else if kentta(app).exists, kentta(app).isHittable {
                avaa(app, nimi); viestiValilehti(app); avattu = Date()
            }
            if Date().timeIntervalSince(avattu) > 65 { takaisin(app); avaa(app, nimi); viestiValilehti(app); avattu = Date() }
            Thread.sleep(forTimeInterval: 3)
        }
        let kesto = Int(Date().timeIntervalSince(alku))
        let h = Date().addingTimeInterval(20)
        while Date() < h, app.descendants(matching: .any)["haettavissa"].exists { Thread.sleep(forTimeInterval: 1) }
        let haettavissa = app.descendants(matching: .any)["haettavissa"].exists
        selitteet = try keraa(app)
        let tuore = selitteet.contains { $0.contains(tuoreTeksti) }
        vanha = vanha || selitteet.contains { $0.contains(vanhaTeksti) }
        kirjaa("s2_viesteja", String(selitteet.count))
        kirjaa("s2_vanha_nakyy", vanha ? "kylla" : "ei")
        kirjaa("s2_vanha_kesto_s", String(kesto))
        kirjaa("s2_tuore_nakyy", tuore ? "kylla" : "ei")
        kirjaa("s2_haettavissa", haettavissa ? "kylla" : "ei")
        XCTAssertTrue(vanha, "\(vanhaTeksti) ei näy 180 s:ssa tunnelin palattua")
        XCTAssertTrue(tuore, "\(tuoreTeksti) ei näy")
        XCTAssertFalse(haettavissa, "haettavissa-rivi näkyy yhä")
    }
}
