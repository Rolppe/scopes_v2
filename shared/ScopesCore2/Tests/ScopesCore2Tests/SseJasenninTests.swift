import XCTest
@testable import ScopesCore2

/// (a) SseJasennin pätkityillä syötteillä.
final class SseJasenninTests: XCTestCase {
    private let muutos1 = "id: 1\nevent: muutos\ndata: {\"seq\":1}\n\n"

    func testYksiKehys() {
        var j = SseJasennin()
        let k = j.syota(muutos1)
        XCTAssertEqual(k, [SseKehys(id: "1", tapahtuma: "muutos", data: "{\"seq\":1}")])
    }

    func testKehysEiValmisEnnenTyhjaaRivia() {
        var j = SseJasennin()
        XCTAssertTrue(j.syota("id: 1\nevent: muutos\ndata: x\n").isEmpty)
        XCTAssertEqual(j.syota("\n").count, 1)
    }

    func testKommentitOhi() {
        var j = SseJasennin()
        XCTAssertTrue(j.syota(": ka\n\n").isEmpty)
        let k = j.syota(": ka\n" + muutos1 + ": ka\n\n")
        XCTAssertEqual(k.count, 1)
        XCTAssertEqual(k.first?.tapahtuma, "muutos")
    }

    func testMonirivinenData() {
        var j = SseJasennin()
        let k = j.syota("event: x\ndata: a\ndata: b\ndata:c\n\n")
        XCTAssertEqual(k, [SseKehys(id: nil, tapahtuma: "x", data: "a\nb\nc")])
    }

    func testOletustapahtumaOnMessage() {
        var j = SseJasennin()
        XCTAssertEqual(j.syota("data: hei\n\n"), [SseKehys(id: nil, tapahtuma: "message", data: "hei")])
    }

    func testCRLF() {
        var j = SseJasennin()
        let k = j.syota("id: 5\r\nevent: muutos\r\ndata: {\"seq\":5}\r\n\r\n")
        XCTAssertEqual(k, [SseKehys(id: "5", tapahtuma: "muutos", data: "{\"seq\":5}")])
    }

    func testYksinaisetCR() {
        var j = SseJasennin()
        XCTAssertEqual(j.syota("event: a\rdata: b\r\r").count, 1)
    }

    func testPatkitysTavuttain() {
        let syote = muutos1 + ": ka\n\n" + "id: 2\r\nevent: muutos\r\ndata: {\"seq\":2}\r\n\r\n" + "event: nollaus\ndata: {\"seq\":9}\n\n"
        var kokonainen = SseJasennin()
        let odotettu = kokonainen.syota(syote)
        XCTAssertEqual(odotettu.count, 3)

        var j = SseJasennin()
        var tulos: [SseKehys] = []
        for tavu in Data(syote.utf8) { tulos += j.syota(Data([tavu])) }
        XCTAssertEqual(tulos, odotettu)
    }

    func testPatkitysJokaisestaKohdasta() {
        let syote = muutos1 + "id: 2\r\nevent: muutos\r\ndata: {\"seq\":2}\r\n\r\n"
        var kokonainen = SseJasennin()
        let odotettu = kokonainen.syota(syote)
        let tavut = Array(syote.utf8)
        for kohta in 0...tavut.count {
            var j = SseJasennin()
            let tulos = j.syota(Data(tavut[0..<kohta])) + j.syota(Data(tavut[kohta...]))
            XCTAssertEqual(tulos, odotettu, "katko kohdassa \(kohta)")
        }
    }

    func testMonitavuinenMerkkiKatkeaa() {
        let syote = "data: ääkköset ✓\n\n"
        let tavut = Array(syote.utf8)
        for kohta in 0...tavut.count {
            var j = SseJasennin()
            let tulos = j.syota(Data(tavut[0..<kohta])) + j.syota(Data(tavut[kohta...]))
            XCTAssertEqual(tulos.first?.data, "ääkköset ✓", "katko kohdassa \(kohta)")
        }
    }

    func testTyhjaDataEiLahetaKehysta() {
        var j = SseJasennin()
        XCTAssertTrue(j.syota("event: x\n\n").isEmpty)
        // Edellinen event-nimi ei vuoda seuraavaan kehykseen.
        XCTAssertEqual(j.syota("data: y\n\n"), [SseKehys(id: nil, tapahtuma: "message", data: "y")])
    }
}
