import XCTest
import SwiftUI
import ScopesCore2
@testable import ScopesUI2

final class ScopesUI2Tests: XCTestCase {
    // --- Näkymät kääntyvät ja rakentuvat (ei Keychainia: avainta luetaan vasta .task:ssa) ---

    @MainActor func testNakymatRakentuvat() {
        let varasto = Varasto()
        let asiakas = Asiakas(osoite: URL(string: "http://127.0.0.1:1")!, avain: "koe")
        _ = JuuriNakyma().body
        _ = Sivupalkki(varasto: varasto, valinta: .constant(nil)).body
        _ = SkoopinViestit(varasto: varasto, asiakas: asiakas, skooppi: "test").body
        _ = Kysymyskortti(kysymys: Kysymys(kysymys: "?", vaihtoehdot: [Vaihtoehto(nimi: "a")]), vastaus: { _ in }).body
        _ = Lahetys(asiakas: asiakas, skooppi: "test").body
        _ = ChatNakyma(asiakas: asiakas).body
        _ = InfraNakyma(asiakas: asiakas).body
        _ = AsetuksetNakyma(varasto: varasto, asiakas: asiakas).body
        _ = Viestikupla(viesti: Viesti(rooli: "kayttaja", teksti: "hei")).body
    }

    // --- Sivupalkin suodatus ---

    private let skoopit = [
        SkooppiYhteenveto(nimi: "scopes macos", seuraava: "T-48", avoimia: 2, istuntoja: 1, tila: "kasittely"),
        SkooppiYhteenveto(nimi: "scopes ios", avoimia: 0, istuntoja: 0, tila: "pakattu"),
        SkooppiYhteenveto(nimi: "infra", istuntoja: 1, tila: "odottaa"),
        SkooppiYhteenveto(nimi: "models", istuntoja: 1, tila: "kysely"),
        SkooppiYhteenveto(nimi: "claude")
    ]

    func testSuodatusHaku() {
        XCTAssertEqual(SkooppiSuodatus.suodata(skoopit, haku: "SCOPES", suodatus: .kaikki).map(\.nimi), ["scopes macos", "scopes ios"])
        XCTAssertEqual(SkooppiSuodatus.suodata(skoopit, haku: "  ", suodatus: .kaikki).count, 5)
        XCTAssertTrue(SkooppiSuodatus.suodata(skoopit, haku: "ei ole", suodatus: .kaikki).isEmpty)
    }

    func testSuodatusTilat() {
        XCTAssertEqual(SkooppiSuodatus.suodata(skoopit, haku: "", suodatus: .odottaa).map(\.nimi), ["infra", "models"])
        XCTAssertEqual(SkooppiSuodatus.suodata(skoopit, haku: "", suodatus: .pakattu).map(\.nimi), ["scopes ios", "claude"])
        XCTAssertEqual(SkooppiSuodatus.suodata(skoopit, haku: "", suodatus: .aktiiviset).map(\.nimi), ["scopes macos", "infra", "models"])
        XCTAssertEqual(SkooppiSuodatus.suodata(skoopit, haku: "scopes", suodatus: .pakattu).map(\.nimi), ["scopes ios"])
    }

    // --- Kysymyskortin vastausteksti ---

    func testVastaustekstiYksivalinta() {
        let k = Kysymys(kysymys: "Mikä?", monivalinta: false, vaihtoehdot: [Vaihtoehto(nimi: "A"), Vaihtoehto(nimi: "B")])
        XCTAssertEqual(Vastausteksti.muodosta(k, valitut: [], yksi: "B"), "B")
    }

    func testVastaustekstiMonivalintaJarjestyksessa() {
        let k = Kysymys(kysymys: "Mitkä?", monivalinta: true, vaihtoehdot: [Vaihtoehto(nimi: "A"), Vaihtoehto(nimi: "B"), Vaihtoehto(nimi: "C")])
        XCTAssertEqual(Vastausteksti.muodosta(k, valitut: ["C", "A"]), "A, C")
        XCTAssertEqual(Vastausteksti.muodosta(k, valitut: ["B"]), "B")
        XCTAssertEqual(Vastausteksti.muodosta(k, valitut: []), "")
        XCTAssertEqual(Vastausteksti.muodosta(k, valitut: ["X"]), "")
    }

    // --- Chat-palojen kokoaminen ---

    private func t(_ tyyppi: String, teksti: String? = nil, vastaus: String? = nil, keskustelu: String? = nil, virhe: String? = nil) -> ChatTapahtuma {
        ChatTapahtuma(tyyppi: tyyppi, teksti: teksti, vastaus: vastaus, keskustelu: keskustelu, virhe: virhe)
    }

    func testChatPalatLiitetaanJaValmisTallentaaKeskustelun() {
        var k = ChatKokoaja()
        k.kasittele(t("teksti", teksti: "Ho"))
        k.kasittele(t("teksti", teksti: "pea"))
        XCTAssertEqual(k.teksti, "Hopea")
        XCTAssertFalse(k.valmis)
        k.kasittele(t("valmis", vastaus: "Hopea", keskustelu: "k1"))
        XCTAssertEqual(k.teksti, "Hopea")
        XCTAssertEqual(k.keskustelu, "k1")
        XCTAssertTrue(k.valmis)
    }

    func testChatKatkonJalkeenValmisKorvaaOsatuloksen() {
        var k = ChatKokoaja(keskustelu: "vanha")
        k.kasittele(t("teksti", teksti: "Hop"))
        k.katko("yhteys katkesi")
        XCTAssertTrue(k.katkennut)
        XCTAssertEqual(k.virhe, "yhteys katkesi")
        XCTAssertEqual(k.teksti, "Hop")
        k.kasittele(t("valmis", vastaus: "Hopea kokonaan", keskustelu: "k2"))
        XCTAssertEqual(k.teksti, "Hopea kokonaan")
        XCTAssertEqual(k.keskustelu, "k2")
        XCTAssertFalse(k.katkennut)
    }

    func testChatValmisIlmanVastaustaSailyttaaPalat() {
        var k = ChatKokoaja(keskustelu: "k0")
        k.kasittele(t("teksti", teksti: "abc"))
        k.kasittele(t("valmis"))
        XCTAssertEqual(k.teksti, "abc")
        XCTAssertEqual(k.keskustelu, "k0")
    }

    func testChatVirheNakyyJaKatkoValmiinJalkeenEiMuutaMitaan() {
        var k = ChatKokoaja()
        k.kasittele(t("virhe", virhe: "malli ei vastaa"))
        XCTAssertEqual(k.virhe, "malli ei vastaa")
        var v = ChatKokoaja()
        v.kasittele(t("valmis", vastaus: "x"))
        v.katko("myöhäinen")
        XCTAssertFalse(v.katkennut)
        XCTAssertNil(v.virhe)
        var tuntematon = ChatKokoaja()
        tuntematon.kasittele(t("outo", teksti: "ei"))
        XCTAssertEqual(tuntematon, ChatKokoaja())
    }

    // --- Rekisterin raja-luokitus ---

    func testRekisterinRajaLuokitus() {
        XCTAssertEqual(RekisteriRaja.luokita(tavut: 100, raja: nil), .eiRajaa)
        XCTAssertEqual(RekisteriRaja.luokita(tavut: 100, raja: 0), .eiRajaa)
        XCTAssertEqual(RekisteriRaja.luokita(tavut: 31999, raja: 40000), .ok)
        XCTAssertEqual(RekisteriRaja.luokita(tavut: 32000, raja: 40000), .lahella)
        XCTAssertEqual(RekisteriRaja.luokita(tavut: 40000, raja: 40000), .lahella)
        XCTAssertEqual(RekisteriRaja.luokita(tavut: 40001, raja: 40000), .ylitetty)
    }

    func testRekisteriRivinPurkuJaReitti() throws {
        let json = #"[{"polku":"claude/REKISTERI.md","laji":"rekisteri","skoopit":["claude"],"tavut":30684,"raja":40000,"tokenit":16555},{"polku":"a b/HISTORIA.md","tavut":5,"raja":null}]"#
        let rivit = try JSONDecoder().decode([RekisteriRivi].self, from: Data(json.utf8))
        XCTAssertEqual(rivit.count, 2)
        XCTAssertEqual(rivit[0].luokka, .ok)
        XCTAssertEqual(rivit[1].luokka, .eiRajaa)
        XCTAssertEqual(rivit[1].skoopit, [])
        XCTAssertEqual(Reitit.rekisteri("a b/HISTORIA.md"), "/api/rekisterit/a%20b/HISTORIA.md")
        XCTAssertEqual(Reitit.viesti("scopes macos"), "/api/skoopit/scopes%20macos/viesti")
    }

    func testRekisterinOsatJaRistiriidat() throws {
        let osat = try JSONDecoder().decode(RekisterinOsat.self, from: Data(#"{"polku":"x","osat":[{"otsikko":"Alku","teksti":"t","tokenit":3}]}"#.utf8))
        XCTAssertEqual(osat.osat.first?.otsikko, "Alku")
        let r = try JSONDecoder().decode(RistiriitaMaara.self, from: Data(#"{"ristiriidat":[{"a":1},"x",3]}"#.utf8))
        XCTAssertEqual(r.maara, 3)
        let tyhja = try JSONDecoder().decode(RistiriitaMaara.self, from: Data(#"{"ristiriidat":[]}"#.utf8))
        XCTAssertEqual(tyhja.maara, 0)
    }

    // --- Vieritys (E-33) ---

    func testVieritysAlhaallaOlo() {
        XCTAssertTrue(Vieritys.onAlhaalla(sisaltoKorkeus: 300, nakymaKorkeus: 500, siirtymaY: 0))
        XCTAssertTrue(Vieritys.onAlhaalla(sisaltoKorkeus: 1000, nakymaKorkeus: 500, siirtymaY: 480))
        XCTAssertFalse(Vieritys.onAlhaalla(sisaltoKorkeus: 1000, nakymaKorkeus: 500, siirtymaY: 100))
    }

    func testVieritaLoppuunVainAlhaallaOltaessa() {
        XCTAssertTrue(Vieritys.vieritaLoppuun(alhaalla: true, vanhaMaara: 5, uusiMaara: 6, viimeinenOma: false))
        XCTAssertFalse(Vieritys.vieritaLoppuun(alhaalla: false, vanhaMaara: 5, uusiMaara: 6, viimeinenOma: false))
        XCTAssertTrue(Vieritys.vieritaLoppuun(alhaalla: false, vanhaMaara: 5, uusiMaara: 6, viimeinenOma: true))
        XCTAssertTrue(Vieritys.vieritaLoppuun(alhaalla: false, vanhaMaara: 0, uusiMaara: 3, viimeinenOma: false))
    }

    // --- Liitteet ja virheet ---

    func testLiitteenKokoraja() {
        XCTAssertTrue(Liitteet.kokoSallittu(LiiteVastaus.maksimi))
        XCTAssertFalse(Liitteet.kokoSallittu(LiiteVastaus.maksimi + 1))
        XCTAssertTrue(Liitteet.liikaaTeksti("a.png").contains("25 Mt"))
        XCTAssertEqual(Liitteet.nimi(URL(fileURLWithPath: "/tmp/kuva.png")), "kuva.png")
    }

    func testVirheteksti() {
        XCTAssertTrue(Virheteksti.muodosta(ApiVirhe(tila: 401)).contains("401"))
        XCTAssertEqual(Virheteksti.muodosta(ApiVirhe(tila: 503, viesti: "vertainen ei vastaa")), "vertainen ei vastaa (503)")
        XCTAssertEqual(Virheteksti.muodosta(ApiVirhe(tila: 500)), "Palvelin vastasi 500")
    }
}
