import XCTest
@testable import ScopesCore2

/// T-58 (S-9, ARK-17): transkriptipeilin ikkuna äpissä: asetukset_json-avaimet, laitekohtaiset oletukset, `haettavissa`, PeiliKoko.
final class PeiliTests: XCTestCase {
    private func tyhjaOletus() -> UserDefaults {
        let nimi = "scopes2-peili-testi-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: nimi)!
        d.removePersistentDomain(forName: nimi)
        addTeardownBlock { d.removePersistentDomain(forName: nimi) }
        return d
    }

    private func asetukset(_ ikkuna: Int?, _ katto: Int? = nil) -> [String: Any] {
        let data = URL(fileURLWithPath: "/tmp/scopes2-peili-ei-kaytossa", isDirectory: true)
        let a = katto.map { SolmuAsetukset(data: data, avain: "k", laite: "mac-koe", peiliIkkunaVrk: ikkuna, peiliKattoMt: $0) }
            ?? SolmuAsetukset(data: data, avain: "k", laite: "mac-koe", peiliIkkunaVrk: ikkuna)
        return a.ytimenAsetukset()
    }

    // MARK: asetukset_json

    func testAsetuksetJsonAvaimet() throws {
        let j = asetukset(7, 38)
        XCTAssertEqual(j["peili_ikkuna_vrk"] as? Int, 7)
        XCTAssertEqual(j["peili_katto_mt"] as? Int, 38)
        // olemassa olevat avaimet säilyvät
        for k in ["data", "avain", "portti", "vertaiset", "vanha", "vanha_avain", "headless", "laite"] { XCTAssertNotNil(j[k], k) }
        // JSONSerialization-kierros (kuten Solmu.kaynnista): luvut lukuina
        let luettu = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: j)) as? [String: Any])
        XCTAssertEqual(luettu["peili_ikkuna_vrk"] as? Int, 7)
        XCTAssertEqual(luettu["peili_katto_mt"] as? Int, 38)
    }

    func testAsetuksetJsonTaysiSolmuOnNull() throws {
        let j = asetukset(nil)
        XCTAssertTrue(j["peili_ikkuna_vrk"] is NSNull, "nil = täysi solmu → null")
        XCTAssertEqual(j["peili_katto_mt"] as? Int, 38, "katto oletuksena 38")
        let teksti = String(decoding: try JSONSerialization.data(withJSONObject: j), as: UTF8.self)
        XCTAssertTrue(teksti.contains("\"peili_ikkuna_vrk\":null"), teksti)
        XCTAssertEqual(asetukset(30, 100)["peili_katto_mt"] as? Int, 100)
    }

    // MARK: oletukset ja UserDefaults

    func testOletusIkkunaEhdollinen() {
        #if os(iOS) && !targetEnvironment(simulator)
        XCTAssertEqual(Oletukset.peiliIkkunaOletusVrk, 7, "fyysinen iOS-laite")
        XCTAssertEqual(Oletukset.peiliIkkunaVrk(tyhjaOletus()), 7)
        #elseif os(iOS)
        XCTAssertEqual(Oletukset.peiliIkkunaOletusVrk, 0, "iOS-simulaattori on täysi solmu (P-17)")
        XCTAssertNil(Oletukset.peiliIkkunaVrk(tyhjaOletus()))
        #else
        XCTAssertEqual(Oletukset.peiliIkkunaOletusVrk, 0, "macOS on täysi solmu (P-17)")
        XCTAssertNil(Oletukset.peiliIkkunaVrk(tyhjaOletus()))
        #endif
        XCTAssertEqual(Oletukset.peiliKattoMt(tyhjaOletus()), 38)
        XCTAssertEqual(Oletukset.peiliKattoMt, 38)
    }

    func testOletusLaitteellaJaSimulaattorissaAsetettavissa() {
        // Laitteen ja simulaattorin oletukset ovat parametri, joten molemmat haarat testataan millä tahansa alustalla.
        XCTAssertEqual(Oletukset.peiliIkkunaVrk(tyhjaOletus(), oletus: 7), 7, "laitteen oletus")
        XCTAssertNil(Oletukset.peiliIkkunaVrk(tyhjaOletus(), oletus: 0), "simulaattorin oletus")
    }

    func testAvaimetOvatLaitekohtaisiaUserDefaultsAvaimia() {
        XCTAssertEqual(Oletukset.peiliIkkunaAvain, "scopes2.peili-ikkuna-vrk")
        XCTAssertEqual(Oletukset.peiliKattoAvain, "scopes2.peili-katto-mt")
    }

    func testTallennettuArvoOhittaaOletuksen() {
        let d = tyhjaOletus()
        d.set(30, forKey: Oletukset.peiliIkkunaAvain)
        d.set(64, forKey: Oletukset.peiliKattoAvain)
        XCTAssertEqual(Oletukset.peiliIkkunaVrk(d, oletus: 7), 30)
        XCTAssertEqual(Oletukset.peiliKattoMt(d), 64)
        d.set(0, forKey: Oletukset.peiliIkkunaAvain)
        XCTAssertNil(Oletukset.peiliIkkunaVrk(d, oletus: 7), "0 = ei ikkunaa, vaikka oletus olisi 7")
        d.set(0, forKey: Oletukset.peiliKattoAvain)
        XCTAssertEqual(Oletukset.peiliKattoMt(d), 38, "kelvoton katto → oletus")
    }

    /// Käynnistysargumentti `-scopes2.peili-ikkuna-vrk 5` päätyy UserDefaultsin argumenttialueelle merkkijonona.
    func testKaynnistysargumenttiPakottaaIkkunan() {
        let standard = UserDefaults.standard
        let avain = Oletukset.peiliIkkunaAvain
        let vanha = standard.volatileDomain(forName: UserDefaults.argumentDomain)
        addTeardownBlock { standard.setVolatileDomain(vanha, forName: UserDefaults.argumentDomain) }
        var arg = vanha
        arg[avain] = "5"
        standard.setVolatileDomain(arg, forName: UserDefaults.argumentDomain)
        XCTAssertEqual(Oletukset.peiliIkkunaVrk(standard), 5)
        arg[avain] = "0"
        standard.setVolatileDomain(arg, forName: UserDefaults.argumentDomain)
        XCTAssertNil(Oletukset.peiliIkkunaVrk(standard))
    }

    // MARK: haettavissa

    func testHaettavissaDekoodaus() throws {
        func lue(_ extra: String) throws -> SkooppiViestit {
            let json = #"{"nimi":"x","auki":true,"voiLahettaa":true,"viestit":[]"# + extra + "}"
            return try JSONDecoder().decode(SkooppiViestit.self, from: Data(json.utf8))
        }
        XCTAssertFalse(try lue("").haettavissa, "täysi solmu: kenttä puuttuu → false")
        XCTAssertTrue(try lue(#","haettavissa":true"#).haettavissa)
        XCTAssertFalse(try lue(#","haettavissa":false"#).haettavissa)
        XCTAssertFalse(SkooppiViestit(nimi: "x", auki: true).haettavissa)
        XCTAssertTrue(SkooppiViestit(nimi: "x", auki: true, haettavissa: true).haettavissa)
        // vanha fixture (8787-muoto) ei sisällä kenttää
        let v = try JSONDecoder().decode(SkooppiViestit.self, from: fixture("viestit-scopes macos.json"))
        XCTAssertFalse(v.haettavissa)
    }

    // MARK: PeiliKoko

    func testPeiliKokoDekoodaus() throws {
        let ikkunoitu = #"{"tavut":1759035,"yksikot":3842,"vanhin":1760918400000,"ikkuna_vrk":7,"katto_mt":38}"#
        let k = try JSONDecoder().decode(PeiliKoko.self, from: Data(ikkunoitu.utf8))
        XCTAssertEqual(k, PeiliKoko(tavut: 1_759_035, yksikot: 3842, vanhin: 1_760_918_400_000, ikkunaVrk: 7, kattoMt: 38))
        XCTAssertEqual(k.kokoMt, 1_759_035.0 / 1_048_576, accuracy: 1e-9)
        XCTAssertLessThanOrEqual(k.kokoMt, Double(k.kattoMt))

        let taysi = #"{"tavut":0,"yksikot":0,"vanhin":null,"ikkuna_vrk":null,"katto_mt":38}"#
        let t = try JSONDecoder().decode(PeiliKoko.self, from: Data(taysi.utf8))
        XCTAssertNil(t.vanhin)
        XCTAssertNil(t.ikkunaVrk)
        XCTAssertEqual(t.kattoMt, 38)
        // puuttuvat valinnaiset kentät
        let vahan = try JSONDecoder().decode(PeiliKoko.self, from: Data(#"{"tavut":5,"yksikot":1,"katto_mt":38}"#.utf8))
        XCTAssertNil(vahan.vanhin)
        XCTAssertNil(vahan.ikkunaVrk)
    }

    func testAsiakasPeiliKokoReitti() async throws {
        let pyynnot = Pyynnot()
        MockURLProtocol.kasittelija = { req in
            pyynnot.lisaa(req)
            return (MockURLProtocol.vastaus(req), Data(#"{"tavut":2097152,"yksikot":4,"vanhin":null,"ikkuna_vrk":7,"katto_mt":38}"#.utf8))
        }
        defer { MockURLProtocol.kasittelija = nil }
        let a = Asiakas(osoite: URL(string: "http://127.0.0.1:18999")!, avain: "testiavain", session: MockURLProtocol.sessio())
        let k = try await a.peiliKoko()
        XCTAssertEqual(k.ikkunaVrk, 7)
        XCTAssertEqual(k.kokoMt, 2.0, accuracy: 1e-9)
        let req = try XCTUnwrap(pyynnot.kaikki.first)
        XCTAssertEqual(req.httpMethod, "GET")
        XCTAssertEqual(req.url?.absoluteString, "http://127.0.0.1:18999/api/peili/koko")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer testiavain")
    }

    // MARK: oikea ydin (T-54:n XCFramework)

    private func kokoYdimelta(ikkuna: Int?, katto: Int) async throws -> PeiliKoko {
        let avain = "koe-" + UUID().uuidString
        let data = FileManager.default.temporaryDirectory.appendingPathComponent("scopes2-peili-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: data) }
        let url = try await Solmu.jaettu.kaynnista(SolmuAsetukset(data: data, avain: avain, laite: "mac-koe", peiliIkkunaVrk: ikkuna, peiliKattoMt: katto))
        do {
            let k = try await Asiakas(osoite: url, avain: avain).peiliKoko()
            await Solmu.jaettu.pysayta()
            return k
        } catch {
            await Solmu.jaettu.pysayta()
            throw error
        }
    }

    func testYdinSaaIkkunanJaKaton() async throws {
        let k = try await kokoYdimelta(ikkuna: 7, katto: 38)
        XCTAssertEqual(k.ikkunaVrk, 7)
        XCTAssertEqual(k.kattoMt, 38)
        XCTAssertLessThanOrEqual(k.kokoMt, Double(k.kattoMt))
        let toinen = try await kokoYdimelta(ikkuna: 3, katto: 12)
        XCTAssertEqual(toinen.ikkunaVrk, 3)
        XCTAssertEqual(toinen.kattoMt, 12)
    }

    func testYdinTaysiSolmuIlmanIkkunaa() async throws {
        let k = try await kokoYdimelta(ikkuna: nil, katto: 38)
        XCTAssertNil(k.ikkunaVrk, "täysi solmu: ikkuna_vrk null")
    }
}
