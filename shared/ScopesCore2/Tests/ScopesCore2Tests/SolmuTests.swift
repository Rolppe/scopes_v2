import XCTest
@testable import ScopesCore2

/// (e) oikea äpin sisäinen ydin ja (f) koeydin vertaisena (P-14).
final class SolmuTests: XCTestCase {
    private struct Terveys: Decodable { let ok: Bool; let seq: Int }
    private struct Aika: Decodable { let aika: String }

    private func tilapaisHakemisto() throws -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("scopes2-solmu-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    func testOletukset() {
        let l = Oletukset.laite()
        XCTAssertTrue(l.hasPrefix("mac-") || l.hasPrefix("ios-"), l)
        XCTAssertFalse(l.contains(" "))
        let d = Oletukset.dataHakemisto()
        XCTAssertTrue(d.path.hasSuffix("com.example.scopes-v2/ydin"), d.path)
        var onHakemisto: ObjCBool = false
        XCTAssertTrue(FileManager.default.fileExists(atPath: d.path, isDirectory: &onHakemisto))
        XCTAssertTrue(onHakemisto.boolValue)
        if ProcessInfo.processInfo.environment["SCOPES2_VERTAINEN"] == nil {
            XCTAssertEqual(Oletukset.vertainen.absoluteString, "http://127.0.0.1:18797")
        }
    }

    func testAvainPuuttuuHeittaa() async throws {
        do {
            _ = try await Solmu.jaettu.kaynnista(SolmuAsetukset(data: try tilapaisHakemisto(), avain: "", laite: "mac-koe"))
            XCTFail("piti heittää avain_puuttuu")
            await Solmu.jaettu.pysayta()
        } catch SolmuVirhe.avain_puuttuu {
        }
    }

    func testVirheellinenDataHakemisto() async throws {
        let tiedosto = try tilapaisHakemisto().appendingPathComponent("tiedosto")
        try Data("x".utf8).write(to: tiedosto)
        defer { try? FileManager.default.removeItem(at: tiedosto.deletingLastPathComponent()) }
        do {
            _ = try await Solmu.jaettu.kaynnista(SolmuAsetukset(data: tiedosto, avain: "koe-avain", laite: "mac-koe"))
            XCTFail("piti heittää kaynnistys")
            await Solmu.jaettu.pysayta()
        } catch SolmuVirhe.kaynnistys(let koodi, let viesti) {
            XCTAssertLessThan(koodi, 0)
            XCTAssertFalse(viesti.isEmpty)
            let osoite = await Solmu.jaettu.osoite
            XCTAssertNil(osoite)
        }
    }

    func testYdinKaynnistyyTerveysVirtaJaPysahtyy() async throws {
        let avain = "koe-" + UUID().uuidString
        let data = try tilapaisHakemisto()
        defer { try? FileManager.default.removeItem(at: data) }
        let asetukset = SolmuAsetukset(data: data, avain: avain, vertaiset: [], vanha: nil, headless: false, laite: "mac-koe")
        let url = try await Solmu.jaettu.kaynnista(asetukset)
        let kerays = Kerays()
        let asiakas = Asiakas(osoite: url, avain: avain)
        let virta = kerays.virta(asiakas)
        do {
            XCTAssertEqual(url.host, "127.0.0.1")
            let osoite = await Solmu.jaettu.osoite
            XCTAssertEqual(osoite, url)

            let t: (Terveys, lahde: String?) = try await asiakas.hae("/api/terveys")
            XCTAssertTrue(t.0.ok)

            // Väärä avain → 401.
            do {
                let _: (TyhjaVastaus, lahde: String?) = try await Asiakas(osoite: url, avain: "vaara").hae("/api/skoopit")
                XCTFail("piti heittää 401")
            } catch let v as ApiVirhe {
                XCTAssertEqual(v.tila, 401)
            }

            // Toinen käynnistys samassa prosessissa → jo_kaynnissa.
            do {
                _ = try await Solmu.jaettu.kaynnista(asetukset)
                XCTFail("piti heittää jo_kaynnissa")
            } catch SolmuVirhe.jo_kaynnissa {
            }

            // since = terveyden seq: tapahtuma toistuu lokista, vaikka PUT ehtisi ennen kuin virta on auki
            // (ydin lähettää otsakkeet vasta ensimmäisen kehyksen mukana).
            virta.aloita(since: t.0.seq)

            let alku = Date()
            let _: (Aika, lahde: String?) = try await asiakas.hae("/api/tila/koe/x", metodi: "PUT", runko: ["arvo": 1])
            let tuli = await odota(2) { kerays.muutokset.contains { $0.polku == "tila" } }
            let kesto = Date().timeIntervalSince(alku)
            XCTAssertTrue(tuli, "muutos tuli virtaan alle 2 s:ssa")
            XCTAssertLessThan(kesto, 2.0)
            XCTAssertGreaterThan(virta.seq, t.0.seq)
            let auki = await odota(2) { kerays.auki }
            XCTAssertTrue(auki, "virta auki muutoksen jälkeen")

            await Solmu.jaettu.pysayta()
            let katki = await odota(10) { !kerays.auki }
            XCTAssertTrue(katki, "pysayta → yhteys katki")
            let pysaytetty = await Solmu.jaettu.osoite
            XCTAssertNil(pysaytetty)
            virta.sulje()
        } catch {
            virta.sulje()
            await Solmu.jaettu.pysayta()
            throw error
        }
    }

    /// (f) Koeydin vertaisena tunnelin kautta. Portti antaa koeytimen kertakäyttöavaimen (SCOPES2_AVAIN /
    /// TEST_RUNNER_SCOPES2_AVAIN) ja avaa tunnelin 127.0.0.1:18797 → koeporttiin (P-14). Ei koskaan 8797:ää.
    @MainActor
    func testKoeydinVertaisena() async throws {
        guard let avain = Avain.ymparistosta() else {
            throw XCTSkip("SCOPES2_AVAIN / TEST_RUNNER_SCOPES2_AVAIN puuttuu: koeytimen kertakäyttöavain tulee portilta (P-14)")
        }
        let vertainen = Oletukset.vertainen
        guard let portti = vertainen.port, portti != 8797, portti != 8787 else {
            throw XCTSkip("vertainen \(vertainen.absoluteString) ei kelpaa: tuotantoportteja 8787 ja 8797 ei käytetä")
        }
        var terveys = URLRequest(url: vertainen.appendingPathComponent("api/terveys"))
        terveys.timeoutInterval = 3
        let tavoitettavissa: Bool
        do {
            let (_, v) = try await URLSession.shared.data(for: terveys)
            tavoitettavissa = (v as? HTTPURLResponse)?.statusCode == 200
        } catch {
            tavoitettavissa = false
        }
        guard tavoitettavissa else {
            throw XCTSkip("koeydin ei vastaa osoitteessa \(vertainen.absoluteString) (tunneli ei auki)")
        }

        let data = try tilapaisHakemisto()
        defer { try? FileManager.default.removeItem(at: data) }
        let asetukset = SolmuAsetukset(data: data, avain: avain, vertaiset: [vertainen], vanha: vertainen,
                                       headless: false, laite: "mac-koe-f")
        let url = try await Solmu.jaettu.kaynnista(asetukset)
        let varasto = Varasto()
        do {
            await varasto.kaynnista(asiakas: Asiakas(osoite: url, avain: avain))
            let raja = Date().addingTimeInterval(30)
            while varasto.skoopit.isEmpty && Date() < raja {
                try await Task.sleep(nanoseconds: 2_000_000_000)
                await varasto.paivitaSkoopit()
            }
            print("KOEYDIN-F: skoopit=\(varasto.skoopit.count) yhteys=\(varasto.yhteys) vertainen=\(vertainen.absoluteString)")
            XCTAssertFalse(varasto.skoopit.isEmpty, "skoopit ei tyhjä 30 s:ssa (koeytimen silta)")
            varasto.pysayta()
            await Solmu.jaettu.pysayta()
        } catch {
            varasto.pysayta()
            await Solmu.jaettu.pysayta()
            throw error
        }
    }
}
