// T-52 (ARK-09): UI-tila ytimen tilavarastoon (S-4): GET/PUT /api/tila/<avain>, muutokset virran polulla "tila".
import Foundation
import Observation

/// Tila-avaimen arvo: teksti (valinta, luonnos, vierityskohta), kokonaisluku (kuittaus) tai tyhjä (null = ei arvoa).
public enum TilaArvo: Codable, Equatable, Sendable {
    case teksti(String)
    case luku(Int)
    case tyhja

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .tyhja
        } else if let n = try? c.decode(Int.self) {
            self = .luku(n)
        } else if let s = try? c.decode(String.self) {
            self = .teksti(s)
        } else {
            self = .tyhja
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .teksti(let s): try c.encode(s)
        case .luku(let n): try c.encode(n)
        case .tyhja: try c.encodeNil()
        }
    }
}

/// S-4:n avaimet ja kirjoitusviiveet.
public enum TilaAvain {
    public static let valittu = "valittu-skooppi"
    public static let suodatin = "suodatin"
    public static let piilotukset = "piilotukset"

    public static func luonnos(_ skooppi: String) -> String { "luonnos/\(skooppi)" }
    public static func vierityskohta(_ skooppi: String) -> String { "vierityskohta/\(skooppi)" }
    public static func kuittaus(_ skooppi: String) -> String { "kuittaus/\(skooppi)" }

    /// Headless-solmu ei lähetä eikä sovella näitä (ytimen `on_ui_avain`); `kuittaus/*` ja `asetukset/*` eivät ole UI-avaimia.
    public static func onUI(_ avain: String) -> Bool {
        if [valittu, "agy-valinta", piilotukset, suodatin].contains(avain) { return true }
        return ["luonnos/", "vierityskohta/", "purku-valinta/"].contains { avain.hasPrefix($0) }
    }

    /// valittu-skooppi 0 s, luonnos 1 s, vierityskohta 2 s, suodatin ja piilotukset 1 s; muut heti.
    public static func viiveMs(_ avain: String) -> UInt64 {
        if avain.hasPrefix("luonnos/") || avain == suodatin || avain == piilotukset { return 1_000 }
        if avain.hasPrefix("vierityskohta/") { return 2_000 }
        return 0
    }

    /// Viestin id "<istunto>:<rivinro>" → rivinro; pelkkä numero (rivin indeksi) kelpaa myös.
    public static func rivinro(_ viestinId: String) -> Int? {
        Int(viestinId.split(separator: ":").last ?? "")
    }

    /// Lukemattomat = viestit, joiden rivinro > kuittaus (ei kuittausta = 0).
    public static func lukemattomia(_ viestit: [Viesti], kuittaus: Int?) -> Int {
        let raja = kuittaus ?? 0
        return viestit.filter { v in !v.omaViesti && (rivinro(v.id).map { $0 > raja } ?? false) }.count
    }

    /// Suurin luettu viestinumero kuittausta varten.
    public static func suurinRivinro(_ viestit: [Viesti]) -> Int? {
        viestit.compactMap { rivinro($0.id) }.max()
    }
}

@MainActor @Observable public final class Tilasynkka {
    /// Nykyiset arvot (oma muutos heti, toiselta laitteelta saapunut sovellettuna). Tyhjä arvo poistaa avaimen.
    public private(set) var arvot: [String: TilaArvo] = [:]
    /// Onnistuneet lähetykset ja viimeisin virhe (diagnostiikka; näkyy testikoukussa "tila-diag").
    public private(set) var lahetetty = 0
    public private(set) var viimeinenVirhe: String?

    @ObservationIgnored public let laite: String
    @ObservationIgnored public private(set) var headless: Bool
    @ObservationIgnored private let viive: (String) -> UInt64
    /// Lähetys ja haku ovat korvattavissa testeissä; oletus käyttää Asiakasta.
    @ObservationIgnored var lahetin: (String, TilaArvo) async throws -> Void
    @ObservationIgnored var hakija: (String) async throws -> TilaVastaus?
    @ObservationIgnored var listaaja: (String) async throws -> [TilaVastaus]
    /// Lähettämätön viimeisin arvo per avain, kirjoitusten järjestysluku (vanhentunut viive ei lähetä) ja käynnissä olevat lähetykset.
    /// Käynnissä olevaa HTTP-pyyntöä ei peruta (Task.cancel katkaisisi URLSessionin): uudempi arvo lähetetään sen perään.
    @ObservationIgnored private var odottavat: [String: TilaArvo] = [:]
    @ObservationIgnored private var jarjestys: [String: Int] = [:]
    @ObservationIgnored private var lahetyksessa: Set<String> = []

    /// `viiveMs` korvaa avaimen oletusviiveen; ympäristö SCOPES2_TILAVIIVE_MS (testiäpit) asettaa kaikille saman viiveen.
    public init(laite: String = Oletukset.laite(), headless: Bool = false, viiveMs: ((String) -> UInt64)? = nil) {
        self.laite = laite
        self.headless = headless
        if let v = viiveMs {
            self.viive = v
        } else if let s = ProcessInfo.processInfo.environment["SCOPES2_TILAVIIVE_MS"], let n = UInt64(s) {
            self.viive = { _ in n }
        } else {
            self.viive = TilaAvain.viiveMs
        }
        self.lahetin = { _, _ in }
        self.hakija = { _ in nil }
        self.listaaja = { _ in [] }
    }

    public struct TilaVastaus: Decodable, Sendable, Equatable {
        public let avain: String
        public let arvo: TilaArvo
        public let laite: String?

        public init(avain: String, arvo: TilaArvo, laite: String?) {
            self.avain = avain
            self.arvo = arvo
            self.laite = laite
        }
    }

    private struct Lista: Decodable { let tilat: [TilaVastaus] }
    private struct Runko: Encodable { let arvo: TilaArvo }
    private struct Aika: Decodable { let aika: String }

    // MARK: lukeminen

    public func arvo(_ avain: String) -> TilaArvo? { arvot[avain] }

    public func teksti(_ avain: String) -> String? {
        if case .teksti(let s)? = arvot[avain] { return s }
        return nil
    }

    public func luku(_ avain: String) -> Int? {
        if case .luku(let n)? = arvot[avain] { return n }
        return nil
    }

    // MARK: kirjoittaminen

    /// Asettaa arvon heti paikallisesti ja lähettää sen viiveen jälkeen; viiveen aikana viimeisin arvo voittaa.
    /// Kuittaus on suurin-voittaa myös paikallisesti. Headless-tilassa UI-avaimet jäävät paikallisiksi.
    public func kirjoita(_ avain: String, _ uusi: TilaArvo, viiveMs: UInt64? = nil) {
        if avain.hasPrefix("kuittaus/") {
            guard case .luku(let n) = uusi else { return }
            if let nyt = luku(avain), nyt >= n { return }
        }
        if arvot[avain] == uusi && odottavat[avain] == nil { return }
        if case .tyhja = uusi { arvot[avain] = nil } else { arvot[avain] = uusi }
        if headless && TilaAvain.onUI(avain) { return }
        let nro = (jarjestys[avain] ?? 0) + 1
        jarjestys[avain] = nro
        odottavat[avain] = uusi
        let odotus = viiveMs ?? viive(avain)
        Task { [weak self] in
            if odotus > 0 {
                try? await Task.sleep(nanoseconds: odotus * 1_000_000)
            }
            guard let self, self.jarjestys[avain] == nro else { return }
            await self.laheta(avain)
        }
    }

    /// Lähettää odottavat heti (testit, taustalle meno).
    public func tyhjenna() async {
        for a in Array(odottavat.keys) {
            jarjestys[a] = (jarjestys[a] ?? 0) + 1   // mitätöi nukkuvan viiveen
            await laheta(a)
        }
    }

    /// Kuittaa skoopin luetuksi: kuittaus/<skooppi> = suurin viestinumero.
    public func kuittaa(skooppi: String, viestit: [Viesti]) {
        // Testikoukku: SCOPES2_KUITTAUS=pois estää kuittaukset, jotta muut käyttöliittymätestit eivät kuluta koeytimen lukemattomia.
        if ProcessInfo.processInfo.environment["SCOPES2_KUITTAUS"] == "pois" { return }
        guard let n = TilaAvain.suurinRivinro(viestit) else { return }
        kirjoita(TilaAvain.kuittaus(skooppi), .luku(n))
    }

    /// Lähettää avaimen viimeisimmän arvon; jos lähetys on jo käynnissä, se lähettää uudemman arvon perään.
    private func laheta(_ avain: String) async {
        guard !lahetyksessa.contains(avain) else { return }
        lahetyksessa.insert(avain)
        defer { lahetyksessa.remove(avain) }
        while let arvo = odottavat[avain] {
            do {
                try await lahetin(avain, arvo)
                lahetetty += 1
                if odottavat[avain] == arvo { odottavat[avain] = nil }
            } catch {
                // Verkkovirhe: arvo säilyy paikallisena; seuraava kirjoitus lähettää uudelleen.
                viimeinenVirhe = "\(avain): \(error)"
                odottavat[avain] = nil
            }
        }
    }

    // MARK: vastaanotto

    /// Virran muutos polulla "tila": GET /api/tila/<id>; oman laitteen kirjoitus (kaiku) ohitetaan.
    public func sovella(_ m: Muutos) async {
        guard m.polku == "tila" else { return }
        if headless && TilaAvain.onUI(m.id) { return }
        let vastaus: TilaVastaus?
        do {
            vastaus = try await hakija(m.id)
        } catch {
            return
        }
        guard let v = vastaus else {
            if odottavat[m.id] == nil { arvot[m.id] = nil }
            return
        }
        if v.laite == laite { return }
        aseta(v)
    }

    /// Soveltaa palvelimelta luetun arvon. Oma odottava (vielä lähettämätön) muutos voittaa; kuittaus vain kasvaa.
    private func aseta(_ v: TilaVastaus) {
        if headless && TilaAvain.onUI(v.avain) { return }
        if v.avain.hasPrefix("kuittaus/") {
            guard case .luku(let n) = v.arvo else { return }
            if let nyt = luku(v.avain), nyt >= n { return }
        } else if odottavat[v.avain] != nil {
            return
        }
        if case .tyhja = v.arvo { arvot[v.avain] = nil } else { arvot[v.avain] = v.arvo }
    }

    /// Käynnistys: kerran luonnokset, vierityskohdat ja kuittaukset etuliitteillä sekä yksittäiset avaimet.
    public func kaynnista(asiakas: Asiakas, headless: Bool) async {
        self.headless = headless
        lahetin = { avain, arvo in
            let _: (Aika, lahde: String?) = try await asiakas.hae(Self.polku(avain), metodi: "PUT", runko: Runko(arvo: arvo))
        }
        hakija = { avain in
            do {
                let (v, _): (TilaVastaus, lahde: String?) = try await asiakas.hae(Self.polku(avain))
                return v
            } catch let e as ApiVirhe where e.tila == 404 {
                return nil
            }
        }
        listaaja = { etuliite in
            let (l, _): (Lista, lahde: String?) = try await asiakas.hae("/api/tila?etuliite=" + Asiakas.koodaa(etuliite))
            return l.tilat
        }
        await lataaAlku()
    }

    func lataaAlku() async {
        for etuliite in ["luonnos/", "vierityskohta/", "kuittaus/"] {
            for v in (try? await listaaja(etuliite)) ?? [] { aseta(v) }
        }
        for avain in [TilaAvain.valittu, TilaAvain.suodatin, TilaAvain.piilotukset] {
            if let v = try? await hakija(avain) { aseta(v) }
        }
    }

    static func polku(_ avain: String) -> String {
        "/api/tila/" + avain.split(separator: "/", omittingEmptySubsequences: false).map { Asiakas.koodaa(String($0)) }.joined(separator: "/")
    }
}
