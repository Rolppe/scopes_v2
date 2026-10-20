// T-49: ARK-08:n koneellinen hyväksyntä macOS:llä koeydintä vasten (tunneli 127.0.0.1:18797, P-14).
// Avain: TEST_RUNNER_SCOPES2_AVAIN → testiajurin SCOPES2_AVAIN; ei koodissa eikä lokissa.
// pohja: scopes2/ios/UITests/RunkoUITests.swift (sama rakenne; macOS: click ja scroll swipen sijaan)
import XCTest
import CryptoKit
import ScopesCore2

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

    private func skooppiRivit(_ app: XCUIApplication) -> XCUIElementQuery {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'skooppi-' AND identifier != 'skooppi-suodatin'"))
    }

    private struct Rivi { let avain: String; let y: CGFloat }

    /// Näkyvän ikkunan rivit yhdellä kyselyllä, ylhäältä alas (y kasvaa).
    private func ikkuna(_ app: XCUIApplication, _ kelpaa: (XCUIElementSnapshot) -> Bool) throws -> [Rivi] {
        var tulos: [Rivi] = []
        func kay(_ e: XCUIElementSnapshot) {
            if kelpaa(e) { tulos.append(Rivi(avain: e.identifier + "|" + e.label + "|" + (e.value as? String ?? ""), y: e.frame.minY)) }
            e.children.forEach(kay)
        }
        kay(try app.snapshot())
        return tulos.sorted { $0.y < $1.y }
    }

    private func sivupalkki(_ app: XCUIApplication) -> XCUIElement {
        app.scrollViews.containing(NSPredicate(format: "identifier BEGINSWITH 'skooppi-' AND identifier != 'skooppi-suodatin'")).firstMatch
    }

    private func vieritaAlkuun(_ lista: XCUIElement) {
        for _ in 0..<10 { lista.scroll(byDeltaX: 0, deltaY: 5000) }
    }

    /// Sivupalkin List näyttää vain näkyvät rivit: vieritä alkuun ja sitten alas, kerää nimet (tunnisteet ovat yksilöllisiä).
    private func nimetListasta(_ app: XCUIApplication) throws -> Set<String> {
        let lista = sivupalkki(app)
        vieritaAlkuun(lista)
        var nimet = Set<String>(), muuttumatta = 0
        for _ in 0..<200 where muuttumatta < 3 {
            let ennen = nimet.count
            for r in try ikkuna(app, { $0.identifier.hasPrefix("skooppi-") && $0.identifier != "skooppi-suodatin" }) {
                nimet.insert(String(r.avain.split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false)[0].dropFirst("skooppi-".count)))
            }
            muuttumatta = nimet.count == ennen ? muuttumatta + 1 : 0
            lista.scroll(byDeltaX: 0, deltaY: -250)
        }
        return nimet
    }

    /// Vierittää sivupalkkia alkuun ja alas, kunnes rivi on osoitettavissa.
    private func etsiRivi(_ app: XCUIApplication, _ nimi: String) -> XCUIElement {
        let rivi = app.descendants(matching: .any)["skooppi-\(nimi)"].firstMatch
        _ = rivi.waitForExistence(timeout: 60)
        let lista = sivupalkki(app)
        vieritaAlkuun(lista)
        var yrityksia = 0
        while !(rivi.exists && rivi.isHittable) && yrityksia < 80 {
            lista.scroll(byDeltaX: 0, deltaY: -250)
            yrityksia += 1
        }
        return rivi
    }

    func testListaVastaaPalvelinta() async throws {
        let odotetut = Set(try await palvelin("/api/skoopit", [Nimi].self).map(\.nimi))
        XCTAssertFalse(odotetut.isEmpty, "palvelimella ei skoopteja")
        let app = try kaynnista()
        XCTAssertTrue(skooppiRivit(app).firstMatch.waitForExistence(timeout: 60), "lista ei latautunut 60 s:ssa")
        // lista ladataan ensisynkassa osissa: odota, että nimet kasvavat vakaiksi
        var nahdyt = Set<String>()
        let loppu = Date().addingTimeInterval(60)
        repeat {
            nahdyt = try nimetListasta(app)
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
            let rivi = etsiRivi(app, nimi)
            XCTAssertTrue(rivi.exists, "skooppi \(nimi) ei listalla")
            rivi.click()
            XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "identifier IN {'viesti','tyokalu-rivi'}")).firstMatch.waitForExistence(timeout: 30), "viestejä ei näy: \(nimi)")
            let tulos = try laske(app) { $0.identifier == "viesti" || $0.identifier == "tyokalu-rivi" }   // macOS: työkalurivi on yksi elementti (tyyppi any), ei kolmea kuten iOS:llä
            XCTAssertEqual(tulos.aukkoja, 0, "limitys katkesi \(tulos.aukkoja) kertaa skoopissa \(nimi)")
            XCTAssertEqual(tulos.maara, maara, "viestimäärä skoopissa \(nimi)")
        }
    }

    /// LazyVStack luo rivit vain näkyvälle alueelle: vieritetään alkuun ja alas puoli ruutua kerrallaan, ja yhdistetään peräkkäiset ikkunat
    /// limityksen mukaan; limitys hyväksytään vain, jos kaikkien limittyvien rivien siirtymä on sama (identtiset rivit eivät sekoita laskentaa).
    private func laske(_ app: XCUIApplication, _ kelpaa: (XCUIElementSnapshot) -> Bool) throws -> (maara: Int, aukkoja: Int) {
        // näkymä alkaa alareunasta ja vanhempia viestejä ladataan ylös vieritettäessä: lasketaan alhaalta ylös (ikkunat peilataan)
        let lista = app.scrollViews.containing(NSPredicate(format: "identifier IN {'viesti','tyokalu-rivi'}")).firstMatch
        let askel = lista.frame.height * 0.45
        var edellinen: [Rivi] = []
        var maara = 0, aukkoja = 0, paikallaan = 0, siirtyma = askel
        var loki: [String] = []
        defer { let l = XCTAttachment(string: loki.joined(separator: "\n")); l.name = "laskenta"; l.lifetime = .keepAlways; add(l) }
        for _ in 0..<2000 {
            let nyt = try ikkuna(app, kelpaa).reversed().map { Rivi(avain: $0.avain, y: -$0.y) }
            if edellinen.isEmpty {
                maara = nyt.count
                loki.append("alku \(nyt.count)")
            } else {
                var paras: (k: Int, s: CGFloat)?
                for k in 1...max(1, min(edellinen.count, nyt.count)) where k <= min(edellinen.count, nyt.count) {
                    let a = edellinen.suffix(k), b = nyt.prefix(k)
                    guard zip(a, b).allSatisfy({ $0.avain == $1.avain }) else { continue }
                    let ero = zip(a, b).map { $0.y - $1.y }
                    guard let lo = ero.min(), let hi = ero.max(), hi - lo < 6, lo > 4 else { continue }
                    let s = (lo + hi) / 2
                    if paras == nil || abs(s - siirtyma) < abs(paras!.s - siirtyma) { paras = (k, s) }
                }
                if let p = paras {
                    maara += nyt.count - p.k
                    loki.append("k=\(p.k) s=\(Int(p.s)) uusia=\(nyt.count - p.k) yht=\(maara)")
                    siirtyma = p.s
                    paikallaan = 0
                } else if nyt.map(\.avain) == edellinen.map(\.avain) && zip(nyt, edellinen).allSatisfy({ abs($0.y - $1.y) < 2 }) {
                    paikallaan += 1
                    if paikallaan >= 2 { break }
                } else {
                    maara += nyt.count; aukkoja += 1; paikallaan = 0; loki.append("AUKKO \(nyt.count)")   // ei luotettavaa limitystä
                }
            }
            edellinen = nyt
            lista.scroll(byDeltaX: 0, deltaY: askel)
        }
        return (maara, aukkoja)
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
