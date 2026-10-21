import XCTest
@testable import ScopesCore2

/// T-87: Android-etäohjaus ja palvelin (Ohjaus.swift) fixture-URLProtocolilla. Fixturet (fixture/ohjaus/) ovat T-79-G:n
/// vanhan käytöksen fixtureista (scopes2/adapteri/testidata/toiminnot/): pyyntö ja HTTP-vastaus per tapaus.
final class OhjausTests: XCTestCase {
    private let osoite = URL(string: "http://127.0.0.1:18999")!

    private func asiakas() -> Asiakas {
        Asiakas(osoite: osoite, avain: "testiavain", session: MockURLProtocol.sessio())
    }

    override func tearDown() {
        MockURLProtocol.kasittelija = nil
        super.tearDown()
    }

    /// Fixture: pyyntö ja vastaus; vastauksen `runko` on JSON tai (ruutu, tuotos) {tyyppi, base64}.
    private struct Tapaus: Decodable {
        struct Pyynto: Decodable {
            let metodi: String
            let polku: String
            let runko: JsonArvo?
        }
        let pyynto: Pyynto
        let status: Int
        let runko: JsonArvo?

        /// Vastauksen tavut ja Content-Type: kuvat ja tiedostot raakana (base64 purettuna), muu JSON.
        var vastaus: (data: Data, tyyppi: String) {
            if case .objekti(let o)? = runko, case .teksti(let b64)? = o["base64"], case .teksti(let tyyppi)? = o["tyyppi"],
               let data = Data(base64Encoded: b64) {
                return (data, tyyppi)
            }
            return ((try? JSONEncoder().encode(runko)) ?? Data(), "application/json")
        }
    }

    private func tapaus(_ nimi: String) throws -> Tapaus {
        try JSONDecoder().decode(Tapaus.self, from: try fixture("ohjaus/\(nimi).json"))
    }

    /// Asettaa mockin vastaamaan fixturella ja kirjaa pyynnöt; palauttaa kirjanpidon.
    @discardableResult
    private func vastaaFixturella(_ t: Tapaus, otsikot: [String: String] = [:]) -> Pyynnot {
        let pyynnot = Pyynnot()
        let v = t.vastaus
        MockURLProtocol.kasittelija = { req in
            pyynnot.lisaa(req)
            var o = otsikot
            o["Content-Type"] = v.tyyppi
            return (MockURLProtocol.vastaus(req, tila: t.status, otsikot: o), v.data)
        }
        return pyynnot
    }

    /// Pyyntö vastaa fixturea: metodi, polku kyselyineen, Bearer ja runko (JSON-vertailu; liitteellä raakateksti).
    private func tarkistaPyynto(_ pyynnot: Pyynnot, _ t: Tapaus, tyyppi: String? = nil, file: StaticString = #filePath, line: UInt = #line) throws {
        let req = try XCTUnwrap(pyynnot.kaikki.first, file: file, line: line)
        XCTAssertEqual(pyynnot.kaikki.count, 1, file: file, line: line)
        XCTAssertEqual(req.httpMethod, t.pyynto.metodi, file: file, line: line)
        XCTAssertEqual(req.url?.absoluteString, "http://127.0.0.1:18999" + t.pyynto.polku, file: file, line: line)
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer testiavain", file: file, line: line)
        if let tyyppi { XCTAssertEqual(req.value(forHTTPHeaderField: "Content-Type"), tyyppi, file: file, line: line) }
        switch t.pyynto.runko {
        case .objekti?:
            let runko = try XCTUnwrap(req.runkoData(), file: file, line: line)
            XCTAssertEqual(try JSONDecoder().decode(JsonArvo.self, from: runko), t.pyynto.runko, file: file, line: line)
        case .teksti(let teksti)?:
            XCTAssertEqual(req.runkoData(), Data(teksti.utf8), file: file, line: line)
        default:
            XCTAssertNil(req.runkoData(), file: file, line: line)
        }
    }

    private func odotaVirhe(_ tila: Int, viesti: String?, lahde: String? = nil, file: StaticString = #filePath, line: UInt = #line,
                            _ tyo: () async throws -> Void) async {
        do {
            try await tyo()
            XCTFail("piti heittää ApiVirhe \(tila)", file: file, line: line)
        } catch let v as ApiVirhe {
            XCTAssertEqual(v.tila, tila, file: file, line: line)
            XCTAssertEqual(v.viesti, viesti, file: file, line: line)
            XCTAssertEqual(v.lahde, lahde, file: file, line: line)
        } catch {
            XCTFail("odottamaton virhe: \(error)", file: file, line: line)
        }
    }

    // MARK: Android: tila ja ruutu

    func testAndroidTilaSallii_tuntemattomatKentat() async throws {
        let t = try tapaus("android-tila")
        let pyynnot = vastaaFixturella(t, otsikot: ["X-Lahde": "ydin"])
        let tila = try await asiakas().androidTila()
        XCTAssertEqual(tila, AndroidTila(hereilla: true, heratimme: false, koko: [1080, 2400], kuiva: false))
        try tarkistaPyynto(pyynnot, t)
    }

    func testAndroidRuutuOletusleveys() async throws {
        let t = try tapaus("android-ruutu")
        let pyynnot = vastaaFixturella(t)
        let data = try await asiakas().androidRuutu()
        XCTAssertEqual(data, Data(base64Encoded: "/9j/4AAQSkZJRgABAQAAAQABAAD/2Q=="))
        XCTAssertEqual(pyynnot.kaikki.first?.url?.absoluteString, "http://127.0.0.1:18999/api/android/ruutu?leveys=720")
        XCTAssertEqual(pyynnot.kaikki.first?.httpMethod, "GET")
        XCTAssertEqual(pyynnot.kaikki.first?.value(forHTTPHeaderField: "Authorization"), "Bearer testiavain")
    }

    func testAndroidRuutuLeveys() async throws {
        let t = try tapaus("android-ruutu-leveys")
        let pyynnot = vastaaFixturella(t)
        let data = try await asiakas().androidRuutu(leveys: 360)
        XCTAssertFalse(data.isEmpty)
        try tarkistaPyynto(pyynnot, t)
    }

    func testAndroidRuutuVirheet() async throws {
        for nimi in ["android-ruutu-screencap-epaonnistuu", "android-ruutu-muunnos-epaonnistuu"] {
            let t = try tapaus(nimi)
            vastaaFixturella(t)
            guard case .objekti(let o)? = t.runko, case .teksti(let virhe)? = o["virhe"] else { return XCTFail("fixturen virhe puuttuu: \(nimi)") }
            await odotaVirhe(t.status, viesti: virhe) { _ = try await self.asiakas().androidRuutu() }
        }
    }

    func testAndroidTilaAdapteriAlhaalla503() async throws {
        let t = try tapaus("android-tila-adapteri-alhaalla")
        vastaaFixturella(t, otsikot: ["X-Lahde": "adapteri"])
        await odotaVirhe(503, viesti: "adapteri", lahde: "adapteri") { _ = try await self.asiakas().androidTila() }
    }

    // MARK: Android: toiminnot

    func testAndroidToiminnotRungotJaVastaukset() async throws {
        let kutsut: [(fixture: String, toiminto: String)] = [
            ("android-napauta", "napauta"), ("android-pyyhkaise", "pyyhkaise"), ("android-nappi", "nappi"), ("android-avaa", "avaa"),
            ("android-uusi", "uusi"), ("android-kirjoita-laheta", "kirjoita"), ("android-laheta", "laheta"), ("android-talteen", "talteen"),
        ]
        for (fixture, toiminto) in kutsut {
            let t = try tapaus(fixture)
            let pyynnot = vastaaFixturella(t)
            var tyhjaRunko = false
            if case .objekti(let o)? = t.pyynto.runko { tyhjaRunko = o.isEmpty }
            // avaa, uusi, laheta ja talteen: ilman runkoa lähtee {} (fixturen runko)
            let v: AndroidVastaus
            if tyhjaRunko {
                v = try await asiakas().androidToiminto(toiminto)
            } else {
                v = try await asiakas().androidToiminto(toiminto, runko: t.pyynto.runko ?? JsonArvo.tyhja)
            }
            XCTAssertEqual(v.ok, true, fixture)
            try tarkistaPyynto(pyynnot, t, tyyppi: "application/json")
        }
    }

    func testNapautaPalauttaaPisteen() async throws {
        let t = try tapaus("android-napauta")
        vastaaFixturella(t)
        let v = try await asiakas().androidToiminto("napauta", runko: ["x": 0.5, "y": 0.25])
        XCTAssertEqual(v, AndroidVastaus(ok: true, piste: [540, 600]))
    }

    func testTalteenPalauttaaTekstinJaViestit() async throws {
        let t = try tapaus("android-talteen")
        vastaaFixturella(t)
        let v = try await asiakas().androidToiminto("talteen")
        XCTAssertEqual(v.teksti, "## Minä\n\nMoi Gemini\n\n## Gemini\n\nHei! Miten voin auttaa?\n")
        XCTAssertEqual(v.viestit, [AndroidViesti(rooli: "kayttaja", teksti: "Moi Gemini"), AndroidViesti(rooli: "gemini", teksti: "Hei! Miten voin auttaa?")])
        XCTAssertEqual(v.polku, "<ANDROID>/20261021T080000-gemini.md")
    }

    func testKuivaKomentoKulkeeVastauksessa() async throws {
        let t = try tapaus("android-napauta-kuiva")
        vastaaFixturella(t)
        let v = try await asiakas().androidToiminto("napauta", runko: ["x": 0.5, "y": 0.25])
        XCTAssertEqual(v.kuiva, "input tap 540 600")
    }

    func testToimintoVirheet() async throws {
        // 400 arvo, 409 ei painiketta, 413 liian pitkä, 502 adb ei vastaa, 404 tuntematon toiminto
        let tapaukset: [(fixture: String, toiminto: String)] = [
            ("android-napauta-arvo-virheellinen", "napauta"), ("android-laheta-ei-nappia", "laheta"),
            ("android-kirjoita-liite-odottaa", "kirjoita"), ("android-kirjoita-liian-pitka", "kirjoita"),
            ("android-adb-ei-vastaa", "avaa"), ("android-uusi-ei-nappia", "uusi"), ("android-talteen-ei-keskustelua", "talteen"),
            ("android-tuntematon-toiminto", "ei-ole"), ("android-nappi-tuntematon", "nappi"), ("android-kirjoita-vienti-epaonnistuu", "kirjoita"),
        ]
        for (nimi, toiminto) in tapaukset {
            let t = try tapaus(nimi)
            vastaaFixturella(t)
            guard case .objekti(let o)? = t.runko, case .teksti(let virhe)? = o["virhe"] else { return XCTFail("fixturen virhe puuttuu: \(nimi)") }
            await odotaVirhe(t.status, viesti: virhe) {
                _ = try await self.asiakas().androidToiminto(toiminto, runko: t.pyynto.runko ?? JsonArvo.objekti([:]))
            }
        }
    }

    func testToimintoTila429JaX_Lahde() async throws {
        MockURLProtocol.kasittelija = { req in
            (MockURLProtocol.vastaus(req, tila: 429, otsikot: ["X-Lahde": "adapteri"]), Data(#"{"virhe":"liite on jo käynnissä"}"#.utf8))
        }
        await odotaVirhe(429, viesti: "liite on jo käynnissä", lahde: "adapteri") {
            _ = try await self.asiakas().androidLiite(nimi: "a.txt", data: Data([1]))
        }
    }

    // MARK: Android: liite, tuotokset

    func testLiite() async throws {
        let t = try tapaus("android-liite")
        let pyynnot = vastaaFixturella(t)
        let v = try await asiakas().androidLiite(nimi: "muistio.txt", data: Data("liitteen sisältö".utf8))
        XCTAssertEqual(v, AndroidVastaus(ok: true, nimi: "scopes-080000-muistio.txt", liitetty: true, lahetetty: false))
        try tarkistaPyynto(pyynnot, t, tyyppi: "application/octet-stream")
    }

    func testLiiteTekstinKanssa() async throws {
        let t = try tapaus("android-liite-teksti")
        let pyynnot = vastaaFixturella(t)
        let v = try await asiakas().androidLiite(nimi: "muistio.txt", teksti: "Katso tämä", data: Data("liitteen sisältö".utf8))
        XCTAssertEqual(v.lahetetty, true)
        XCTAssertEqual(v.liitetty, true)
        try tarkistaPyynto(pyynnot, t, tyyppi: "application/octet-stream")
    }

    func testLiiteNimiProsenttikoodataan() async throws {
        let pyynnot = Pyynnot()
        MockURLProtocol.kasittelija = { req in
            pyynnot.lisaa(req)
            return (MockURLProtocol.vastaus(req), Data(#"{"ok":true}"#.utf8))
        }
        _ = try await asiakas().androidLiite(nimi: "kuva 1&x=y.png", teksti: "", data: Data([1, 2, 3]))
        XCTAssertEqual(pyynnot.kaikki.first?.url?.absoluteString, "http://127.0.0.1:18999/api/android/liite?nimi=kuva%201%26x%3Dy.png")
        XCTAssertEqual(pyynnot.kaikki.first?.runkoData(), Data([1, 2, 3]))
    }

    func testLiiteVirheet() async throws {
        for nimi in ["android-liite-tyhja", "android-liite-ei-liitepainiketta", "android-liite-ei-tiedostoa-valitsimessa",
                     "android-liite-push-epaonnistuu", "android-liite-teksti-liian-pitka"] {
            let t = try tapaus(nimi)
            vastaaFixturella(t)
            guard case .objekti(let o)? = t.runko, case .teksti(let virhe)? = o["virhe"] else { return XCTFail("fixturen virhe puuttuu: \(nimi)") }
            await odotaVirhe(t.status, viesti: virhe) { _ = try await self.asiakas().androidLiite(nimi: "muistio.txt", data: Data([1])) }
        }
    }

    func testTuotokset() async throws {
        let t = try tapaus("android-tuotokset")
        let pyynnot = vastaaFixturella(t)
        let lista = try await asiakas().androidTuotokset()
        XCTAssertEqual(lista, [
            AndroidTuotos(polku: "/sdcard/Pictures/kuva.png", nimi: "kuva.png", koko: 99, aika: "2025-10-09T08:55:00.000Z"),
            AndroidTuotos(polku: "/sdcard/Download/raportti.txt", nimi: "raportti.txt", koko: 1234, aika: "2025-10-09T08:53:20.000Z"),
        ])
        XCTAssertEqual(lista.first?.id, "/sdcard/Pictures/kuva.png")
        try tarkistaPyynto(pyynnot, t)
    }

    func testTuotoksetTyhja() async throws {
        vastaaFixturella(try tapaus("android-tuotokset-tyhja"))
        let lista = try await asiakas().androidTuotokset()
        XCTAssertEqual(lista, [])
    }

    func testTuotos() async throws {
        let t = try tapaus("android-tuotos")
        let pyynnot = vastaaFixturella(t)
        let data = try await asiakas().androidTuotos(polku: "/sdcard/Download/raportti.txt")
        XCTAssertEqual(String(decoding: data, as: UTF8.self), "raportin sisältö\n")
        try tarkistaPyynto(pyynnot, t)
    }

    func testTuotosVirheet() async throws {
        let tapaukset: [(String, String)] = [
            ("android-tuotos-ei-loydy", "/sdcard/Download/ei-ole.txt"),
            ("android-tuotos-liian-suuri", "/sdcard/Movies/iso.mp4"),
            ("android-tuotos-vaara-polku", "/data/data/salaisuus.txt"),
        ]
        for (nimi, polku) in tapaukset {
            let t = try tapaus(nimi)
            let pyynnot = vastaaFixturella(t)
            guard case .objekti(let o)? = t.runko, case .teksti(let virhe)? = o["virhe"] else { return XCTFail("fixturen virhe puuttuu: \(nimi)") }
            await odotaVirhe(t.status, viesti: virhe) { _ = try await self.asiakas().androidTuotos(polku: polku) }
            XCTAssertEqual(pyynnot.kaikki.first?.url?.absoluteString, "http://127.0.0.1:18999" + t.pyynto.polku, nimi)
        }
    }

    // MARK: palvelin

    func testLinuxServerTilat() async throws {
        let odotetut: [(String, LinuxServerTila)] = [
            ("linux-tila-linux", LinuxServerTila(tila: "linux", osoite: "192.0.2.99")),
            ("linux-tila-sammuksissa", LinuxServerTila(tila: "sammuksissa")),
            ("linux-tila-windows", LinuxServerTila(tila: "windows", osoite: "192.0.2.99")),
            ("linux-tila-windows-wifi", LinuxServerTila(tila: "windows", osoite: "192.0.2.99")),
        ]
        for (nimi, tila) in odotetut {
            let t = try tapaus(nimi)
            let pyynnot = vastaaFixturella(t)
            let v = try await asiakas().linuxServer()
            XCTAssertEqual(v, tila, nimi)
            try tarkistaPyynto(pyynnot, t)
        }
    }

    func testLinuxSammuta() async throws {
        let t = try tapaus("linux-sammuta-linux")
        let pyynnot = vastaaFixturella(t)
        let v = try await asiakas().linuxToiminto("sammuta")
        XCTAssertEqual(v, LinuxServerVastaus(tila: "sammuu", lahto: "linux", viesti: "palvelin sammuu"))
        try tarkistaPyynto(pyynnot, t, tyyppi: "application/json")
    }

    func testLinuxKaynnistaVastaukset() async throws {
        let odotetut: [(String, String, String)] = [
            ("linux-kaynnista-sammuksissa", "linux", "sammuksissa"),
            ("linux-kaynnista-windows", "vaihtaa", "windows"),
            ("linux-kaynnista-linux", "linux", "linux"),
            ("linux-kaynnista-sammuksissa-windows-vastaa", "vaihtaa", "sammuksissa"),
        ]
        for (nimi, tila, lahto) in odotetut {
            let t = try tapaus(nimi)
            let pyynnot = vastaaFixturella(t)
            let v = try await asiakas().linuxToiminto(.kaynnista)
            XCTAssertEqual(v.tila, tila, nimi)
            XCTAssertEqual(v.lahto, lahto, nimi)
            try tarkistaPyynto(pyynnot, t, tyyppi: "application/json")
        }
    }

    func testLinuxKuivaKomento() async throws {
        vastaaFixturella(try tapaus("linux-sammuta-kuiva"))
        let v = try await asiakas().linuxToiminto("sammuta")
        XCTAssertEqual(v.kuiva, "ssh -o ConnectTimeout=5 -o BatchMode=yes palvelin sudo -n /usr/sbin/poweroff")
    }

    func testLinuxVirhestatukset409_429_502_503_504() async throws {
        let tapaukset: [(fixture: String, toiminto: LinuxToiminto)] = [
            ("linux-sammuta-sammuksissa", .sammuta),                       // 409 jo sammuksissa
            ("linux-sammuta-windows", .sammuta),                           // 409 Windows käynnissä
            ("linux-sammuta-toinen-toiminto-kaynnissa", .sammuta),         // 429 yksi toiminto kerrallaan
            ("linux-kaynnista-toinen-toiminto-kaynnissa", .kaynnista),     // 429
            ("linux-sammuta-tunnistusvirhe", .sammuta),                    // 502 ssh
            ("linux-kaynnista-sammuksissa-herata-epaonnistuu", .kaynnista), // 504 PC ei vastannut
            ("linux-sammuta-adapteri-alhaalla", .sammuta),                 // 503 ydin: adapteri ei vastaa
        ]
        for (nimi, toiminto) in tapaukset {
            let t = try tapaus(nimi)
            vastaaFixturella(t)
            guard case .objekti(let o)? = t.runko, case .teksti(let virhe)? = o["virhe"] else { return XCTFail("fixturen virhe puuttuu: \(nimi)") }
            XCTAssertTrue([409, 429, 502, 503, 504].contains(t.status), nimi)
            await odotaVirhe(t.status, viesti: virhe) { _ = try await self.asiakas().linuxToiminto(toiminto) }
        }
    }

    func testLinuxTila503JaTuntematonToiminto() async throws {
        vastaaFixturella(try tapaus("linux-tila-adapteri-alhaalla"), otsikot: ["X-Lahde": "ydin"])
        await odotaVirhe(503, viesti: "adapteri", lahde: "ydin") { _ = try await self.asiakas().linuxServer() }
        // tuntematon toiminto ei lähde verkkoon
        let pyynnot = Pyynnot()
        MockURLProtocol.kasittelija = { req in pyynnot.lisaa(req); return (MockURLProtocol.vastaus(req), Data("{}".utf8)) }
        await odotaVirhe(0, viesti: "tuntematon palvelin-toiminto: ei-ole") { _ = try await self.asiakas().linuxToiminto("ei-ole") }
        XCTAssertEqual(pyynnot.kaikki.count, 0)
    }

    func testToiminnonVirheTunnetaanSilloinkinKunRunkoEiOleJson() async throws {
        MockURLProtocol.kasittelija = { req in (MockURLProtocol.vastaus(req, tila: 503), Data("Service Unavailable".utf8)) }
        await odotaVirhe(503, viesti: nil) { _ = try await self.asiakas().linuxToiminto("kaynnista") }
    }

    // MARK: kosketuspiste

    func testOsuusLetterboxHuomioidaan() throws {
        // alue 400×400, kuva 100×200 → aspectFit 200×400 keskellä (vasen reuna x=100)
        let alue = CGSize(width: 400, height: 400), kuva = CGSize(width: 100, height: 200)
        let keski = try XCTUnwrap(AndroidOsuus.laske(piste: CGPoint(x: 200, y: 200), alue: alue, kuva: kuva))
        XCTAssertEqual(keski, AndroidOsuus(x: 0.5, y: 0.5))
        XCTAssertTrue(keski.kuvassa)
        let reuna = try XCTUnwrap(AndroidOsuus.laske(piste: CGPoint(x: 50, y: 100), alue: alue, kuva: kuva))
        XCTAssertEqual(reuna, AndroidOsuus(x: -0.25, y: 0.25))
        XCTAssertFalse(reuna.kuvassa, "letterbox-alueen napautus ei lähde laitteelle")
        XCTAssertEqual(reuna.rajattu, AndroidOsuus(x: 0, y: 0.25))
        let ala = try XCTUnwrap(AndroidOsuus.laske(piste: CGPoint(x: 300, y: 400), alue: alue, kuva: kuva))
        XCTAssertEqual(ala, AndroidOsuus(x: 1, y: 1))
        XCTAssertTrue(ala.kuvassa)
    }

    func testOsuusEiKaytaNollakokoa() {
        XCTAssertNil(AndroidOsuus.laske(piste: .zero, alue: CGSize(width: 0, height: 10), kuva: CGSize(width: 1, height: 1)))
        XCTAssertNil(AndroidOsuus.laske(piste: .zero, alue: CGSize(width: 10, height: 10), kuva: CGSize(width: 1, height: 0)))
    }
}

/// Fixturen mielivaltainen JSON-arvo (pyyntörunko ja vastaus); Equatable vertailuun, Codable koodaukseen.
enum JsonArvo: Codable, Equatable {
    case tyhja
    case totuus(Bool)
    case luku(Double)
    case teksti(String)
    case lista([JsonArvo])
    case objekti([String: JsonArvo])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .tyhja }
        else if let b = try? c.decode(Bool.self) { self = .totuus(b) }
        else if let n = try? c.decode(Double.self) { self = .luku(n) }
        else if let s = try? c.decode(String.self) { self = .teksti(s) }
        else if let l = try? c.decode([JsonArvo].self) { self = .lista(l) }
        else { self = .objekti(try c.decode([String: JsonArvo].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .tyhja: try c.encodeNil()
        case .totuus(let b): try c.encode(b)
        case .luku(let n): try c.encode(n)
        case .teksti(let s): try c.encode(s)
        case .lista(let l): try c.encode(l)
        case .objekti(let o): try c.encode(o)
        }
    }
}
