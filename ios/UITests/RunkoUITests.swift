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

    private struct Rivi { let avain: String; let y: CGFloat }

    /// Työkalurivi näkyy kolmena elementtinä (kuva, teksti, säiliö, kaikilla sama tunniste); lasketaan vain kuva, tekstiviesti on yksi elementti.
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

    /// Vetää sisältöä puoli ruutua: alas = sisältö liikkuu ylös.
    private func vieritaPuoli(_ app: XCUIApplication, alas: Bool) {
        let alku = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: alas ? 0.75 : 0.3))
        let loppu = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: alas ? 0.3 : 0.75))
        alku.press(forDuration: 0.05, thenDragTo: loppu)
    }

    /// Laskee listan rivit vierittäen. Peräkkäiset ikkunat yhdistetään limityksen mukaan; limitys hyväksytään vain, jos
    /// kaikkien limittyvien rivien siirtymä on sama (identtiset peräkkäiset rivit eivät sekoita laskentaa).
    /// `alas` = vieritys alaspäin; muuten ylöspäin (silloin ikkunat käännetään peilikuviksi).
    private func laske(_ app: XCUIApplication, alas: Bool, _ kelpaa: (XCUIElementSnapshot) -> Bool) throws -> (maara: Int, aukkoja: Int) {
        let odotettuSiirtyma = app.frame.height * 0.45
        var edellinen: [Rivi] = []
        var maara = 0, aukkoja = 0, paikallaan = 0, siirtyma = odotettuSiirtyma
        var loki: [String] = []
        defer { let l = XCTAttachment(string: loki.joined(separator: "\n")); l.name = "laskenta"; l.lifetime = .keepAlways; add(l) }
        for _ in 0..<600 {
            var nyt = try ikkuna(app, kelpaa)
            if !alas { nyt = nyt.reversed().map { Rivi(avain: $0.avain, y: -$0.y) } }
            if edellinen.isEmpty {
                maara = nyt.count
                loki += nyt.map { "alku y=\(Int($0.y)) \($0.avain.prefix(70))" }
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
                    loki += nyt.dropFirst(p.k).map { "uusi k=\(p.k) s=\(Int(p.s)) y=\(Int($0.y)) \($0.avain.prefix(70))" }
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
            vieritaPuoli(app, alas: alas)
        }
        return (maara, aukkoja)
    }

    /// Sivupalkin skooppien nimet vierittämällä (tunnisteet ovat yksilöllisiä).
    private func nimetListasta(_ app: XCUIApplication) throws -> Set<String> {
        var nimet = Set<String>(), muuttumatta = 0
        for _ in 0..<200 where muuttumatta < 3 {
            let ennen = nimet.count
            for r in try ikkuna(app, { $0.identifier.hasPrefix("skooppi-") && $0.identifier != "skooppi-suodatin" }) {
                nimet.insert(String(r.avain.split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false)[0].dropFirst("skooppi-".count)))
            }
            muuttumatta = nimet.count == ennen ? muuttumatta + 1 : 0
            vieritaPuoli(app, alas: true)
        }
        return nimet
    }

    private func palaaListaan(_ app: XCUIApplication) {
        let takaisin = app.navigationBars.buttons.element(boundBy: 0)
        if takaisin.waitForExistence(timeout: 5) { takaisin.tap() }
        _ = app.textFields["skooppi-suodatin"].waitForExistence(timeout: 10)
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
            // rivi voi olla listan ulkopuolella: vieritä alkuun ja etsi
            let rivi = app.descendants(matching: .any)["skooppi-\(nimi)"].firstMatch
            _ = rivi.waitForExistence(timeout: 60)
            for alas in [true, false] {
                var yrityksia = 0
                while !(rivi.exists && rivi.isHittable) && yrityksia < 80 {
                    vieritaPuoli(app, alas: alas); yrityksia += 1
                }
                if rivi.exists && rivi.isHittable { break }
            }
            XCTAssertTrue(rivi.exists, "skooppi \(nimi) ei listalla")
            rivi.tap()
            XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "identifier IN {'viesti','tyokalu-rivi'}")).firstMatch.waitForExistence(timeout: 30), "viestejä ei näy: \(nimi)")
            // näkymä alkaa alareunasta: vieritä ylös, kunnes loppuu
            let tulos = try laske(app, alas: false) { $0.identifier == "viesti" || ($0.identifier == "tyokalu-rivi" && $0.elementType == .image) }
            XCTAssertEqual(tulos.aukkoja, 0, "limitys katkesi \(tulos.aukkoja) kertaa skoopissa \(nimi)")
            XCTAssertEqual(tulos.maara, maara, "viestimäärä skoopissa \(nimi)")
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
