// T-52 (ARK-09): kahden laitteen UI-testiparit. kaksi-laitetta.sh ajaa kirjoittajan ja lukijan yhtä aikaa (macOS ja iOS-simulaattori),
// koordinaatio koeytimen avaimilla koe/kl-<tarkistus>.<lukija-valmis|t0|teksti|odotettu|tulos> (macOS-testiajuri ei voi kirjoittaa jaettuun
// hakemistoon, mutta HTTP tunnelin läpi toimii); t0 ja havainto mitataan samalla koneella, joten kello on yhteinen.
// Käyttää molempia alustoja (ios/project.yml ja macos/project.yml lisäävät tämän tiedoston UITests-kohteeseen).
// Avain: TEST_RUNNER_SCOPES2_AVAIN → SCOPES2_AVAIN; ei koodissa eikä lokissa.
import XCTest

@MainActor
final class KaksiLaitettaUITests: XCTestCase {
    private let env = ProcessInfo.processInfo.environment
    private var osoite: String { env["SCOPES2_VERTAINEN"] ?? "http://127.0.0.1:18797" }
    private let oletusSkooppi = "test"
    #if os(macOS)
    private let omaPortti = 18861, toinenPortti = 18862
    #else
    private let omaPortti = 18862, toinenPortti = 18861
    #endif

    override func setUpWithError() throws {
        continueAfterFailure = false
        // Parit kuuluvat kaksi-laitetta.sh:lle (KL_AJO=1); T-49:n koko kohteen ajossa ne ohitetaan.
        try XCTSkipUnless(env["KL_AJO"] == "1", "ajetaan vain kaksi-laitetta.sh:n kautta")
    }

    /// Epäonnistunut puoli ilmoittaa toiselle, jotta tämä ei odota turhaan.
    override func tearDown() {
        if (testRun?.totalFailureCount ?? 0) > 0 { kirjoitaTiedosto("keskeytys", name) }
    }

    private struct ToinenKeskeytti: Error {}

    private func nuku(_ sekuntia: TimeInterval) { Thread.sleep(forTimeInterval: sekuntia) }

    // MARK: apurit

    private func avain() throws -> String {
        try XCTUnwrap(env["SCOPES2_AVAIN"], "SCOPES2_AVAIN puuttuu")
    }

    private func nyt() -> Double { Date().timeIntervalSince1970 * 1000 }

    private func koePyynto(_ nimi: String, metodi: String, runko: Data? = nil) -> (data: Data?, tila: Int) {
        http(osoite + "/api/tila/koe/kl-" + nimi, metodi: metodi, runko: runko)
    }

    /// Synkroninen HTTP (Bearer-avain); `url` voi olla koeydin tai jommankumman äpin solmu (127.0.0.1:<portti>).
    private func http(_ osoite: String, metodi: String = "GET", runko: Data? = nil) -> (data: Data?, tila: Int) {
        guard let avain = env["SCOPES2_AVAIN"], let url = URL(string: osoite) else { return (nil, 0) }
        var req = URLRequest(url: url, timeoutInterval: 5)
        req.httpMethod = metodi
        req.httpBody = runko
        req.setValue("Bearer " + avain, forHTTPHeaderField: "Authorization")
        if runko != nil { req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let valmis = DispatchSemaphore(value: 0)
        nonisolated(unsafe) var tulos: (Data?, Int) = (nil, 0)
        URLSession.shared.dataTask(with: req) { data, vastaus, _ in
            tulos = (data, (vastaus as? HTTPURLResponse)?.statusCode ?? 0)
            valmis.signal()
        }.resume()
        _ = valmis.wait(timeout: .now() + 8)
        return tulos
    }

    private func koeValittu() -> String? {
        guard let avain = env["SCOPES2_AVAIN"], let url = URL(string: osoite + "/api/tila/valittu-skooppi") else { return nil }
        var req = URLRequest(url: url, timeoutInterval: 5)
        req.setValue("Bearer " + avain, forHTTPHeaderField: "Authorization")
        let valmis = DispatchSemaphore(value: 0)
        nonisolated(unsafe) var teksti: String?
        URLSession.shared.dataTask(with: req) { data, _, _ in teksti = data.flatMap { String(data: $0, encoding: .utf8) }; valmis.signal() }.resume()
        _ = valmis.wait(timeout: .now() + 8)
        return teksti
    }

    private func kirjoitaTiedosto(_ nimi: String, _ sisalto: String) {
        guard let runko = try? JSONSerialization.data(withJSONObject: ["arvo": sisalto]) else { return }
        for _ in 0..<5 where koePyynto(nimi, metodi: "PUT", runko: runko).tila != 200 { nuku(0.2) }
    }

    private func lueTiedosto(_ nimi: String) -> String? {
        let v = koePyynto(nimi, metodi: "GET")
        guard v.tila == 200, let data = v.data,
              let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let arvo = o["arvo"] as? String else { return nil }
        return arvo
    }

    private func odota(_ sekuntia: TimeInterval, _ ehto: () -> Bool) -> Bool {
        let loppu = Date().addingTimeInterval(sekuntia)
        repeat {
            if ehto() { return true }
            nuku(0.02)
        } while Date() < loppu
        return ehto()
    }

    private func odotaTiedosto(_ nimi: String, _ sekuntia: TimeInterval = 240) throws -> String {
        var sisalto: String?
        let tuli = odota(sekuntia) { sisalto = self.lueTiedosto(nimi); return sisalto != nil || self.lueTiedosto("keskeytys") != nil }
        if sisalto == nil {
            XCTFail(tuli ? "toinen puoli keskeytti (\(lueTiedosto("keskeytys") ?? ""))" : "tiedostoa \(nimi) ei tullut \(Int(sekuntia)) s:ssa")
            throw ToinenKeskeytti()
        }
        return try XCTUnwrap(sisalto)
    }

    private func kaynnista(headless: Bool = false, kuittaus: Bool = false) throws -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["SCOPES2_AVAIN"] = try avain()
        app.launchEnvironment["SCOPES2_VERTAINEN"] = osoite
        app.launchEnvironment["SCOPES2_DATA"] = NSTemporaryDirectory() + "scopes2-kl-" + UUID().uuidString
        // Mittaus kohdistuu synkan viiveeseen kirjoituksen jälkeen: debounce (luonnos 1 s, vierityskohta 2 s) pois; yksikkötestit kattavat sen.
        app.launchEnvironment["SCOPES2_TILAVIIVE_MS"] = "0"
        // Replikointi vetää vain vertaisen virrasta eikä koeydin tunne äppien osoitteita: solmut ovat toistensa vertaisia Macin loopbackissa.
        app.launchEnvironment["SCOPES2_PORTTI"] = String(omaPortti)
        app.launchEnvironment["SCOPES2_VERTAISET"] = "http://127.0.0.1:\(toinenPortti)"
        if !kuittaus { app.launchEnvironment["SCOPES2_KUITTAUS"] = "pois" }   // vain kuittaustarkistus kuittaa; muut säästävät lukemattomat
        if headless { app.launchArguments += ["-scopes2.headless", "YES"] }
        // T-71: portti vie TEST_RUNNER_SCOPES2_NAYTTO_HEREILLA=YES; näyttö pysyy hereillä ilman ssh-caffeinatea (iOS ohittaa argumentin)
        if env["SCOPES2_NAYTTO_HEREILLA"] == "YES" { app.launchArguments += ["-scopes2.naytto-hereilla", "YES"] }
        app.launch()
        XCTAssertTrue(elementti(app, "skooppi-suodatin").waitForExistence(timeout: 180), "sivupalkki ei latautunut")
        yhdistaVertaiset()
        return app
    }

    /// Replikointi yrittää vertaista uudelleen kasvavalla viiveellä (1…30 s), kun toinen solmu ei vielä kuuntele: varmista molemmat
    /// suunnat ennen mittausta kirjoittamalla oma ei-UI-avain omaan solmuun ja odottamalla toisen avainta.
    private func yhdistaVertaiset() {
        let runko = try? JSONSerialization.data(withJSONObject: ["arvo": "1"])
        let oma = "http://127.0.0.1:\(omaPortti)", toinen = "asetukset/kl-hei-\(toinenPortti)"
        XCTAssertTrue(odota(60) { self.http(oma + "/api/tila/asetukset/kl-hei-\(self.omaPortti)", metodi: "PUT", runko: runko).tila == 200 }, "oman solmun kirjoitus (portti \(omaPortti))")
        XCTAssertTrue(odota(150) { self.arvo(oma, toinen) == "1" }, "vertaisyhteys toiseen solmuun (portti \(self.toinenPortti)) ei muodostunut")
        odotaRauhaa(oma)
    }

    /// Ensisynkka (peili, skoopit) kuormittaa solmun varastoa: PUT voi viipyä kymmeniä sekunteja. Odota, että solmun seq ei muutu 6 s:iin.
    private func odotaRauhaa(_ oma: String) {
        struct Terveys: Decodable { let seq: Int? }
        func seq() -> Int? {
            let v = http(oma + "/api/terveys")
            return v.data.flatMap { try? JSONDecoder().decode(Terveys.self, from: $0).seq }
        }
        let alku = nyt()
        var viimeinen = seq(), muuttui = nyt()
        while nyt() - alku < 240_000 {
            nuku(1)
            let nyt = seq()
            if nyt != viimeinen { viimeinen = nyt; muuttui = self.nyt() }
            if self.nyt() - muuttui >= 6_000 { break }
        }
        print("KL-DIAG rauha \(omaPortti): seq \(viimeinen ?? -1), \(Int(nyt() - alku)) ms")
    }

    private func elementti(_ app: XCUIApplication, _ tunnus: String) -> XCUIElement {
        app.descendants(matching: .any)[tunnus].firstMatch
    }

    private func napauta(_ e: XCUIElement) {
        #if os(macOS)
        e.click()
        #else
        e.tap()
        #endif
    }

    private func kirjoitaKenttaan(_ e: XCUIElement, _ teksti: String) {
        napauta(e)
        e.typeText(teksti)
    }

    /// Suodatin rajaa sivupalkin yhteen riviin, jolloin rivi on aina osoitettavissa. `avattuKelpaa`: skooppi on jo auki (toisen laitteen
    /// valinta synkkautui), jolloin haku päättyy ilman virhettä (avaaSkooppi).
    private func rivi(_ app: XCUIApplication, _ nimi: String, avattuKelpaa: Bool = false) -> XCUIElement {
        let suodatin = elementti(app, "skooppi-suodatin")
        let auki = { avattuKelpaa && self.elementti(app, "avattu-\(nimi)").exists }
        if !odota(30, { suodatin.exists || auki() }) {
            print("KL-DIAG suodatin puuttuu; ikkuna:\n" + String(app.debugDescription.prefix(5000)))
        }
        // Suodatin synkkautuu laitteiden välillä: toisen laitteen kirjoitus voi ehtiä kentälle ennen omaa, jolloin teksti tuplaantuisi.
        // Kirjoitetaan, odotetaan hetki ja korjataan (tyhjennys + uusi kirjoitus), kunnes kentän arvo on täsmälleen nimi.
        for _ in 0..<4 where !auki() && suodatin.exists && (suodatin.value as? String) != nimi {
            let nykyinen = (suodatin.value as? String).flatMap { $0 == "Suodata skoopit" ? "" : $0 } ?? ""
            napauta(suodatin)
            if !nykyinen.isEmpty { suodatin.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: nykyinen.count + 2)) }
            suodatin.typeText(nimi)
            nuku(1.5)
        }
        let r = elementti(app, "skooppi-\(nimi)")
        if !odota(120, { r.exists || auki() }) {
            let rivit = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'skooppi-'")).allElementsBoundByIndex.prefix(60).map(\.identifier)
            print("KL-DIAG rivi \(nimi) puuttuu; suodatin='\(suodatin.exists ? "\(suodatin.value ?? "")" : "ei ole")' rivit=\(rivit)")
            print("KL-DIAG ikkuna:\n" + String(app.debugDescription.prefix(5000)))
        }
        if auki() { return r }
        XCTAssertTrue(r.exists, "skooppi \(nimi) ei listalla")
        return r
    }

    private func odotaKentta(_ app: XCUIApplication) {
        if !elementti(app, "viesti-kentta").waitForExistence(timeout: 150) {
            print("KL-DIAG syöttökenttä puuttuu; ikkuna:\n" + String(app.debugDescription.prefix(6000)))
            XCTFail("syöttökenttä puuttuu")
        }
    }

    private func avaaSkooppi(_ app: XCUIApplication, _ nimi: String) {
        // Rivin asettelu muuttuu, kun lukemattomien merkki ilmestyy: napautus voi osua vanhaan paikkaan, joten yritetään uudelleen.
        // Toisen laitteen valinta synkkautuu (valittu-skooppi): iPhonen NavigationSplitView siirtyy itse näkymään ja sivupalkin rivi
        // katoaa kesken napautuksen (T-52 ajo 10: "Failed to get matching snapshot"). Avattu skooppi kelpaa; rivi napautetaan vain osoitettavana.
        for _ in 0..<4 {
            if elementti(app, "avattu-\(nimi)").exists { return }
            palaaSivupalkkiin(app)
            let r = rivi(app, nimi, avattuKelpaa: true)
            if elementti(app, "avattu-\(nimi)").exists { return }
            if r.exists && r.isHittable && r.frame.maxX > 0 { napauta(r) } else { palaaSivupalkkiin(app) }
            if elementti(app, "avattu-\(nimi)").waitForExistence(timeout: 8) { return }
        }
        if !elementti(app, "avattu-\(nimi)").waitForExistence(timeout: 60) {
            print("KL-DIAG skooppia \(nimi) ei avattu; ikkuna:\n" + String(app.debugDescription.prefix(6000)))
            XCTFail("skooppia \(nimi) ei avattu")
        }
    }

    /// iPhone: synkattu valinta voi avata toisen skoopin näkymän, jolloin sivupalkki on ruudun vasemmalla puolella (T-62 ajo 2:
    /// skooppi-test x=-70, "Failed to scroll to visible"). Palataan sivupalkkiin navigointipalkin paluupainikkeella; Macilla ei mitään.
    private func palaaSivupalkkiin(_ app: XCUIApplication) {
        #if os(iOS)
        let suodatin = elementti(app, "skooppi-suodatin")
        let takaisin = app.navigationBars.buttons.firstMatch
        if suodatin.exists && suodatin.frame.maxX <= 0 && takaisin.exists && takaisin.isHittable {
            napauta(takaisin)
            _ = odota(5, { suodatin.frame.maxX > 0 })
        }
        #endif
    }

    private func palvelin<T: Decodable>(_ polku: String, _ tyyppi: T.Type) async throws -> T? {
        var req = URLRequest(url: URL(string: osoite + polku)!, timeoutInterval: 180)
        req.setValue("Bearer " + (try avain()), forHTTPHeaderField: "Authorization")
        let (data, vastaus) = try await URLSession.shared.data(for: req)
        if (vastaus as? HTTPURLResponse)?.statusCode == 404 { return nil }
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func koodaa(_ nimi: String) -> String {
        var sallitut = CharacterSet.urlPathAllowed
        sallitut.remove(charactersIn: "/")
        return nimi.addingPercentEncoding(withAllowedCharacters: sallitut) ?? nimi
    }

    // MARK: kirjoittaja / lukija

    /// Lukija: valmistelu, ennakkoehto (havainto ei saa olla jo tosi), valmis-merkintä, odotus t0:aan ja havainto.
    private func lukija(_ nimi: String, headless: Bool = false, kuittaus: Bool = false, valmistelu: (XCUIApplication) async throws -> Void,
                        ennakko: ((XCUIApplication) -> String?)? = nil, havainto: (XCUIApplication) -> Bool) async throws {
        let app = try kaynnista(headless: headless, kuittaus: kuittaus)
        try await valmistelu(app)
        nuku(4)   // virta ja replikointi vakaiksi ennen kuin kirjoittaja toimii
        if let ongelma = ennakko?(app) {
            kirjoitaTiedosto("\(nimi).tulos", "virhe: \(ongelma)")
            XCTFail(ongelma)
            return
        }
        kirjoitaTiedosto("\(nimi).lukija-valmis", "1")
        let t0 = try XCTUnwrap(Double(try odotaTiedosto("\(nimi).t0")), "t0 ei ole luku")
        if odota(10, { havainto(app) }) {
            kirjoitaTiedosto("\(nimi).tulos", String(max(0, Int(nyt() - t0))))
        } else {
            kirjoitaTiedosto("\(nimi).tulos", "virhe: muutos ei näkynyt 10 s:ssa")
            let ms = nyt()
            let saapui = odota(30) { havainto(app) }
            print("KL-DIAG \(nimi) lukija: havainto \(saapui ? "saapui \(Int(nyt() - t0)) ms t0:sta" : "ei saapunut 40 s:ssa")")
            let oma = "http://127.0.0.1:\(omaPortti)"
            for avain in ["valittu-skooppi", "suodatin", "asetukset/kl-hei-\(toinenPortti)"] {
                let v = http(oma + "/api/tila/" + avain)
                print("KL-DIAG oma solmu \(avain): \(v.tila) \(v.data.flatMap { String(data: $0, encoding: .utf8) } ?? "")")
            }
            print("KL-DIAG \(nimi) lukija ikkunan sisältö:\n" + String(app.debugDescription.prefix(3000)))
            XCTFail("\(nimi): muutos ei näkynyt lukijalla 10 s:ssa")
        }
    }

    private func kirjoittaja(_ nimi: String, kuittaus: Bool = false, valmistelu: (XCUIApplication) async throws -> Void, teko: (XCUIApplication) async throws -> Void) async throws {
        let app = try kaynnista(kuittaus: kuittaus)
        try await valmistelu(app)
        _ = try odotaTiedosto("\(nimi).lukija-valmis")
        try await teko(app)
        _ = try odotaTiedosto("\(nimi).tulos", 60)   // pidä solmu käynnissä, kunnes lukija on mitannut
        _ = app
    }

    private func merkitseT0(_ nimi: String) { kirjoitaTiedosto("\(nimi).t0", String(format: "%.0f", nyt())) }

    // MARK: 1. valinta (mac → sim)

    func testValintaKirjoittaja() async throws {
        let skooppi = try await valitseSkooppi(.valinta)
        try await kirjoittaja("valinta", valmistelu: { app in _ = self.rivi(app, skooppi) }, teko: { app in
            let r = self.rivi(app, skooppi)
            self.napauta(r)
            // t0 = hetki, jolloin valinta näkyy kirjoittajan omassa käyttöliittymässä (XCUITestin napautuksen oma viive ei kuulu synkkaan)
            XCTAssertTrue(self.elementti(app, "avattu-\(skooppi)").waitForExistence(timeout: 20), "kirjoittajan oma valinta ei avautunut")
            self.merkitseT0("valinta")
            let alkuMs = self.nyt()
            _ = self.odota(30) { (self.arvo("http://127.0.0.1:\(self.omaPortti)", "valittu-skooppi") ?? "") == skooppi }
            print("KL-DIAG kirjoittajan oma solmu sai valinnan \(Int(self.nyt() - alkuMs)) ms:ssa (tila-diag \(self.elementti(app, "tila-diag").label))")
            let oma = self.http("http://127.0.0.1:\(self.omaPortti)/api/tila/valittu-skooppi")
            print("KL-DIAG tila-diag: \(self.elementti(app, "tila-diag").label)")
            print("KL-DIAG kirjoittajan solmu valittu-skooppi: \(oma.tila) \(oma.data.flatMap { String(data: $0, encoding: .utf8) } ?? "")")
            print("KL-DIAG valittu-skooppi koeytimessä: \(self.koeValittu() ?? "ei arvoa")")
        })
    }

    func testValintaLukija() async throws {
        let skooppi = try await valitseSkooppi(.valinta)
        try await lukija("valinta", valmistelu: { _ in },
                         ennakko: { app in self.elementti(app, "avattu-\(skooppi)").exists ? "skooppi on jo auki ennen valintaa" : nil },
                         havainto: { app in self.elementti(app, "avattu-\(skooppi)").exists })
    }

    // MARK: 2. luonnos (sim → mac)

    func testLuonnosKirjoittaja() async throws {
        let teksti = "kl" + UUID().uuidString.prefix(6).lowercased()
        let skooppi = try await valitseSkooppi(.luonnos)
        try await kirjoittaja("luonnos", valmistelu: { app in
            self.avaaSkooppi(app, skooppi)
            self.odotaKentta(app)
        }, teko: { app in
            self.kirjoitaTiedosto("luonnos.teksti", teksti)
            self.kirjoitaKenttaan(self.elementti(app, "viesti-kentta"), teksti)
            self.merkitseT0("luonnos")   // viimeisen näppäilyn jälkeen
        })
    }

    func testLuonnosLukija() async throws {
        let skooppi = try await valitseSkooppi(.luonnos)
        try await lukija("luonnos", valmistelu: { app in
            self.avaaSkooppi(app, skooppi)
            self.odotaKentta(app)
        }, havainto: { app in
            guard let teksti = self.lueTiedosto("luonnos.teksti") else { return false }
            return ((self.elementti(app, "viesti-kentta").value as? String) ?? "").contains(teksti)
        })
    }

    // MARK: 3. vierityskohta (mac → sim)

    private func vierityskohta(_ app: XCUIApplication) -> String {
        let l = elementti(app, "vierityskohta").label
        return l == "-" ? "" : l
    }

    func testVierityskohtaKirjoittaja() async throws {
        let skooppi = try await valitseSkooppi(.vieritys)
        try await kirjoittaja("vierityskohta", valmistelu: { app in
            self.avaaSkooppi(app, skooppi)
            XCTAssertTrue(self.odota(150, { self.elementti(app, "viesti").exists || self.elementti(app, "tyokalu-rivi").exists }), "skoopissa ei viestejä")
        }, teko: { app in
            let lista = app.scrollViews.containing(NSPredicate(format: "identifier IN {'viesti','tyokalu-rivi'}")).firstMatch
            var edellinen = "", vakaana = 0
            for _ in 0..<80 where vakaana < 3 {
                #if os(macOS)
                lista.scroll(byDeltaX: 0, deltaY: 3000)
                #else
                lista.swipeDown()
                #endif
                let nyt = self.vierityskohta(app)
                vakaana = nyt == edellinen ? vakaana + 1 : 0
                edellinen = nyt
            }
            let kohta = self.vierityskohta(app)
            XCTAssertFalse(kohta.isEmpty, "vierityskohtaa ei saatu")
            self.kirjoitaTiedosto("vierityskohta.odotettu", kohta)
            self.merkitseT0("vierityskohta")
        })
    }

    func testVierityskohtaLukija() async throws {
        var alku = ""
        let skooppi = try await valitseSkooppi(.vieritys)
        try await lukija("vierityskohta", valmistelu: { app in
            self.avaaSkooppi(app, skooppi)
            if !self.odota(150, { self.elementti(app, "viesti").exists || self.elementti(app, "tyokalu-rivi").exists }) {
                print("KL-DIAG viestit eivät latautuneet; ikkuna:\n" + String(app.debugDescription.prefix(5000)))
                XCTFail("viestit eivät latautuneet")
            }
            nuku(2)
            alku = self.vierityskohta(app)
        }, havainto: { app in
            guard let odotettu = self.lueTiedosto("vierityskohta.odotettu") else { return false }
            return self.vierityskohta(app) == odotettu
        })
        _ = alku
    }

    // MARK: 4. kuittaus (sim kuittaa → mac lukematon-merkki pois)

    private struct Nimi: Decodable { let nimi: String; let istuntoja: Int? }
    private struct ViestiRivi: Decodable { let id: String?; let rooli: String }
    private struct Viestit: Decodable { let viestit: [ViestiRivi]; let auki: Bool?; let voiLahettaa: Bool? }

    private enum Laji { case valinta, luonnos, vieritys }

    /// Skooppi tarkistukselle koeytimen datasta. Molemmat puolet laskevat saman (deterministinen järjestys).
    /// valinta: "test" tai ensimmäinen; luonnos: skooppi, jolla on avoin istunto ja joka voi lähettää (vain silloin syöttökenttä
    /// näkyy; "test"-skoopilla ei ole istuntoa); vieritys: avoin istunto ja vähintään 12 viestiä, jotta lista vierittyy.
    private func valitseSkooppi(_ laji: Laji) async throws -> String {
        let kaikki = try await palvelin("/api/skoopit", [Nimi].self) ?? []
        let nimet = kaikki.map(\.nimi)
        if laji == .valinta { return nimet.contains(oletusSkooppi) ? oletusSkooppi : try XCTUnwrap(nimet.first, "palvelimella ei skoopteja") }
        // Vain skoopit, joilla on avoin istunto: viestipyyntö on kylmällä koeytimellä hidas (5–13 s per skooppi).
        let ehdokkaat = kaikki.filter { ($0.istuntoja ?? 0) > 0 }.map(\.nimi)
        for n in ehdokkaat {
            guard let v = try await palvelin("/api/skoopit/\(koodaa(n))/viestit", Viestit.self) else { continue }
            guard v.auki == true, v.voiLahettaa != false else { continue }
            if laji == .luonnos || v.viestit.count >= 12 { return n }
        }
        throw XCTSkip("palvelimella ei sopivaa skooppia (\(laji)); ehdokkaat: \(ehdokkaat)")
    }

    private struct Kuittaus: Decodable { let arvo: Int? }

    private func rivinro(_ id: String?) -> Int? { Int((id ?? "").split(separator: ":").last ?? "") }

    /// Skooppi, jolla on lukemattomia (viesti, jonka rivinro > kuittaus); "test" ensin. Näin tarkistus ei riipu aiemmista ajoista.
    private func lukematonSkooppi() async throws -> String? {
        let kaikki = try await palvelin("/api/skoopit", [Nimi].self) ?? []
        let jarjestys = kaikki.filter { ($0.istuntoja ?? 0) > 0 }.map(\.nimi)   // muilla skoopeilla ei ole viestejä
        for n in jarjestys {
            guard let v = try await palvelin("/api/skoopit/\(koodaa(n))/viestit", Viestit.self) else { continue }
            // vanhan 8787-sillan viesteillä ei ole id:tä: sovellus käyttää silloin rivin indeksiä
            let suurin = v.viestit.enumerated().filter { $0.element.rooli != "kayttaja" }.compactMap { rivinro($0.element.id) ?? $0.offset }.max() ?? 0
            let kuitattu = try await palvelin("/api/tila/kuittaus/\(koodaa(n))", Kuittaus.self)?.arvo ?? 0
            if suurin > kuitattu { return n }
        }
        return nil
    }

    func testKuittausKirjoittaja() async throws {
        try await kirjoittaja("kuittaus", kuittaus: true, valmistelu: { _ in }, teko: { app in
            let nimi = try await self.lueTiedostoOdottaen("kuittaus.skooppi")
            let r = self.rivi(app, nimi)
            self.merkitseT0("kuittaus")
            self.napauta(r)   // avaus alareunassa kuittaa luetuksi
        })
    }

    private func lueTiedostoOdottaen(_ nimi: String) async throws -> String { try odotaTiedosto(nimi, 60) }

    /// Rivin lapsielementit perivät rivin tunnisteen (skooppi-<nimi>), joten merkki tunnistetaan tekstistä "N lukematonta".
    private func lukematonMerkki(_ app: XCUIApplication, _ nimi: String) -> Bool {
        guard let kuva = try? app.snapshot() else { return false }
        func kay(_ e: XCUIElementSnapshot) -> Bool {
            if e.identifier == "skooppi-\(nimi)", e.label.contains("lukematonta") || ((e.value as? String) ?? "").contains("lukematonta") { return true }
            return e.children.contains(where: kay)
        }
        return kay(kuva)
    }

    func testKuittausLukija() async throws {
        var nimi = ""
        // Headless: valinta ei synkkaudu tälle laitteelle, joten vain kirjoittajan kuittaus voi poistaa merkin (kuittaus/* synkataan silti).
        try await lukija("kuittaus", headless: true, kuittaus: true, valmistelu: { app in
            nimi = try await self.lukematonSkooppi() ?? ""
            XCTAssertFalse(nimi.isEmpty, "palvelimella ei skooppia, jolla olisi lukemattomia")
            self.kirjoitaTiedosto("kuittaus.skooppi", nimi)
            _ = self.rivi(app, nimi)
        }, ennakko: { app in
            self.odota(150) { self.lukematonMerkki(app, nimi) } ? nil : "lukematon-merkkiä ei näy ennen kuittausta (\(nimi))"
        }, havainto: { app in
            !self.lukematonMerkki(app, nimi)
        })
    }

    // MARK: 5. headless (mac headless → sim): UI-avain ei lähde, ei-UI-avain lähtee (kontrolli)

    private struct Tilat: Decodable { struct T: Decodable { let avain: String; let arvo: String? }; let tilat: [T] }

    private func luonnokset(_ perusosoite: String) -> [String] {
        let v = http(perusosoite + "/api/tila?etuliite=luonnos/")
        guard v.tila == 200, let d = v.data, let t = try? JSONDecoder().decode(Tilat.self, from: d) else { return [] }
        return t.tilat.compactMap(\.arvo)
    }

    private func arvo(_ perusosoite: String, _ avain: String) -> String? {
        let v = http(perusosoite + "/api/tila/" + avain)
        guard v.tila == 200, let d = v.data, let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return nil }
        return o["arvo"] as? String
    }

    func testHeadlessKirjoittaja() async throws {
        let teksti = "hl" + UUID().uuidString.prefix(6).lowercased()
        let kontrolli = "ok" + UUID().uuidString.prefix(6).lowercased()
        let skooppi = try await valitseSkooppi(.luonnos)
        let app = try kaynnista(headless: true)
        avaaSkooppi(app, skooppi)
        XCTAssertTrue(elementti(app, "viesti-kentta").waitForExistence(timeout: 30), "syöttökenttä puuttuu")
        _ = try odotaTiedosto("headless.lukija-valmis")
        merkitseT0("headless")
        kirjoitaTiedosto("headless.teksti", teksti)
        kirjoitaKenttaan(elementti(app, "viesti-kentta"), teksti)
        XCTAssertTrue(((elementti(app, "viesti-kentta").value as? String) ?? "").contains(teksti), "luonnos ei näy paikallisesti")
        // Kontrolli: ei-UI-avain omaan solmuun luonnoksen jälkeen; kun se saapuu lukijalle, luonnoksen olisi pitänyt saapua jo.
        let runko = try JSONSerialization.data(withJSONObject: ["arvo": kontrolli])
        XCTAssertEqual(http("http://127.0.0.1:\(omaPortti)/api/tila/asetukset/kl-kontrolli", metodi: "PUT", runko: runko).tila, 200, "kontrolliavaimen kirjoitus omaan solmuun")
        kirjoitaTiedosto("headless.kontrolli", kontrolli)
        // Kytkin asetuksissa on päällä
        let valilehti = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Asetukset'")).firstMatch
        if valilehti.waitForExistence(timeout: 10) { napauta(valilehti) }
        let kytkin = elementti(app, "headless")
        XCTAssertTrue(kytkin.waitForExistence(timeout: 20), "headless-kytkin puuttuu")
        XCTAssertEqual("\(kytkin.value ?? "")", "1", "headless-kytkin ei ole päällä")
        _ = try odotaTiedosto("headless.tulos", 60)
    }

    func testHeadlessLukija() async throws {
        _ = try kaynnista()   // ei headless: ottaa vastaan kaiken, mitä toinen solmu lähettää
        nuku(4)
        kirjoitaTiedosto("headless.lukija-valmis", "1")
        let t0 = try XCTUnwrap(Double(try odotaTiedosto("headless.t0")), "t0 ei ole luku")
        let teksti = try odotaTiedosto("headless.teksti")
        let kontrolli = try odotaTiedosto("headless.kontrolli")
        let omaSolmu = "http://127.0.0.1:\(omaPortti)"
        guard odota(20, { self.arvo(omaSolmu, "asetukset/kl-kontrolli") == kontrolli }) else {
            kirjoitaTiedosto("headless.tulos", "virhe: kontrolliavain ei synkannut solmujen välillä (peering ei toimi)")
            XCTFail("kontrolliavain ei saapunut")
            return
        }
        nuku(3)   // luonnoksen olisi pitänyt saapua kontrollin edellä; ylimääräinen odotus pisimmälle viiveelle
        let omat = luonnokset(omaSolmu), koe = luonnokset(osoite)
        if omat.contains(where: { $0.contains(teksti) }) || koe.contains(where: { $0.contains(teksti) }) {
            kirjoitaTiedosto("headless.tulos", "virhe: headless-luonnos päätyi toiselle solmulle tai palvelimelle")
            XCTFail("headless-luonnos vuoti")
            return
        }
        kirjoitaTiedosto("headless.tulos", String(Int(nyt() - t0)))
    }
}
