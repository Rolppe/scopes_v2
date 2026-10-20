// S-6: ytimen listat ?since=<seq> -erolla ja havaittava varasto näkymille (T-48).
import Foundation
import Observation

/// S-6: `?since=<seq>` → {"seq","muuttuneet":[…],"poistetut":["<id>"…],"nollaus":true?}.
public struct SinceVastaus<T> {
    public let seq: Int
    public let muuttuneet: [T]
    public let poistetut: [String]
    public let nollaus: Bool

    public init(seq: Int, muuttuneet: [T], poistetut: [String] = [], nollaus: Bool = false) {
        self.seq = seq
        self.muuttuneet = muuttuneet
        self.poistetut = poistetut
        self.nollaus = nollaus
    }

}

extension SinceVastaus: Decodable where T: Decodable {
    private enum CodingKeys: String, CodingKey { case seq, muuttuneet, poistetut, nollaus }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.seq = try c.decode(Int.self, forKey: .seq)
        self.muuttuneet = try c.decodeIfPresent([T].self, forKey: .muuttuneet) ?? []
        self.poistetut = try c.decodeIfPresent([String].self, forKey: .poistetut) ?? []
        self.nollaus = try c.decodeIfPresent(Bool.self, forKey: .nollaus) ?? false
    }
}

/// Nollaus korvaa kaiken; muuten muuttuneet korvaavat id:n mukaan, uudet loppuun, poistetut pois.
public func yhdista<T>(_ nyt: [T], _ v: SinceVastaus<T>, tunniste: (T) -> String) -> [T] {
    if v.nollaus { return v.muuttuneet }
    let poistetut = Set(v.poistetut)
    var tulos = nyt.filter { !poistetut.contains(tunniste($0)) }
    var paikat: [String: Int] = [:]
    for (i, alkio) in tulos.enumerated() { paikat[tunniste(alkio)] = i }
    for alkio in v.muuttuneet {
        let id = tunniste(alkio)
        if poistetut.contains(id) { continue }
        if let i = paikat[id] {
            tulos[i] = alkio
        } else {
            paikat[id] = tulos.count
            tulos.append(alkio)
        }
    }
    return tulos
}

/// Lista joko kokonaisena taulukkona (ei since / silta) tai erona (since).
enum ListaVastaus<T: Decodable>: Decodable {
    case kokonainen([T])
    case erot(SinceVastaus<T>)

    init(from decoder: Decoder) throws {
        if let lista = try? [T](from: decoder) {
            self = .kokonainen(lista)
        } else {
            self = .erot(try SinceVastaus<T>(from: decoder))
        }
    }
}

public enum Yhteys: Sendable, Equatable {
    case auki, katki, avain
}

@MainActor @Observable public final class Varasto {
    public private(set) var skoopit: [SkooppiYhteenveto] = []
    public private(set) var viestit: [String: SkooppiViestit] = [:]
    public private(set) var yhteys: Yhteys = .katki
    /// Valittu skooppi (UI-tila synkataan `tila`-synkalla, T-52).
    public var valittu: String?
    /// UI-tila ja kuittaus ytimen tilavarastossa (S-4).
    public let tila: Tilasynkka

    @ObservationIgnored private var asiakas: Asiakas?
    @ObservationIgnored private var virta: Virta?
    @ObservationIgnored private var skooppiSeq: Int?
    @ObservationIgnored private var skooppiTyo: Task<Void, Never>?
    @ObservationIgnored private var viestiTyo: Task<Void, Never>?
    @ObservationIgnored private let yhdistysViive: UInt64

    public init(yhdistysViiveMs: UInt64 = 200, tila: Tilasynkka? = nil) {
        self.yhdistysViive = yhdistysViiveMs * 1_000_000
        self.tila = tila ?? Tilasynkka()
    }

    private struct Terveys: Decodable { let seq: Int? }

    /// Listat ilman since, sitten virta (since = ennen listoja luettu seq, jotta väliin ei jää aukkoa).
    public func kaynnista(asiakas: Asiakas) async {
        pysayta()
        self.asiakas = asiakas
        await tila.kaynnista(asiakas: asiakas, headless: UserDefaults.standard.bool(forKey: "scopes2.headless"))
        let alku = await terveysSeq()
        skooppiSeq = nil
        await paivitaSkoopit(alkuSeq: alku)
        if let v = valittu { await paivitaViestit(v) }
        let uusi = Virta(
            asiakas: asiakas,
            muutos: { [weak self] m in Task { @MainActor in self?.kasittele(m) } },
            nollaus: { [weak self] _ in Task { @MainActor in await self?.paivitaKaikki() } },
            tila: { [weak self] auki in Task { @MainActor in self?.virranTila(auki) } }
        )
        virta = uusi
        uusi.aloita(since: alku)
    }

    /// Sulkee virran ja odottavat päivitykset.
    public func pysayta() {
        virta?.sulje()
        virta = nil
        skooppiTyo?.cancel()
        skooppiTyo = nil
        viestiTyo?.cancel()
        viestiTyo = nil
        yhteys = .katki
    }

    public func paivitaSkoopit() async {
        await paivitaSkoopit(alkuSeq: nil)
    }

    private func paivitaSkoopit(alkuSeq: Int?) async {
        guard let a = asiakas else { return }
        do {
            if let seq = skooppiSeq {
                let (v, _): (ListaVastaus<SkooppiYhteenveto>, lahde: String?) = try await a.hae("/api/skoopit?since=\(seq)")
                switch v {
                case .erot(let e):
                    skoopit = yhdista(skoopit, e, tunniste: { $0.nimi })
                    skooppiSeq = e.seq
                case .kokonainen(let lista):
                    skoopit = lista
                    skooppiSeq = nil
                }
            } else {
                let lahtoSeq: Int?
                if let alkuSeq { lahtoSeq = alkuSeq } else { lahtoSeq = await terveysSeq() }
                let (v, _): (ListaVastaus<SkooppiYhteenveto>, lahde: String?) = try await a.hae("/api/skoopit")
                switch v {
                case .kokonainen(let lista):
                    skoopit = lista
                    skooppiSeq = lahtoSeq
                case .erot(let e):
                    skoopit = yhdista([], e, tunniste: { $0.nimi })
                    skooppiSeq = e.seq
                }
            }
            yhteys = .auki
        } catch {
            kasitteleVirhe(error)
        }
    }

    public func paivitaViestit(_ nimi: String) async {
        guard let a = asiakas else { return }
        do {
            let (v, _): (SkooppiViestit, lahde: String?) = try await a.hae("/api/skoopit/\(Asiakas.koodaa(nimi))/viestit", aikaraja: 60)
            viestit[nimi] = v
            yhteys = .auki
        } catch {
            kasitteleVirhe(error)
        }
    }

    /// "skoopit"|"lahde"|"rekisterit" → skoopit (200 ms yhdistys); "peili"|"viestit" → valitun skoopin viestit.
    public func kasittele(_ m: Muutos) {
        switch m.polku {
        case "skoopit", "lahde", "rekisterit":
            if skooppiTyo == nil {
                let viive = yhdistysViive
                skooppiTyo = Task { [weak self] in
                    try? await Task.sleep(nanoseconds: viive)
                    guard !Task.isCancelled, let self else { return }
                    self.skooppiTyo = nil
                    await self.paivitaSkoopit()
                }
            }
        case "tila":
            let tilaSynkka = tila
            Task { await tilaSynkka.sovella(m) }
        case "peili", "viestit":
            if viestiTyo == nil, valittu != nil || !seurattavat.isEmpty {
                let viive = yhdistysViive
                viestiTyo = Task { [weak self] in
                    try? await Task.sleep(nanoseconds: viive)
                    guard !Task.isCancelled, let self else { return }
                    self.viestiTyo = nil
                    for n in self.paivitettavat { await self.paivitaViestit(n) }
                }
            }
        default:
            break
        }
    }

    /// Nollaus: kaikki listat ilman since.
    func paivitaKaikki() async {
        skooppiSeq = nil
        await paivitaSkoopit()
        for n in paivitettavat { await paivitaViestit(n) }
    }

    /// Valittu skooppi ja sivupalkissa näkyvät rivit (lukemattomien merkki), kukin kerran.
    private var paivitettavat: [String] {
        var nimet: [String] = []
        if let v = valittu { nimet.append(v) }
        for n in seurattavat.sorted() where n != valittu { nimet.append(n) }
        return nimet
    }

    /// Sivupalkin näkyvät rivit; niiden viestit pidetään ajan tasalla lukemattomien laskentaa varten.
    @ObservationIgnored private var seurattavat: Set<String> = []

    /// Viestihaut ovat raskaita (sillan kautta sekunteja ja ne jonottavat ytimessä): seuranta hakee yhden skoopin kerrallaan eikä
    /// kilpaile valitun skoopin viestien kanssa, jotta käyttäjän avaama skooppi latautuu ensin.
    @ObservationIgnored private var lukemattomienHaut = 0

    public func seuraaLukemattomia(_ nimi: String) async {
        seurattavat.insert(nimi)
        guard viestit[nimi] == nil else { return }
        let raja = Date().addingTimeInterval(90)
        while lukemattomienHaut >= 1 || valitunLataus {
            try? await Task.sleep(nanoseconds: 200_000_000)
            if Task.isCancelled || viestit[nimi] != nil || Date() > raja { break }
        }
        guard viestit[nimi] == nil else { return }
        lukemattomienHaut += 1
        defer { lukemattomienHaut -= 1 }
        // Kylmä silta voi ylittää pyynnön aikarajan: yritä uudelleen muutaman kerran.
        for yritys in 0..<3 {
            await paivitaViestit(nimi)
            if viestit[nimi] != nil || Task.isCancelled { return }
            try? await Task.sleep(nanoseconds: UInt64(yritys + 1) * 2_000_000_000)
        }
    }

    /// Valittu skooppi, jonka viestejä ei ole vielä ladattu.
    private var valitunLataus: Bool {
        if let v = valittu { return viestit[v] == nil }
        return false
    }

    public func lopetaSeuranta(_ nimi: String) {
        seurattavat.remove(nimi)
    }

    /// Lukemattomat = viestit, joiden rivinro > kuittaus; nil kunnes skoopin viestit on ladattu.
    public func lukemattomia(_ nimi: String) -> Int? {
        guard let v = viestit[nimi] else { return nil }
        return TilaAvain.lukemattomia(v.viestit, kuittaus: tila.luku(TilaAvain.kuittaus(nimi)))
    }

    private func virranTila(_ auki: Bool) {
        if auki {
            yhteys = .auki
        } else if yhteys != .avain {
            yhteys = .katki
        }
    }

    private func kasitteleVirhe(_ virhe: Error) {
        if let v = virhe as? ApiVirhe, v.tila == 401 {
            yhteys = .avain
        } else if yhteys != .avain {
            yhteys = .katki
        }
    }

    private func terveysSeq() async -> Int? {
        guard let a = asiakas else { return nil }
        let r: (Terveys, lahde: String?)? = try? await a.hae("/api/terveys")
        return r?.0.seq
    }
}
