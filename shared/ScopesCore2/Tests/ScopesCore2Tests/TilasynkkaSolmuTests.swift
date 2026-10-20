import XCTest
@testable import ScopesCore2

/// T-52: Tilasynkka oikeaa äpin sisäistä ydintä vasten (PUT/GET /api/tila, S-4).
@MainActor
final class TilasynkkaSolmuTests: XCTestCase {
    private func kaynnistaSolmu() async throws -> (Asiakas, URL) {
        let data = FileManager.default.temporaryDirectory.appendingPathComponent("scopes2-tila-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true)
        let avain = "koe-" + UUID().uuidString
        let url = try await Solmu.jaettu.kaynnista(SolmuAsetukset(data: data, avain: avain, laite: "mac-koe"))
        return (Asiakas(osoite: url, avain: avain), data)
    }

    func testKirjoitusPerilleYdinjaVastaanottoToiseltaLaitteelta() async throws {
        let (asiakas, data) = try await kaynnistaSolmu()
        defer { Task { await Solmu.jaettu.pysayta(); try? FileManager.default.removeItem(at: data) } }

        let t = Tilasynkka(laite: "mac-koe", viiveMs: { _ in 0 })
        await t.kaynnista(asiakas: asiakas, headless: false)
        t.kirjoita("valittu-skooppi", .teksti("scopes macos"))
        t.kirjoita("luonnos/scopes macos", .teksti("kesken"))
        t.kirjoita("kuittaus/scopes macos", .luku(7))
        await t.tyhjenna()
        try await Task.sleep(nanoseconds: 300_000_000)

        let (v, _): (Tilasynkka.TilaVastaus, lahde: String?) = try await asiakas.hae("/api/tila/valittu-skooppi")
        XCTAssertEqual(v.arvo, .teksti("scopes macos"))
        XCTAssertEqual(v.laite, "mac-koe")
        let (l, _): (Tilasynkka.TilaVastaus, lahde: String?) = try await asiakas.hae(Tilasynkka.polku("luonnos/scopes macos"))
        XCTAssertEqual(l.arvo, .teksti("kesken"))
        let (k, _): (Tilasynkka.TilaVastaus, lahde: String?) = try await asiakas.hae(Tilasynkka.polku("kuittaus/scopes macos"))
        XCTAssertEqual(k.arvo, .luku(7))

        // Toinen laite (ios-x) soveltaa saman muutoksen; oma laite (mac-koe) ohittaa sen kaikuna.
        let toinen = Tilasynkka(laite: "ios-x", viiveMs: { _ in 0 })
        await toinen.kaynnista(asiakas: asiakas, headless: false)
        XCTAssertEqual(toinen.teksti("valittu-skooppi"), "scopes macos", "alkulataus")
        XCTAssertEqual(toinen.teksti("luonnos/scopes macos"), "kesken")
        XCTAssertEqual(toinen.luku("kuittaus/scopes macos"), 7)
        let _: (Tilasynkka.TilaVastaus?, lahde: String?) = (nil, nil)
        let vieras = Tilasynkka(laite: "ios-x", viiveMs: { _ in 0 })
        await vieras.kaynnista(asiakas: asiakas, headless: false)
        let toisenViesti = Muutos(seq: 99, polku: "tila", id: "valittu-skooppi", aika: "t")
        await vieras.sovella(toisenViesti)
        XCTAssertEqual(vieras.teksti("valittu-skooppi"), "scopes macos")
        await t.sovella(toisenViesti)
        XCTAssertEqual(t.teksti("valittu-skooppi"), "scopes macos", "kaiku ei muuta arvoa")
    }

    func testPerakkaisetKirjoituksetSamaanAvaimeenPerilleVikaArvo() async throws {
        let (asiakas, data) = try await kaynnistaSolmu()
        defer { Task { await Solmu.jaettu.pysayta(); try? FileManager.default.removeItem(at: data) } }
        let t = Tilasynkka(laite: "mac-koe", viiveMs: { _ in 0 })
        await t.kaynnista(asiakas: asiakas, headless: false)
        for osa in ["t", "te", "tes", "test"] {
            t.kirjoita("suodatin", .teksti("Kaikki\t" + osa))
            try await Task.sleep(nanoseconds: 30_000_000)
        }
        t.kirjoita("valittu-skooppi", .teksti("x"))
        let valmis = await odotaArvo(asiakas, "suodatin", .teksti("Kaikki\ttest"))
        XCTAssertTrue(valmis, "viimeinen arvo ei päässyt solmuun; virhe=\(t.viimeinenVirhe ?? "-") lahetetty=\(t.lahetetty)")
        let v = await odotaArvo(asiakas, "valittu-skooppi", .teksti("x"))
        XCTAssertTrue(v, "valittu-skooppi ei päässyt solmuun; virhe=\(t.viimeinenVirhe ?? "-") lahetetty=\(t.lahetetty)")
    }

    private func odotaArvo(_ asiakas: Asiakas, _ avain: String, _ odotettu: TilaArvo) async -> Bool {
        let loppu = Date().addingTimeInterval(3)
        while Date() < loppu {
            if let (v, _) = try? await asiakas.hae(Tilasynkka.polku(avain)) as (Tilasynkka.TilaVastaus, lahde: String?), v.arvo == odotettu { return true }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        return false
    }
}
