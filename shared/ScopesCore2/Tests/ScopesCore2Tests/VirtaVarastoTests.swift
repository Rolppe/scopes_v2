import XCTest
@testable import ScopesCore2

/// Virta ja Varasto MockURLProtocolilla (S-1, S-6).
final class VirtaTests: XCTestCase {
    private func asiakas() -> Asiakas {
        Asiakas(osoite: URL(string: "http://127.0.0.1:18999")!, avain: "testiavain", session: MockURLProtocol.sessio())
    }

    override func tearDown() {
        MockURLProtocol.kasittelija = nil
        super.tearDown()
    }

    func testMuutoksetNollausJaUusintaLastEventIdlla() async throws {
        let pyynnot = Pyynnot()
        let runko = """
        id: 1
        event: muutos
        data: {"seq":1,"polku":"skoopit","id":"a","versio":{"x":1},"aika":"t1"}

        : ka

        id: 2\r
        event: muutos\r
        data: {"seq":2,"polku":"peili","id":"b","versio":{},"aika":"t2"}\r
        \r
        event: nollaus
        data: {"seq":9}


        """
        MockURLProtocol.kasittelija = { req in
            pyynnot.lisaa(req)
            return (MockURLProtocol.vastaus(req, otsikot: ["Content-Type": "text/event-stream"]), Data(runko.utf8))
        }
        let kerays = Kerays()
        let virta = kerays.virta(asiakas())
        virta.aloita(since: nil)
        let saatu = await odota(3) { kerays.nollaukset == [9] }
        XCTAssertTrue(saatu)
        XCTAssertEqual(kerays.muutokset.map(\.seq), [1, 2])
        XCTAssertEqual(kerays.muutokset.map(\.polku), ["skoopit", "peili"])
        XCTAssertEqual(virta.seq, 9)
        XCTAssertEqual(kerays.tilat.first, true)

        // Katko → uusinta 1 s kuluttua Last-Event-ID:llä.
        let uusittu = await odota(4) { pyynnot.kaikki.count >= 2 }
        virta.sulje()
        XCTAssertTrue(uusittu)
        let ensimmainen = try XCTUnwrap(pyynnot.kaikki.first)
        XCTAssertNil(ensimmainen.value(forHTTPHeaderField: "Last-Event-ID"))
        XCTAssertEqual(ensimmainen.value(forHTTPHeaderField: "Accept"), "text/event-stream")
        XCTAssertEqual(ensimmainen.value(forHTTPHeaderField: "Authorization"), "Bearer testiavain")
        XCTAssertEqual(ensimmainen.url?.path, "/api/virta")
        let toinen = pyynnot.kaikki[1]
        XCTAssertEqual(toinen.value(forHTTPHeaderField: "Last-Event-ID"), "9")
        XCTAssertEqual(toinen.url?.query, "since=9")
        XCTAssertEqual(kerays.auki, false)
    }

    func testSinceAlkuarvoLahtee() async throws {
        let pyynnot = Pyynnot()
        MockURLProtocol.kasittelija = { req in
            pyynnot.lisaa(req)
            return (MockURLProtocol.vastaus(req), Data())
        }
        let kerays = Kerays()
        let virta = kerays.virta(asiakas())
        virta.aloita(since: 41)
        let saatu = await odota(3) { !pyynnot.kaikki.isEmpty }
        virta.sulje()
        XCTAssertTrue(saatu)
        XCTAssertEqual(pyynnot.kaikki.first?.value(forHTTPHeaderField: "Last-Event-ID"), "41")
        XCTAssertEqual(virta.seq, 41)
    }

    func test401EiUusintaa() async throws {
        let pyynnot = Pyynnot()
        MockURLProtocol.kasittelija = { req in
            pyynnot.lisaa(req)
            return (MockURLProtocol.vastaus(req, tila: 401), Data(#"{"virhe":"x"}"#.utf8))
        }
        let kerays = Kerays()
        let virta = kerays.virta(asiakas())
        virta.aloita(since: nil)
        try await Task.sleep(nanoseconds: 2_500_000_000)
        virta.sulje()
        XCTAssertEqual(pyynnot.kaikki.count, 1)
        XCTAssertFalse(kerays.auki)
    }

    func testPalvelinvirheUusitaan() async throws {
        let pyynnot = Pyynnot()
        MockURLProtocol.kasittelija = { req in
            pyynnot.lisaa(req)
            return (MockURLProtocol.vastaus(req, tila: 503), Data())
        }
        let kerays = Kerays()
        let virta = kerays.virta(asiakas())
        virta.aloita(since: nil)
        let uusittu = await odota(4) { pyynnot.kaikki.count >= 2 }
        virta.sulje()
        XCTAssertTrue(uusittu)
    }
}

@MainActor
final class VarastoMockTests: XCTestCase {
    override func tearDown() {
        MockURLProtocol.kasittelija = nil
        super.tearDown()
    }

    func testListatSinceErollaJaNollaus() async throws {
        let skoopit = try fixture("skoopit.json")
        let viestit = try fixture("viestit-scopes macos.json")
        let pyynnot = Pyynnot()
        MockURLProtocol.kasittelija = { req in
            pyynnot.lisaa(req)
            let url = try XCTUnwrap(req.url)
            switch (url.path, url.query) {
            case ("/api/terveys", _):
                return (MockURLProtocol.vastaus(req), Data(#"{"ok":true,"v2":true,"seq":5}"#.utf8))
            case ("/api/skoopit", nil):
                return (MockURLProtocol.vastaus(req, otsikot: ["X-Lahde": "ydin"]), skoopit)
            case ("/api/skoopit", "since=5"):
                let eroa = #"{"seq":7,"muuttuneet":[{"nimi":"claude","avoimia":99,"vikoja":0,"istuntoja":0},{"nimi":"uusi","avoimia":1,"vikoja":0,"istuntoja":0}],"poistetut":["claude idea"]}"#
                return (MockURLProtocol.vastaus(req), Data(eroa.utf8))
            case ("/api/skoopit", "since=7"):
                return (MockURLProtocol.vastaus(req), Data(#"{"seq":8,"muuttuneet":[],"poistetut":["uusi"]}"#.utf8))
            case ("/api/skoopit/scopes%20macos/viestit", _), ("/api/skoopit/scopes macos/viestit", _):
                return (MockURLProtocol.vastaus(req), viestit)
            default:
                return (MockURLProtocol.vastaus(req), Data())   // /api/virta: tyhjä virta
            }
        }
        let varasto = Varasto(yhdistysViiveMs: 20)
        let asiakas = Asiakas(osoite: URL(string: "http://127.0.0.1:18999")!, avain: "k", session: MockURLProtocol.sessio())
        await varasto.kaynnista(asiakas: asiakas)
        XCTAssertEqual(varasto.skoopit.count, 92)
        XCTAssertEqual(varasto.yhteys, .auki)

        // Muutos "lahde" → skoopit since=5 -erolla (yhdistetty).
        varasto.kasittele(Muutos(seq: 6, polku: "lahde", id: "istunnot", aika: "t"))
        varasto.kasittele(Muutos(seq: 7, polku: "skoopit", id: "claude", aika: "t"))   // yhdistyy samaan hakuun
        let erotTuli = await odotaMainissa(3) { varasto.skoopit.count == 92 && varasto.skoopit.contains { $0.nimi == "uusi" } }
        XCTAssertTrue(erotTuli)
        XCTAssertEqual(varasto.skoopit.first { $0.nimi == "claude" }?.avoimia, 99)
        XCTAssertFalse(varasto.skoopit.contains { $0.nimi == "claude idea" })
        XCTAssertEqual(varasto.skoopit.last?.nimi, "uusi")
        let erohakuja = pyynnot.kaikki.filter { $0.url?.path == "/api/skoopit" && $0.url?.query == "since=5" }.count
        XCTAssertEqual(erohakuja, 1, "200 ms yhdistys: kaksi muutosta, yksi haku")

        // Viestit: peili-muutos hakee valitun skoopin viestit.
        varasto.valittu = "scopes macos"
        varasto.kasittele(Muutos(seq: 8, polku: "peili", id: "x", aika: "t"))
        let viestitTuli = await odotaMainissa(3) { varasto.viestit["scopes macos"] != nil }
        XCTAssertTrue(viestitTuli)
        XCTAssertEqual(varasto.viestit["scopes macos"]?.viestit.first?.id, "0")
        varasto.pysayta()
    }

    func testAvain401AsettaaYhteydenAvain() async throws {
        MockURLProtocol.kasittelija = { req in
            (MockURLProtocol.vastaus(req, tila: 401), Data(#"{"virhe":"avain puuttuu tai väärä"}"#.utf8))
        }
        let varasto = Varasto()
        let asiakas = Asiakas(osoite: URL(string: "http://127.0.0.1:18999")!, avain: "vaara", session: MockURLProtocol.sessio())
        await varasto.kaynnista(asiakas: asiakas)
        XCTAssertEqual(varasto.yhteys, .avain)
        XCTAssertTrue(varasto.skoopit.isEmpty)
        varasto.pysayta()
    }
}
