// T-49: ARK-08:n koneellinen hyväksyntä macOS:llä koeydintä vasten (tunneli 127.0.0.1:18797, P-14).
// Avain: TEST_RUNNER_SCOPES2_AVAIN → testiajurin SCOPES2_AVAIN; ei koodissa eikä lokissa.
// pohja: scopes2/ios/UITests/RunkoUITests.swift (sama rakenne; macOS: click ja scroll swipen sijaan)
import XCTest
import CryptoKit
import ScopesCore2

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
            rivi.click()
            let viestit = app.descendants(matching: .any).matching(NSPredicate(format: "identifier IN {'viesti','tyokalu-rivi'}"))
            let loppu = Date().addingTimeInterval(30)
            while Date() < loppu && viestit.count == 0 { try await Task.sleep(nanoseconds: 500_000_000) }
            XCTAssertEqual(try await laske(app, viestit), maara, "viestimäärä skoopissa \(nimi)")
        }
    }

    /// LazyVStack luo rivit vain näkyvälle alueelle: vieritetään alkuun ja sitten alas, ja yhdistetään peräkkäiset ikkunat limityksen mukaan.
    private func laske(_ app: XCUIApplication, _ rivit: XCUIElementQuery) async throws -> Int {
        let lista = app.scrollViews.containing(NSPredicate(format: "identifier IN {'viesti','tyokalu-rivi'}")).firstMatch
        for _ in 0..<40 { lista.scroll(byDeltaX: 0, deltaY: 2000) }
        var kaikki: [String] = []
        var muuttumatta = 0
        while muuttumatta < 2 {
            let ikkuna = rivit.allElementsBoundByIndex.filter(\.exists).map { "\($0.identifier)|\($0.label)" }
            let ennen = kaikki.count
            let limitys = (0...min(kaikki.count, ikkuna.count)).reversed().first { kaikki.suffix($0).elementsEqual(ikkuna.prefix($0)) } ?? 0
            kaikki.append(contentsOf: ikkuna.dropFirst(limitys))
            muuttumatta = kaikki.count == ennen ? muuttumatta + 1 : 0
            lista.scroll(byDeltaX: 0, deltaY: -300)
        }
        return kaikki.count
    }

    /// Liite macOS:ltä: fileImporter-polun sijaan Asiakas.liite väliaikaistiedostolla; sha256:n tarkistaa valvoja T-51-ajossa palvelimella.
    func testLiiteMacilta() async throws {
        let skoopit = try await palvelin("/api/skoopit", [Nimi].self).map(\.nimi)
        let kohde = skoopit.contains("test") ? "test" : try XCTUnwrap(skoopit.first, "palvelimella ei skoopteja")
        let sisalto = Data("scopes-V2 liite \(UUID().uuidString)".utf8)
        let sha = SHA256.hash(data: sisalto).map { String(format: "%02x", $0) }.joined()
        let asiakas = Asiakas(osoite: URL(string: osoite)!, avain: try avain())
        let v = try await asiakas.liite(skooppi: kohde, nimi: "t49-\(sha.prefix(8)).txt", data: sisalto)
        XCTAssertEqual(v.sha256, sha)
        XCTAssertEqual(v.koko, sisalto.count)
        XCTAssertTrue(v.polku.hasPrefix("/"), "polku ei ole palvelimen absoluuttinen: \(v.polku)")
        XCTAssertFalse((v.solmu ?? "").isEmpty, "vastauksesta puuttuu solmu")
        XCTAssertFalse((v.solmu ?? "").hasPrefix("mac-"), "liite päätyi Macin solmuun: \(v.solmu ?? "")")
        print("LIITE: \(sha) \(v.polku)")
    }

    /// P-11: V2:n bundle-id on oma; vanhaa äppiä ei käynnistetä eikä sen Keychain-palvelua (com.example.scopes.mac) lueta.
    func testBundleIdOnP11nMukainen() throws {
        _ = try kaynnista()
        let v2 = XCUIApplication(bundleIdentifier: "com.example.scopes-v2.mac")
        XCTAssertEqual(v2.state, .runningForeground)
        XCTAssertNotEqual(XCUIApplication(bundleIdentifier: "com.example.scopes.mac").state, .runningForeground)
    }
}
