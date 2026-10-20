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
        app.launchEnvironment["SCOPES2_KUITTAUS"] = "pois"   // T-52: ei kuluta koeytimen lukemattomia kuittaustarkistukselta
        app.launchEnvironment["SCOPES2_DATA"] = NSTemporaryDirectory() + "scopes2-ui-" + UUID().uuidString
        app.launch()
        return app
    }

    private func palvelin<T: Decodable>(_ polku: String, _ tyyppi: T.Type) async throws -> T {
        var req = URLRequest(url: URL(string: osoite + polku)!, timeoutInterval: 240)   // kylmä silta: skooppilista ja viestit voivat kestää minuutin
        req.setValue("Bearer " + (try avain()), forHTTPHeaderField: "Authorization")
        // silta 8787:ään voi vastata hetkellisesti 502/503 ({"virhe":"silta"}): 5xx uusitaan 4 kertaa 10 s välein; muu kuin 200
        // heittää tilan ja rungon alun, jotta syy näkyy testituloksessa (T-52:n ajossa keyNotFound 'viestit' ilman syytä)
        var yritys = 1
        while true {
            let (data, vastaus) = try await URLSession.shared.data(for: req)
            let koodi = (vastaus as? HTTPURLResponse)?.statusCode ?? 0
            if koodi == 200 { return try JSONDecoder().decode(T.self, from: data) }
            guard koodi >= 500, yritys < 5 else {
                throw ApiVirhe(description: "\(polku): HTTP \(koodi) \(String(decoding: data.prefix(300), as: UTF8.self))")
            }
            yritys += 1
            try await Task.sleep(nanoseconds: 10_000_000_000)
        }
    }

    private struct ApiVirhe: Error, CustomStringConvertible { let description: String }

    private struct Nimi: Decodable { let nimi: String }
    private struct Tyhja: Decodable {}
    private struct Viestit: Decodable { let viestit: [Tyhja] }
    private struct ViestiAika: Decodable { let aika: String? }
    private struct ViestitAjalla: Decodable { let viestit: [ViestiAika] }

    /// Testi vaatii vähintään yhden palvelimella avoimen istunnon: /viestit palauttaa viestejä vain niille (muille viestit=[]).
    /// Elävän istunnon viestit kasvavat testin aikana, joten testiskooppeina ovat skoopit, joilla on viestejä, vanhin viimeisin viesti
    /// ensin (ei kovaa ikärajaa: ympäristö ei ole aina hiljaa); määrävertailu: vertaaAikavaliin.
    private func vakaat(_ skoopit: [String]) async throws -> [(nimi: String, maara: Int)] {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var tulos: [(String, Int, Date)] = []
        for n in skoopit {
            let koodattu = n.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? n
            let v = try await palvelin("/api/skoopit/\(koodattu)/viestit", ViestitAjalla.self)
            guard let viimeinen = v.viestit.last else { continue }
            tulos.append((n, v.viestit.count, viimeinen.aika.flatMap { iso.date(from: $0) } ?? .distantPast))
        }
        return tulos.sorted { $0.2 < $1.2 }.map { ($0.0, $0.1) }
    }

    /// /viestit on 120 viimeisimmän viestin liukuva ikkuna: elävässä istunnossa vanhimmat putoavat ja uusia tulee laskennan aikana, joten
    /// pelkät määrät eivät ole vertailukelpoisia. Verrataan UI:n ensimmäisen ja viimeisen aikaleimallisen viestirivin välisiä rivejä (niiden
    /// kanssa, työkalurivit mukaan lukien, UI-järjestyksessä) API:n samojen kahden viestin välisiin. Reunojen ulkopuoliset työkalurivit eivät
    /// kuulu vertailuun; viestiriviltä puuttuva aika kaataa testin. Reunaviesti, jota API-ikkunassa ei ole, kaataa testin (UI näyttää pudonneen).
    private func vertaaAikavaliin(_ nimi: String, _ avaimet: [String], ennen: [ViestiAika]) async throws {
        let viestit = avaimet.indices.filter { avaimet[$0].hasPrefix("viesti|") }
        guard let a = viestit.first, let b = viestit.last else { return XCTFail("UI:ssa ei viestirivejä: \(nimi)") }
        var ajat: [String] = []
        for i in [a, b] {
            guard let r = avaimet[i].range(of: #"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z"#, options: [.regularExpression, .backwards]) else {
                return XCTFail("viestiriviltä puuttuu aika skoopissa \(nimi): \(avaimet[i].prefix(80))")
            }
            ajat.append(String(avaimet[i][r]))
        }
        for i in viestit where avaimet[i].range(of: #"\d{4}-\d\d-\d\dT\d\d:\d\d"#, options: .regularExpression) == nil {
            return XCTFail("viestiriviltä puuttuu aika skoopissa \(nimi): \(avaimet[i].prefix(80))")
        }
        let koodattu = nimi.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? nimi
        // ikkuna liukuu laskennan aikana: ennen avausta haettu lista + jälkeen-listan viestit, jotka ovat ennen-listan viimeistä myöhempiä
        let jalkeen = try await palvelin("/api/skoopit/\(koodattu)/viestit", ViestitAjalla.self).viestit
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let raja = ennen.last?.aika.flatMap { iso.date(from: $0) } ?? .distantPast
        let api = ennen + jalkeen.filter { ($0.aika.flatMap { iso.date(from: $0) } ?? .distantPast) > raja }
        guard let ia = api.firstIndex(where: { $0.aika == ajat[0] }), let ib = api.firstIndex(where: { $0.aika == ajat[1] }) else {
            return XCTFail("UI:n reunaviesti puuttuu API-ikkunasta skoopissa \(nimi) (\(ajat[0]), \(ajat[1]); API \(api.first?.aika ?? "-") … \(api.last?.aika ?? "-"))")
        }
        let ui = b - a + 1, odotus = abs(ib - ia) + 1
        XCTAssertEqual(ui, odotus, "rivimäärä skoopissa \(nimi) viestien \(ajat.min()!) … \(ajat.max()!) välillä: UI \(ui), API \(odotus) (ikkunassa \(api.count))")
    }

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
    private func laske(_ app: XCUIApplication, alas: Bool, _ kelpaa: (XCUIElementSnapshot) -> Bool) throws -> (maara: Int, aukkoja: Int, avaimet: [String]) {
        let odotettuSiirtyma = app.frame.height * 0.45, maksimiSiirtyma = app.frame.height * 0.75   // veto on 0,45 × korkeus
        var edellinen: [Rivi] = []
        var maara = 0, aukkoja = 0, paikallaan = 0, siirtyma = odotettuSiirtyma
        var loki: [String] = [], avaimet: [String] = []   // avaimet: lasketut rivit UI-järjestyksessä (vertaaAikavaliin)
        defer { let l = XCTAttachment(string: loki.joined(separator: "\n")); l.name = "laskenta"; l.lifetime = .keepAlways; add(l) }
        for _ in 0..<600 {
            var nyt = try ikkuna(app, kelpaa)
            if !alas { nyt = nyt.reversed().map { Rivi(avain: $0.avain, y: -$0.y) } }
            if edellinen.isEmpty {
                maara = nyt.count
                avaimet = nyt.map(\.avain)
                loki += nyt.map { "alku y=\(Int($0.y)) \($0.avain.prefix(70))" }
            } else if nyt.map(\.avain) == edellinen.map(\.avain) && zip(nyt, edellinen).allSatisfy({ abs($0.y - $1.y) < 2 }) {
                // paikallaan ennen limityshakua: muuten identtisten työkalurivien pari antaa paikallaan olevalle ikkunalle näennäisen
                // limityksen (T-49 ajo 3: k=2 s=896 583 kertaa, 11780 vs API 120)
                paikallaan += 1
                if paikallaan >= 2 { break }
            } else {
                // rivit, joiden avain on kummassakin ikkunassa täsmälleen kerran (y edellisessä, y nyt): niiden on siirryttävä limityksen
                // siirtymällä; pelkkien työkalurivien alueella (ei yksilöllisiä avaimia) riittävät paikallaan- ja ylärajaehdot
                let yhteiset: [(CGFloat, CGFloat)] = edellinen.compactMap { r in
                    guard edellinen.filter({ $0.avain == r.avain }).count == 1, let m = nyt.first(where: { $0.avain == r.avain }),
                          nyt.filter({ $0.avain == r.avain }).count == 1 else { return nil }
                    return (r.y, m.y)
                }
                var paras: (k: Int, s: CGFloat)?
                for k in 1...max(1, min(edellinen.count, nyt.count)) where k <= min(edellinen.count, nyt.count) {
                    let a = edellinen.suffix(k), b = nyt.prefix(k)
                    guard zip(a, b).allSatisfy({ $0.avain == $1.avain }) else { continue }
                    let ero = zip(a, b).map { $0.y - $1.y }
                    guard let lo = ero.min(), let hi = ero.max(), hi - lo < 6, lo > 4, hi < maksimiSiirtyma else { continue }
                    let s = (lo + hi) / 2
                    guard yhteiset.allSatisfy({ abs($0.0 - $0.1 - s) < 6 }) else { continue }
                    if paras == nil || abs(s - siirtyma) < abs(paras!.s - siirtyma) { paras = (k, s) }
                }
                if let p = paras {
                    maara += nyt.count - p.k
                    avaimet += nyt.dropFirst(p.k).map(\.avain)
                    loki += nyt.dropFirst(p.k).map { "uusi k=\(p.k) s=\(Int(p.s)) y=\(Int($0.y)) \($0.avain.prefix(70))" }
                    siirtyma = p.s
                    paikallaan = 0
                } else {
                    maara += nyt.count; avaimet += nyt.map(\.avain); aukkoja += 1; paikallaan = 0; loki.append("AUKKO \(nyt.count)")   // ei luotettavaa limitystä
                }
            }
            edellinen = nyt
            vieritaPuoli(app, alas: alas)
        }
        return (maara, aukkoja, avaimet)
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
        let kaksi = Array(try await vakaat(skoopit).prefix(2))
        XCTAssertFalse(kaksi.isEmpty, "ei skooppia, jolla on viestejä (tarvitaan vähintään yksi palvelimella avoin istunto)")
        let app = try kaynnista()
        for (nimi, _) in kaksi {
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
            let koodattu = nimi.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? nimi
            let ennen = try await palvelin("/api/skoopit/\(koodattu)/viestit", ViestitAjalla.self).viestit
            rivi.tap()
            XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "identifier IN {'viesti','tyokalu-rivi'}")).firstMatch.waitForExistence(timeout: 90), "viestejä ei näy: \(nimi)")
            // näkymä alkaa alareunasta: vieritä ylös, kunnes loppuu
            let tulos = try laske(app, alas: false) { $0.identifier == "viesti" || ($0.identifier == "tyokalu-rivi" && $0.elementType == .image) }
            XCTAssertEqual(tulos.aukkoja, 0, "limitys katkesi \(tulos.aukkoja) kertaa skoopissa \(nimi)")
            try await vertaaAikavaliin(nimi, tulos.avaimet, ennen: ennen)
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
