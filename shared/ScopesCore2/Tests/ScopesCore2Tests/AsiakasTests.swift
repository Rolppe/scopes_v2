import XCTest
@testable import ScopesCore2

/// (c) Asiakas MockURLProtocolilla.
final class AsiakasTests: XCTestCase {
    private let osoite = URL(string: "http://127.0.0.1:18999")!

    private func asiakas() -> Asiakas {
        Asiakas(osoite: osoite, avain: "testiavain", session: MockURLProtocol.sessio())
    }

    override func tearDown() {
        MockURLProtocol.kasittelija = nil
        super.tearDown()
    }

    func testBearerPolkuJaProsenttikoodaus() async throws {
        let pyynnot = Pyynnot()
        let runko = try fixture("viestit-scopes macos.json")
        MockURLProtocol.kasittelija = { req in
            pyynnot.lisaa(req)
            return (MockURLProtocol.vastaus(req, otsikot: ["X-Lahde": "ydin"]), runko)
        }
        let polku = "/api/skoopit/\(Asiakas.koodaa("scopes macos"))/viestit"
        let r: (SkooppiViestit, lahde: String?) = try await asiakas().hae(polku)
        XCTAssertEqual(r.0.nimi, "scopes macos")
        XCTAssertEqual(r.lahde, "ydin")
        let req = try XCTUnwrap(pyynnot.kaikki.first)
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer testiavain")
        XCTAssertEqual(req.httpMethod, "GET")
        XCTAssertEqual(req.url?.absoluteString, "http://127.0.0.1:18999/api/skoopit/scopes%20macos/viestit")
    }

    func testKoodaaEiJataSkaaloja() {
        XCTAssertEqual(Asiakas.koodaa("scopes macos"), "scopes%20macos")
        XCTAssertEqual(Asiakas.koodaa("a/b?c#d"), "a%2Fb%3Fc%23d")
        XCTAssertEqual(Asiakas.koodaa("ääkkönen"), "%C3%A4%C3%A4kk%C3%B6nen")
    }

    func testPostRunkoJaSisaltotyyppi() async throws {
        let pyynnot = Pyynnot()
        MockURLProtocol.kasittelija = { req in
            pyynnot.lisaa(req)
            return (MockURLProtocol.vastaus(req), Data(#"{"istunto":"abc"}"#.utf8))
        }
        let r: (LahetysVastausKoe, lahde: String?) = try await asiakas().hae("/api/skoopit/x/viesti", metodi: "POST", runko: ["teksti": "hei"])
        XCTAssertEqual(r.0.istunto, "abc")
        XCTAssertNil(r.lahde)
        let req = try XCTUnwrap(pyynnot.kaikki.first)
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try XCTUnwrap(req.runkoData())
        XCTAssertEqual(try JSONDecoder().decode([String: String].self, from: body), ["teksti": "hei"])
    }

    func testApiVirheJaXLahde() async throws {
        MockURLProtocol.kasittelija = { req in
            (MockURLProtocol.vastaus(req, tila: 401, otsikot: ["X-Lahde": "silta"]), Data(#"{"virhe":"avain puuttuu tai väärä"}"#.utf8))
        }
        do {
            let _: (TyhjaVastaus, lahde: String?) = try await asiakas().hae("/api/skoopit")
            XCTFail("piti heittää ApiVirhe")
        } catch let v as ApiVirhe {
            XCTAssertEqual(v.tila, 401)
            XCTAssertEqual(v.viesti, "avain puuttuu tai väärä")
            XCTAssertEqual(v.lahde, "silta")
        }
    }

    func testApiVirheIlmanRunkoa() async throws {
        MockURLProtocol.kasittelija = { req in (MockURLProtocol.vastaus(req, tila: 503), Data()) }
        do {
            let _: (TyhjaVastaus, lahde: String?) = try await asiakas().hae("/api/skoopit")
            XCTFail("piti heittää ApiVirhe")
        } catch let v as ApiVirhe {
            XCTAssertEqual(v.tila, 503)
            XCTAssertNil(v.viesti)
            XCTAssertNil(v.lahde)
        }
    }

    func testNdjsonKolmePalaaJaValmis() async throws {
        let pyynnot = Pyynnot()
        let runko = """
        {"tyyppi":"teksti","teksti":"Ho"}
        {"tyyppi":"teksti","teksti":"pe"}

        {"tyyppi":"teksti","teksti":"a"}
        {"tyyppi":"valmis","vastaus":"Hopea","keskustelu":"k1"}

        """
        MockURLProtocol.kasittelija = { req in
            pyynnot.lisaa(req)
            return (MockURLProtocol.vastaus(req, otsikot: ["Content-Type": "application/x-ndjson"]), Data(runko.utf8))
        }
        var tapahtumat: [ChatTapahtuma] = []
        for try await t in asiakas().virta("/api/chat/virta", runko: ["teksti": "hei"]) { tapahtumat.append(t) }
        XCTAssertEqual(tapahtumat.count, 4)
        XCTAssertEqual(tapahtumat.prefix(3).compactMap(\.teksti).joined(), "Hopea")
        XCTAssertEqual(tapahtumat.last?.tyyppi, "valmis")
        XCTAssertEqual(tapahtumat.last?.keskustelu, "k1")
        let req = try XCTUnwrap(pyynnot.kaikki.first)
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer testiavain")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Accept"), "application/x-ndjson")
        XCTAssertEqual(req.url?.path, "/api/chat/virta")
    }

    func testNdjsonVirhe() async throws {
        MockURLProtocol.kasittelija = { req in
            (MockURLProtocol.vastaus(req, tila: 401, otsikot: ["X-Lahde": "ydin"]), Data(#"{"virhe":"ei"}"#.utf8))
        }
        do {
            for try await _ in asiakas().virta("/api/chat/virta", runko: ["teksti": "hei"]) {}
            XCTFail("piti heittää ApiVirhe")
        } catch let v as ApiVirhe {
            XCTAssertEqual(v.tila, 401)
            XCTAssertEqual(v.viesti, "ei")
            XCTAssertEqual(v.lahde, "ydin")
        }
    }

    func testLiite() async throws {
        let pyynnot = Pyynnot()
        MockURLProtocol.kasittelija = { req in
            pyynnot.lisaa(req)
            return (MockURLProtocol.vastaus(req), Data(#"{"polku":"/data/liitteet/abc/kuva_1.png","koko":3,"sha256":"abc","solmu":"palvelin"}"#.utf8))
        }
        let v = try await asiakas().liite(skooppi: "scopes macos", nimi: "kuva 1.png", data: Data([1, 2, 3]))
        XCTAssertEqual(v, LiiteVastaus(polku: "/data/liitteet/abc/kuva_1.png", koko: 3, sha256: "abc", solmu: "palvelin"))
        let req = try XCTUnwrap(pyynnot.kaikki.first)
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.url?.absoluteString, "http://127.0.0.1:18999/api/skoopit/scopes%20macos/liite?nimi=kuva%201.png")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Content-Type"), "application/octet-stream")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer testiavain")
        XCTAssertEqual(req.runkoData(), Data([1, 2, 3]))
    }
}

struct LahetysVastausKoe: Decodable { let istunto: String }
