// T-49: ARK-08:n koneellinen hyväksyntä simulaattorissa koeydintä vasten (tunneli 127.0.0.1:18797, P-14).
// Avain: TEST_RUNNER_SCOPES2_AVAIN → testiajurin SCOPES2_AVAIN; ei koodissa eikä lokissa.
import XCTest

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
    private struct Viestit: Decodable { let viestit: [Nimi?] }

    private func skooppiRivit(_ app: XCUIApplication) -> XCUIElementQuery {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'skooppi-' AND identifier != 'skooppi-suodatin'"))
    }

    func testListaVastaaPalvelinta() async throws {
        let odotetut = Set(try await palvelin("/api/skoopit", [Nimi].self).map(\.nimi))
        XCTAssertFalse(odotetut.isEmpty, "palvelimella ei skoopteja")
        let app = try kaynnista()
        let loppu = Date().addingTimeInterval(60)
        var nahdyt = Set<String>()
        while Date() < loppu {
            nahdyt = Set(skooppiRivit(app).allElementsBoundByIndex.map { String($0.identifier.dropFirst("skooppi-".count)) })
            if odotetut.isSubset(of: nahdyt) { break }
            try await Task.sleep(nanoseconds: 1_000_000_000)
        }
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
            let rivi = app.descendants(matching: .any)["skooppi-\(nimi)"].firstMatch
            XCTAssertTrue(rivi.waitForExistence(timeout: 60), "skooppi \(nimi) ei listalla")
            rivi.tap()
            let viestit = app.descendants(matching: .any).matching(NSPredicate(format: "identifier IN {'viesti','tyokalu-rivi'}"))
            let loppu = Date().addingTimeInterval(30)
            while Date() < loppu && viestit.count == 0 { try await Task.sleep(nanoseconds: 500_000_000) }
            // LazyVStack luo rivit vain näkyvälle alueelle; kerätään vierittämällä ylhäältä alas.
            XCTAssertEqual(try await laske(app, viestit), maara, "viestimäärä skoopissa \(nimi)")
        }
    }

    /// Vierittää alkuun ja sitten alas; yhdistää peräkkäiset näkyvät ikkunat limityksen mukaan ja laskee rivit.
    private func laske(_ app: XCUIApplication, _ rivit: XCUIElementQuery) async throws -> Int {
        for _ in 0..<40 { app.swipeDown(velocity: .fast) }
        var kaikki: [String] = []
        var muuttumatta = 0
        while muuttumatta < 2 {
            let ikkuna = rivit.allElementsBoundByIndex.filter(\.exists).map { "\($0.identifier)|\($0.label)" }
            let ennen = kaikki.count
            let limitys = (0...min(kaikki.count, ikkuna.count)).reversed().first { kaikki.suffix($0).elementsEqual(ikkuna.prefix($0)) } ?? 0
            kaikki.append(contentsOf: ikkuna.dropFirst(limitys))
            muuttumatta = kaikki.count == ennen ? muuttumatta + 1 : 0
            app.swipeUp()
        }
        return kaikki.count
    }

    /// P-11: V2:n bundle-id on oma; vanhaa äppiä ei käynnistetä eikä sen Keychain-palvelua (com.example.skoopit) lueta.
    func testBundleIdOnP11nMukainen() throws {
        _ = try kaynnista()
        let v2 = XCUIApplication(bundleIdentifier: "com.example.scopes-v2")
        XCTAssertEqual(v2.state, .runningForeground)
        XCTAssertNotEqual(XCUIApplication(bundleIdentifier: "com.example.skoopit").state, .runningForeground)
    }
}
