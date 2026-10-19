import XCTest
@testable import ScopesCore2

/// (d) Mallit dekoodautuvat ytimen fixtureista.
final class MallitTests: XCTestCase {
    private func lue<T: Decodable>(_ nimi: String, _ tyyppi: T.Type = T.self) throws -> T {
        try JSONDecoder().decode(T.self, from: fixture(nimi))
    }

    func testSkoopit() throws {
        let l: [SkooppiYhteenveto] = try lue("skoopit.json")
        XCTAssertEqual(l.count, 92)
        XCTAssertEqual(l.first?.nimi, "claude")
        XCTAssertEqual(l.first?.tilaNyt, "pakattu")
        XCTAssertEqual(Set(l.map(\.id)).count, l.count, "skoopin nimi on yksilöllinen")
    }

    func testViestitScopesMacos() throws {
        let v: SkooppiViestit = try lue("viestit-scopes macos.json")
        XCTAssertEqual(v.nimi, "scopes macos")
        XCTAssertTrue(v.auki)
        XCTAssertTrue(v.voiLahettaa)
        XCTAssertEqual(v.istunto?.id, "28f5f18b-5ca1-41d3-9ebd-680e09cfd7bd")
        XCTAssertEqual(v.istunto?.konteksti?.tokenit, 103176)
        XCTAssertGreaterThan(v.viestit.count, 5)
        // Vanhan 8787-muodon viesteillä ei ole id:tä → rivin indeksi.
        XCTAssertEqual(v.viestit.map(\.id), v.viestit.indices.map(String.init))
        XCTAssertTrue(v.viestit.contains { $0.tyokalu })
        XCTAssertTrue(v.viestit.contains { $0.omaViesti })
        let kysymyksia = v.viestit.compactMap(\.kysymykset)
        XCTAssertEqual(kysymyksia.count, 2)
        XCTAssertEqual(kysymyksia.first?.first?.vaihtoehdot.map(\.nimi), ["Eka", "Toka"])
        XCTAssertEqual(kysymyksia.first?.last?.monivalinta, true)
    }

    func testViestinIdYdinmuodossaSailyy() throws {
        let json = #"{"nimi":"x","auki":true,"voiLahettaa":true,"viestit":[{"id":"s1:7","rooli":"agentti","teksti":"a"},{"rooli":"agentti","teksti":"b"}]}"#
        let v = try JSONDecoder().decode(SkooppiViestit.self, from: Data(json.utf8))
        XCTAssertEqual(v.viestit.map(\.id), ["s1:7", "1"])
    }

    func testViestitTyhja() throws {
        let v: SkooppiViestit = try lue("viestit-test.json")
        XCTAssertEqual(v.nimi, "test")
        XCTAssertFalse(v.auki)
        XCTAssertEqual(v.pakattu, false)
        XCTAssertNil(v.istunto)
        XCTAssertTrue(v.viestit.isEmpty)
    }

    private struct Skooppi: Decodable {
        let nimi: String
        let rekisterit: [String]
        let seuraava: Seuraava?
        let istunnot: [Istunto]
    }

    func testSkooppiSeuraavaJaIstunnot() throws {
        let t: Skooppi = try lue("skooppi-test.json")
        XCTAssertEqual(t.nimi, "test")
        XCTAssertEqual(t.rekisterit, ["test/REKISTERI.md"])
        XCTAssertEqual(t.seuraava?.id, "TEST-MAARITTELY")
        XCTAssertEqual(t.seuraava?.polut, ["test/**"])
        XCTAssertEqual(t.seuraava?.aloitus, "/pura test")
        XCTAssertTrue(t.istunnot.isEmpty)

        let m: Skooppi = try lue("skooppi-scopes macos.json")
        XCTAssertEqual(m.nimi, "scopes macos")
        XCTAssertNil(m.seuraava?.id)
        XCTAssertEqual(m.seuraava?.polut, [])
        XCTAssertEqual(m.istunnot.count, 1)
        XCTAssertEqual(m.istunnot.first?.nimi, "palvelin-21")
        XCTAssertEqual(m.istunnot.first?.hereilla, true)
    }

    func testAgentit() throws {
        let l: [Agentti] = try lue("agentit.json")
        XCTAssertEqual(l.count, 14)
        XCTAssertEqual(l.first?.nimi, "claude-fable-5-1")
        XCTAssertEqual(l.first?.otsikko, "Fable 5.1")
        XCTAssertTrue(l.contains { $0.tyyppi == "agy" })
    }

    private struct Rekisteri: Decodable {
        let polku: String
        let laji: String
        let skoopit: [String]
        let tavut: Int
        let raja: Int?
        let tokenit: Int
    }

    func testRekisterit() throws {
        let l: [Rekisteri] = try lue("rekisterit.json")
        XCTAssertEqual(l.count, 212)
        XCTAssertEqual(l.first?.polku, "claude/REKISTERI.md")
        XCTAssertEqual(l.first?.raja, 40000)
        XCTAssertTrue(l.contains { $0.raja == nil })
    }

    func testLahteet() throws {
        for nimi in ["lahde-agy.json", "lahde-istunnot.json"] {
            let o = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture(nimi)) as? [String: Any], nimi)
            XCTAssertEqual(o["laite"] as? String, "palvelin", nimi)
            XCTAssertNotNil(o["sisalto"] as? [Any], nimi)
        }
    }

    func testPeiliRivit() throws {
        let rivit = try String(decoding: fixture("peili-scopes macos.jsonl"), as: UTF8.self)
            .split(separator: "\n").filter { !$0.isEmpty }
        XCTAssertEqual(rivit.count, 17)
        // Fixture sisältää yhden tahallisesti rikkinäisen rivin ("rikki").
        let kelvolliset = rivit.compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
        XCTAssertEqual(kelvolliset.count, 16)
        for o in kelvolliset { XCTAssertNotNil(o["type"] as? String) }
    }

    func testNdjsonParser() throws {
        let data = Data("{\"tyyppi\":\"a\"}\n\n{\"tyyppi\":\"b\"}\n".utf8)
        let l: [ChatTapahtuma] = try NDJSONParser.parsii(data)
        XCTAssertEqual(l.map(\.tyyppi), ["a", "b"])
    }
}
