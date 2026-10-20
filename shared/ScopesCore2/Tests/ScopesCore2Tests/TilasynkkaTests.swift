import XCTest
@testable import ScopesCore2

/// T-52: viiveiden yhdistäminen, kaiun ohitus, lukemattomien laskenta ja kuittauksen suurin-voittaa.
@MainActor
final class TilasynkkaTests: XCTestCase {
    private final class Loki: @unchecked Sendable {
        private let lukko = NSLock()
        private var rivit: [(String, TilaArvo)] = []
        func lisaa(_ avain: String, _ arvo: TilaArvo) { lukko.lock(); rivit.append((avain, arvo)); lukko.unlock() }
        var kaikki: [(String, TilaArvo)] { lukko.lock(); defer { lukko.unlock() }; return rivit }
    }

    private func synkka(laite: String = "mac-a", headless: Bool = false, viive: UInt64 = 60, loki: Loki) -> Tilasynkka {
        let t = Tilasynkka(laite: laite, headless: headless, viiveMs: { _ in viive })
        t.lahetin = { avain, arvo in loki.lisaa(avain, arvo) }
        return t
    }

    private func odota(_ s: Double = 3, _ ehto: () -> Bool) async -> Bool {
        let loppu = Date().addingTimeInterval(s)
        while Date() < loppu {
            if ehto() { return true }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return ehto()
    }

    // --- viiveet (S-4) ---

    func testAvainkohtaisetViiveet() {
        XCTAssertEqual(TilaAvain.viiveMs("valittu-skooppi"), 0)
        XCTAssertEqual(TilaAvain.viiveMs("luonnos/test"), 1_000)
        XCTAssertEqual(TilaAvain.viiveMs("vierityskohta/test"), 2_000)
        XCTAssertEqual(TilaAvain.viiveMs("suodatin"), 1_000)
        XCTAssertEqual(TilaAvain.viiveMs("piilotukset"), 1_000)
        XCTAssertEqual(TilaAvain.viiveMs("kuittaus/test"), 0)
    }

    func testViiveenAikanaViimeisinArvoVoittaaJaLahtee() async {
        let loki = Loki()
        let t = synkka(loki: loki)
        t.kirjoita("luonnos/test", .teksti("a"))
        t.kirjoita("luonnos/test", .teksti("ab"))
        t.kirjoita("luonnos/test", .teksti("abc"))
        XCTAssertEqual(t.teksti("luonnos/test"), "abc", "paikallinen arvo heti")
        XCTAssertTrue(loki.kaikki.isEmpty, "ei lähetystä viiveen aikana")
        let valmis = await odota { !loki.kaikki.isEmpty }
        XCTAssertTrue(valmis)
        try? await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(loki.kaikki.count, 1)
        XCTAssertEqual(loki.kaikki.first?.0, "luonnos/test")
        XCTAssertEqual(loki.kaikki.first?.1, .teksti("abc"))
    }

    func testEriAvaimillaOmaViive() async {
        let loki = Loki()
        let t = synkka(loki: loki)
        t.kirjoita("luonnos/a", .teksti("1"))
        t.kirjoita("luonnos/b", .teksti("2"))
        _ = await odota { loki.kaikki.count == 2 }
        XCTAssertEqual(Set(loki.kaikki.map(\.0)), ["luonnos/a", "luonnos/b"])
    }

    func testNollaViiveLahettaaHeti() async {
        let loki = Loki()
        let t = synkka(viive: 0, loki: loki)
        t.kirjoita("valittu-skooppi", .teksti("test"))
        let valmis = await odota(1) { loki.kaikki.count == 1 }
        XCTAssertTrue(valmis)
    }

    func testSamaArvoEiLahetaUudelleen() async {
        let loki = Loki()
        let t = synkka(viive: 0, loki: loki)
        t.kirjoita("valittu-skooppi", .teksti("test"))
        _ = await odota { loki.kaikki.count == 1 }
        t.kirjoita("valittu-skooppi", .teksti("test"))
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(loki.kaikki.count, 1)
    }

    func testTyhjennaLahettaaOdottavatHeti() async {
        let loki = Loki()
        let t = synkka(viive: 5_000, loki: loki)
        t.kirjoita("vierityskohta/test", .teksti("s:7"))
        await t.tyhjenna()
        XCTAssertEqual(loki.kaikki.count, 1)
        XCTAssertEqual(loki.kaikki.first?.1, .teksti("s:7"))
    }

    // --- kaiun ohitus ---

    func testOmanLaitteenMuutosOhitetaanToisenSovelletaan() async {
        let loki = Loki()
        let t = synkka(laite: "mac-a", loki: loki)
        t.hakija = { avain in .init(avain: avain, arvo: .teksti("oma"), laite: "mac-a") }
        await t.sovella(Muutos(seq: 1, polku: "tila", id: "valittu-skooppi", aika: "t"))
        XCTAssertNil(t.teksti("valittu-skooppi"), "kaiku ohitettu")
        t.hakija = { avain in .init(avain: avain, arvo: .teksti("vieras"), laite: "ios-b") }
        await t.sovella(Muutos(seq: 2, polku: "tila", id: "valittu-skooppi", aika: "t"))
        XCTAssertEqual(t.teksti("valittu-skooppi"), "vieras")
        await t.sovella(Muutos(seq: 3, polku: "muu", id: "valittu-skooppi", aika: "t"))
    }

    func testPoistettuAvainTyhjentaaArvon() async {
        let t = synkka(loki: Loki())
        t.hakija = { avain in .init(avain: avain, arvo: .teksti("x"), laite: "ios-b") }
        await t.sovella(Muutos(seq: 1, polku: "tila", id: "luonnos/test", aika: "t"))
        XCTAssertEqual(t.teksti("luonnos/test"), "x")
        t.hakija = { _ in nil }
        await t.sovella(Muutos(seq: 2, polku: "tila", id: "luonnos/test", aika: "t"))
        XCTAssertNil(t.arvo("luonnos/test"))
        t.hakija = { avain in .init(avain: avain, arvo: .tyhja, laite: "ios-b") }
        t.kirjoita("luonnos/test", .teksti("y"), viiveMs: 0)
        await t.tyhjenna()
        await t.sovella(Muutos(seq: 3, polku: "tila", id: "luonnos/test", aika: "t"))
        XCTAssertNil(t.arvo("luonnos/test"), "null-arvo = ei arvoa")
    }

    func testOdottavaOmaMuutosVoittaaSaapuvan() async {
        let t = synkka(viive: 5_000, loki: Loki())
        t.kirjoita("luonnos/test", .teksti("kesken"))
        t.hakija = { avain in .init(avain: avain, arvo: .teksti("vanha"), laite: "ios-b") }
        await t.sovella(Muutos(seq: 1, polku: "tila", id: "luonnos/test", aika: "t"))
        XCTAssertEqual(t.teksti("luonnos/test"), "kesken")
    }

    // --- headless ---

    func testHeadlessEiLahetaEikaSovellaUIAvaimia() async {
        let loki = Loki()
        let t = synkka(headless: true, viive: 0, loki: loki)
        t.kirjoita("luonnos/test", .teksti("salainen"))
        t.kirjoita("valittu-skooppi", .teksti("test"))
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertTrue(loki.kaikki.isEmpty, "UI-avaimia ei lähetetä")
        XCTAssertEqual(t.teksti("luonnos/test"), "salainen", "paikallinen arvo säilyy")
        t.hakija = { avain in .init(avain: avain, arvo: .teksti("vieras"), laite: "ios-b") }
        await t.sovella(Muutos(seq: 1, polku: "tila", id: "valittu-skooppi", aika: "t"))
        XCTAssertEqual(t.teksti("valittu-skooppi"), "test", "UI-avainta ei sovelleta")
        t.kirjoita("kuittaus/test", .luku(5))
        _ = await odota(1) { loki.kaikki.count == 1 }
        XCTAssertEqual(loki.kaikki.map(\.0), ["kuittaus/test"], "kuittaus synkataan headlessinä")
    }

    func testOnUIAvain() {
        for a in ["valittu-skooppi", "agy-valinta", "piilotukset", "suodatin", "luonnos/x", "vierityskohta/x", "purku-valinta/x"] {
            XCTAssertTrue(TilaAvain.onUI(a), a)
        }
        for a in ["kuittaus/x", "asetukset/x", "koe/x"] { XCTAssertFalse(TilaAvain.onUI(a), a) }
    }

    // --- kuittaus ja lukemattomat ---

    private func viesti(_ id: String, rooli: String = "avustaja") -> Viesti {
        Viesti(rooli: rooli, teksti: "t", id: id)
    }

    func testRivinroJaLukemattomat() {
        XCTAssertEqual(TilaAvain.rivinro("sess1:12"), 12)
        XCTAssertEqual(TilaAvain.rivinro("7"), 7)
        XCTAssertNil(TilaAvain.rivinro("x:y"))
        let v = [viesti("s:1"), viesti("s:2"), viesti("s:3", rooli: "kayttaja"), viesti("s:4"), viesti("s:5")]
        XCTAssertEqual(TilaAvain.lukemattomia(v, kuittaus: nil), 4, "oma viesti (s:3) ei ole lukematon")
        XCTAssertEqual(TilaAvain.lukemattomia(v, kuittaus: 2), 2)
        XCTAssertEqual(TilaAvain.lukemattomia(v, kuittaus: 5), 0)
        XCTAssertEqual(TilaAvain.suurinRivinro(v), 5)
    }

    func testKuittausSuurinVoittaaPaikallisesti() async {
        let loki = Loki()
        let t = synkka(viive: 0, loki: loki)
        t.kuittaa(skooppi: "test", viestit: [viesti("s:3"), viesti("s:9")])
        XCTAssertEqual(t.luku("kuittaus/test"), 9)
        t.kirjoita("kuittaus/test", .luku(4))
        XCTAssertEqual(t.luku("kuittaus/test"), 9, "pienempi ei korvaa")
        t.hakija = { avain in .init(avain: avain, arvo: .luku(6), laite: "ios-b") }
        await t.sovella(Muutos(seq: 1, polku: "tila", id: "kuittaus/test", aika: "t"))
        XCTAssertEqual(t.luku("kuittaus/test"), 9, "saapuva pienempi ei korvaa")
        t.hakija = { avain in .init(avain: avain, arvo: .luku(12), laite: "ios-b") }
        await t.sovella(Muutos(seq: 2, polku: "tila", id: "kuittaus/test", aika: "t"))
        XCTAssertEqual(t.luku("kuittaus/test"), 12, "saapuva suurempi voittaa")
    }

    func testVarastonLukemattomatSeuraavatKuittausta() async {
        let t = synkka(loki: Loki())
        let varasto = Varasto(tila: t)
        XCTAssertNil(varasto.lukemattomia("test"), "viestejä ei ladattu")
        t.hakija = { avain in .init(avain: avain, arvo: .luku(1), laite: "ios-b") }
        await t.sovella(Muutos(seq: 1, polku: "tila", id: "kuittaus/test", aika: "t"))
        XCTAssertEqual(t.luku("kuittaus/test"), 1)
    }

    // --- käynnistys ja polut ---

    func testAlkulatausSoveltaaMyosOmanLaitteenArvot() async {
        let t = synkka(laite: "mac-a", loki: Loki())
        t.listaaja = { etuliite in
            etuliite == "luonnos/" ? [.init(avain: "luonnos/test", arvo: .teksti("palautettu"), laite: "mac-a")] : []
        }
        t.hakija = { avain in avain == "valittu-skooppi" ? .init(avain: avain, arvo: .teksti("test"), laite: "ios-b") : nil }
        await t.lataaAlku()
        XCTAssertEqual(t.teksti("luonnos/test"), "palautettu")
        XCTAssertEqual(t.teksti("valittu-skooppi"), "test")
    }

    func testPolkuKoodaaSegmentitMuttaEiKauttaviivaa() {
        XCTAssertEqual(Tilasynkka.polku("luonnos/scopes ios"), "/api/tila/luonnos/scopes%20ios")
        XCTAssertEqual(Tilasynkka.polku("valittu-skooppi"), "/api/tila/valittu-skooppi")
    }

    func testTilaArvoJSON() throws {
        let d = JSONDecoder()
        XCTAssertEqual(try d.decode(TilaArvo.self, from: Data("\"a\"".utf8)), .teksti("a"))
        XCTAssertEqual(try d.decode(TilaArvo.self, from: Data("7".utf8)), .luku(7))
        XCTAssertEqual(try d.decode(TilaArvo.self, from: Data("null".utf8)), .tyhja)
        XCTAssertEqual(String(data: try JSONEncoder().encode(TilaArvo.luku(3)), encoding: .utf8), "3")
        let v = try d.decode(Tilasynkka.TilaVastaus.self, from: Data(#"{"avain":"a","arvo":"x","aika":"t","laite":"mac-a"}"#.utf8))
        XCTAssertEqual(v, .init(avain: "a", arvo: .teksti("x"), laite: "mac-a"))
    }
}
