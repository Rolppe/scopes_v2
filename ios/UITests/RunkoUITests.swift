// T-49: ARK-08:n koneellinen hyväksyntä simulaattorissa koeydintä vasten (tunneli 127.0.0.1:18797, P-14).
// Avain: TEST_RUNNER_SCOPES2_AVAIN → testiajurin SCOPES2_AVAIN; ei koodissa eikä lokissa.
import XCTest

@MainActor
final class RunkoUITests: XCTestCase {
    private let osoite = ProcessInfo.processInfo.environment["SCOPES2_VERTAINEN"] ?? "http://127.0.0.1:18797"

    private func avain() throws -> String {
        try XCTUnwrap(ProcessInfo.processInfo.environment["SCOPES2_AVAIN"], "SCOPES2_AVAIN puuttuu")
    }

    private func kaynnista() throws -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["SCOPES2_AVAIN"] = try avain()
        app.launchEnvironment["SCOPES2_VERTAINEN"] = osoite
        app.launchEnvironment["SCOPES2_DATA"] = NSTemporaryDirectory() + "scopes2-ui-" + UUID().uuidString
        app.launch()
        return app
    }

    private func palvelin<T: Decodable>(_ polku: String, _ tyyppi: T.Type) async throws -> T {
        var req = URLRequest(url: URL(string: osoite + polku)!)
        req.setValue("Bearer " + (try avain()), forHTTPHeaderField: "Authorization")
        let (data, _) = try await URLSession.shared.data(for: req)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private struct Nimi: Decodable { let nimi: String }
    private struct Tyhja: Decodable {}
    private struct Viestit: Decodable { let viestit: [Tyhja] }

    /// Näkyvän ikkunan rivit ylhäältä alas yhdellä kyselyllä: (tunniste, sisältö) niille, joiden tunniste täyttää ehdon.
    private func ikkuna(_ app: XCUIApplication, _ kelpaa: (String) -> Bool) throws -> [(id: String, sisalto: String)] {
        var tulos: [(id: String, sisalto: String, y: CGFloat)] = []
        func kay(_ e: XCUIElementSnapshot) {
            if kelpaa(e.identifier) { tulos.append((e.identifier, e.label + "|" + (e.value as? String ?? ""), e.frame.minY)) }
            e.children.forEach(kay)
        }
        kay(try app.snapshot())
        return tulos.sorted { $0.y < $1.y }.map { ($0.id, $0.sisalto) }
    }

    /// Vetää sisältöä puoli ruutua (hallittu limitys): alas = sisältö liikkuu ylös.
    private func vieritaPuoli(_ app: XCUIApplication, alas: Bool) {
        let alku = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: alas ? 0.75 : 0.3))
        let loppu = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: alas ? 0.3 : 0.75))
        alku.press(forDuration: 0.05, thenDragTo: loppu)
    }

    /// Käy listan läpi vierittäen ja yhdistää peräkkäiset ikkunat limityksen mukaan. `alas` = suunta, jossa lista tyhjenee.
    private func kerää(_ app: XCUIApplication, alas: Bool, _ kelpaa: (String) -> Bool) throws -> [String] {
        var kaikki: [String] = []   // alas-suunnassa ylhäältä alas, ylös-suunnassa alhaalta ylös
        var muuttumatta = 0
        var kierroksia = 0
        while muuttumatta < 2 && kierroksia < 400 {
            kierroksia += 1
            var nyt = try ikkuna(app, kelpaa).map { $0.id + "|" + $0.sisalto }
            if !alas { nyt.reverse() }
            let ennen = kaikki.count
            let raja = min(kaikki.count, nyt.count)
            let limitys = (0...raja).reversed().first { kaikki.suffix($0).elementsEqual(nyt.prefix($0)) } ?? 0
            kaikki.append(contentsOf: nyt.dropFirst(limitys))
            muuttumatta = kaikki.count == ennen ? muuttumatta + 1 : 0
            vieritaPuoli(app, alas: alas)
        }
        return kaikki
    }

    private func palaaListaan(_ app: XCUIApplication) {
        let takaisin = app.navigationBars.buttons.element(boundBy: 0)
        if takaisin.waitForExistence(timeout: 5) { takaisin.tap() }
    }

    func testListaVastaaPalvelinta() async throws {
        let odotetut = Set(try await palvelin("/api/skoopit", [Nimi].self).map(\.nimi))
        XCTAssertFalse(odotetut.isEmpty, "palvelimella ei skoopteja")
        let app = try kaynnista()
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'skooppi-' AND identifier != 'skooppi-suodatin'")).firstMatch.waitForExistence(timeout: 60), "lista ei latautunut 60 s:ssa")
        // lista ladataan ensisynkassa osissa: odota, että nimet kasvavat vakaiksi
        var nahdyt = Set<String>()
        let loppu = Date().addingTimeInterval(60)
        repeat {
            let rivit = try kerää(app, alas: true) { $0.hasPrefix("skooppi-") && $0 != "skooppi-suodatin" }
            nahdyt = Set(rivit.map { String($0.split(separator: "|", maxSplits: 1)[0].dropFirst("skooppi-".count)) })
            if odotetut.isSubset(of: nahdyt) { break }
        } while Date() < loppu
        XCTAssertTrue(odotetut.isSubset(of: nahdyt), "puuttuu: \(odotetut.subtracting(nahdyt).sorted())")
    }

    func testViestitVastaavatPalvelinta() async throws {
        let skoopit = try await palvelin("/api/skoopit", [Nimi].self).map(\.nimi)
        var maarat: [(String, Int)] = []
        for n in skoopit {
            let koodattu = n.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? n
            maarat.append((n, try await palvelin("/api/skoopit/\(koodattu)/viestit", Viestit.self).viestit.count))
        }
        let kaksi = maarat.sorted { $0.1 > $1.1 }.prefix(2)
        let app = try kaynnista()
        for (nimi, maara) in kaksi {
            // rivi voi olla listan ulkopuolella: vieritä alkuun ja etsi
            let rivi = app.descendants(matching: .any)["skooppi-\(nimi)"].firstMatch
            var yrityksia = 0
            while !rivi.waitForExistence(timeout: yrityksia == 0 ? 60 : 1) && yrityksia < 80 {
                vieritaPuoli(app, alas: true); yrityksia += 1
            }
            XCTAssertTrue(rivi.exists, "skooppi \(nimi) ei listalla")
            rivi.tap()
            XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "identifier IN {'viesti','tyokalu-rivi'}")).firstMatch.waitForExistence(timeout: 30), "viestejä ei näy: \(nimi)")
            // näkymä alkaa alareunasta: vieritä ylös, kunnes loppuu
            let rivit = try kerää(app, alas: false) { $0 == "viesti" || $0 == "tyokalu-rivi" }
            XCTAssertEqual(rivit.count, maara, "viestimäärä skoopissa \(nimi)")
            palaaListaan(app)
        }
    }

    /// P-11: V2:n bundle-id on oma; vanhaa äppiä ei käynnistetä eikä sen Keychain-palvelua (com.example.skoopit) lueta.
    func testBundleIdOnP11nMukainen() throws {
        _ = try kaynnista()
        let v2 = XCUIApplication(bundleIdentifier: "com.example.scopes-v2")
        XCTAssertEqual(v2.state, .runningForeground)
        XCTAssertNotEqual(XCUIApplication(bundleIdentifier: "com.example.skoopit").state, .runningForeground)
    }
}
