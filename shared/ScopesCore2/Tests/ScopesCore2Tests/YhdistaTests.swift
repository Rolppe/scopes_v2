import XCTest
@testable import ScopesCore2

/// (b) yhdista: nollaus / korvaus / poisto.
final class YhdistaTests: XCTestCase {
    private func s(_ nimi: String, _ avoimia: Int = 0) -> SkooppiYhteenveto {
        SkooppiYhteenveto(nimi: nimi, avoimia: avoimia)
    }

    func testNollausKorvaaKaiken() {
        let nyt = [s("a"), s("b")]
        let v = SinceVastaus(seq: 9, muuttuneet: [s("c")], poistetut: [], nollaus: true)
        XCTAssertEqual(yhdista(nyt, v, tunniste: { $0.nimi }).map(\.nimi), ["c"])
    }

    func testKorvausIdnMukaanUudetLoppuun() {
        let nyt = [s("a", 1), s("b", 2)]
        let v = SinceVastaus(seq: 3, muuttuneet: [s("b", 20), s("c", 3)], poistetut: [])
        let tulos = yhdista(nyt, v, tunniste: { $0.nimi })
        XCTAssertEqual(tulos.map(\.nimi), ["a", "b", "c"])
        XCTAssertEqual(tulos.map(\.avoimia), [1, 20, 3])
    }

    func testPoistetutPois() {
        let nyt = [s("a"), s("b"), s("c")]
        let v = SinceVastaus<SkooppiYhteenveto>(seq: 4, muuttuneet: [], poistetut: ["b"])
        XCTAssertEqual(yhdista(nyt, v, tunniste: { $0.nimi }).map(\.nimi), ["a", "c"])
    }

    func testPoistoJaKorvausYhdessa() {
        let nyt = [s("a", 1), s("b", 1), s("c", 1)]
        let v = SinceVastaus(seq: 5, muuttuneet: [s("a", 9), s("d", 4)], poistetut: ["c"])
        let tulos = yhdista(nyt, v, tunniste: { $0.nimi })
        XCTAssertEqual(tulos.map(\.nimi), ["a", "b", "d"])
        XCTAssertEqual(tulos.first?.avoimia, 9)
    }

    func testTyhjaEroEiMuutaMitaan() {
        let nyt = [s("a"), s("b")]
        let v = SinceVastaus<SkooppiYhteenveto>(seq: 1, muuttuneet: [])
        XCTAssertEqual(yhdista(nyt, v, tunniste: { $0.nimi }), nyt)
    }

    func testSinceVastausDekoodautuu() throws {
        let json = #"{"seq":7,"muuttuneet":[{"nimi":"x","avoimia":1,"vikoja":0,"istuntoja":0}],"poistetut":["y"]}"#
        let v = try JSONDecoder().decode(SinceVastaus<SkooppiYhteenveto>.self, from: Data(json.utf8))
        XCTAssertEqual(v.seq, 7)
        XCTAssertEqual(v.muuttuneet.first?.nimi, "x")
        XCTAssertEqual(v.poistetut, ["y"])
        XCTAssertFalse(v.nollaus)
        let n = try JSONDecoder().decode(SinceVastaus<SkooppiYhteenveto>.self, from: Data(#"{"seq":1,"muuttuneet":[],"poistetut":[],"nollaus":true}"#.utf8))
        XCTAssertTrue(n.nollaus)
    }
}
