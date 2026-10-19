// Näkymien puhdas logiikka erotettuna SwiftUI:sta (T-48), jotta se on testattavissa ilman näkymiä.
// kopio: scopes/macos/Sources/MacSidebar.swift:6-14, :246-256 (suodatus), MacQuestionCard.swift:57-61 (vastausteksti) (19.10.2026)
import Foundation
import ScopesCore2

public enum SkooppiSuodatus: String, CaseIterable, Identifiable, Sendable {
    case kaikki = "Kaikki"
    case aktiiviset = "Aktiiviset"
    case odottaa = "Odottaa"
    case pakattu = "Pakatut"

    public var id: String { rawValue }

    /// Hakusana (isot/pienet kirjaimet ja diakriitit ohitetaan) ja tilasuodatus.
    public static func suodata(_ skoopit: [SkooppiYhteenveto], haku: String, suodatus: SkooppiSuodatus) -> [SkooppiYhteenveto] {
        let sana = haku.trimmingCharacters(in: .whitespacesAndNewlines)
        return skoopit.filter { s in
            if !sana.isEmpty, !s.nimi.localizedCaseInsensitiveContains(sana) { return false }
            switch suodatus {
            case .kaikki: return true
            case .aktiiviset: return s.istuntoja > 0 || s.tilaNyt != "pakattu"
            case .odottaa: return s.tilaNyt == "odottaa" || s.tilaNyt == "kysely"
            case .pakattu: return s.tilaNyt == "pakattu"
            }
        }
    }
}

public enum Vastausteksti {
    /// Yksivalinta: vaihtoehdon nimi. Monivalinta: valitut nimet ", "-eroteltuna vaihtoehtojen järjestyksessä.
    public static func muodosta(_ kysymys: Kysymys, valitut: Set<String>, yksi: String? = nil) -> String {
        if !kysymys.monivalinta { return yksi ?? valitut.sorted().first ?? "" }
        let jarjestyksessa = kysymys.vaihtoehdot.map(\.nimi).filter { valitut.contains($0) }
        return jarjestyksessa.joined(separator: ", ")
    }
}

/// Chat-palojen kokoaminen: "teksti"-palat liitetään, "valmis" tallentaa keskustelu-id:n ja korvaa kootun tekstin
/// lopullisella vastauksella (katkon jälkeen palat voivat puuttua), "virhe" näkyy käyttäjälle.
public struct ChatKokoaja: Equatable, Sendable {
    public private(set) var teksti = ""
    public private(set) var keskustelu: String?
    public private(set) var virhe: String?
    public private(set) var valmis = false
    public private(set) var katkennut = false

    public init(keskustelu: String? = nil) { self.keskustelu = keskustelu }

    public mutating func kasittele(_ t: ChatTapahtuma) {
        switch t.tyyppi {
        case "teksti":
            if let p = t.teksti { teksti += p }
        case "valmis":
            if let v = t.vastaus, !v.isEmpty { teksti = v }
            if let k = t.keskustelu, !k.isEmpty { keskustelu = k }
            valmis = true
            katkennut = false
        case "virhe":
            virhe = t.virhe ?? "tuntematon virhe"
        default:
            break
        }
    }

    /// Yhteys katkesi kesken virran: osatulos säilyy, kunnes "valmis" korvaa sen.
    public mutating func katko(_ viesti: String) {
        guard !valmis else { return }
        katkennut = true
        virhe = viesti
    }
}

public enum RekisteriRaja: Equatable, Sendable {
    case eiRajaa, ok, lahella, ylitetty

    /// Rajaa lähestytään 80 %:sta; yli rajan on ylitetty. Ilman rajaa (null tai 0) ei luokitusta.
    public static func luokita(tavut: Int, raja: Int?) -> RekisteriRaja {
        guard let raja, raja > 0 else { return .eiRajaa }
        if tavut > raja { return .ylitetty }
        if Double(tavut) >= Double(raja) * 0.8 { return .lahella }
        return .ok
    }
}

/// Rivi GET /api/rekisterit-listassa.
public struct RekisteriRivi: Decodable, Identifiable, Hashable, Sendable {
    public let polku: String
    public let laji: String?
    public let skoopit: [String]
    public let tavut: Int
    public let raja: Int?
    public let tokenit: Int?
    public var id: String { polku }
    public var luokka: RekisteriRaja { RekisteriRaja.luokita(tavut: tavut, raja: raja) }

    public init(polku: String, laji: String? = nil, skoopit: [String] = [], tavut: Int = 0, raja: Int? = nil, tokenit: Int? = nil) {
        self.polku = polku
        self.laji = laji
        self.skoopit = skoopit
        self.tavut = tavut
        self.raja = raja
        self.tokenit = tokenit
    }

    private enum CodingKeys: String, CodingKey { case polku, laji, skoopit, tavut, raja, tokenit }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        polku = try c.decode(String.self, forKey: .polku)
        laji = try c.decodeIfPresent(String.self, forKey: .laji)
        skoopit = try c.decodeIfPresent([String].self, forKey: .skoopit) ?? []
        tavut = try c.decodeIfPresent(Int.self, forKey: .tavut) ?? 0
        raja = try c.decodeIfPresent(Int.self, forKey: .raja)
        tokenit = try c.decodeIfPresent(Int.self, forKey: .tokenit)
    }
}

/// GET /api/rekisterit/<polku> → {polku, osat:[{otsikko, teksti, tokenit}]}.
public struct RekisterinOsa: Decodable, Identifiable, Hashable, Sendable {
    public let otsikko: String
    public let teksti: String
    public let tokenit: Int?
    public var id: String { otsikko + "#" + String(teksti.hashValue) }
}

public struct RekisterinOsat: Decodable, Sendable {
    public let polku: String?
    public let osat: [RekisterinOsa]
}

/// GET /api/lr/ristiriidat → {"ristiriidat":[…]}; vain määrä kiinnostaa.
public struct RistiriitaMaara: Decodable, Sendable {
    struct Mikaan: Decodable { init(from decoder: Decoder) throws {} }
    let ristiriidat: [Mikaan]
    public var maara: Int { ristiriidat.count }
}

public enum Reitit {
    /// Rekisterin polku "a/b.md" → "/api/rekisterit/a/b.md" (jokainen osa koodattuna, kauttaviivat säilyvät).
    public static func rekisteri(_ polku: String) -> String {
        "/api/rekisterit/" + polku.split(separator: "/", omittingEmptySubsequences: false).map { Asiakas.koodaa(String($0)) }.joined(separator: "/")
    }

    public static func viesti(_ skooppi: String) -> String {
        "/api/skoopit/\(Asiakas.koodaa(skooppi))/viesti"
    }
}

/// Virheen näyttöteksti käyttäjälle (suomeksi).
public enum Virheteksti {
    public static func muodosta(_ virhe: Error) -> String {
        if let v = virhe as? ApiVirhe {
            if v.tila == 401 { return "Avain puuttuu tai on väärä (401)" }
            if let m = v.viesti, !m.isEmpty { return "\(m) (\(v.tila))" }
            return "Palvelin vastasi \(v.tila)"
        }
        if virhe is CancellationError { return "Keskeytetty" }
        return virhe.localizedDescription
    }
}

/// Viestilistan vieritys (E-33): vieritä loppuun vain, jos käyttäjä oli alhaalla tai viimeisin viesti on hänen oma.
public enum Vieritys {
    public static let alareunaRaja: Double = 40

    /// `sisalto`, `nakyma` ja `siirtyma` pisteinä; sisältö mahtuu näkymään tai etäisyys pohjaan on enintään raja.
    public static func onAlhaalla(sisaltoKorkeus: Double, nakymaKorkeus: Double, siirtymaY: Double) -> Bool {
        if sisaltoKorkeus <= nakymaKorkeus { return true }
        return sisaltoKorkeus - (siirtymaY + nakymaKorkeus) <= alareunaRaja
    }

    public static func vieritaLoppuun(alhaalla: Bool, vanhaMaara: Int, uusiMaara: Int, viimeinenOma: Bool) -> Bool {
        if vanhaMaara == 0 && uusiMaara > 0 { return true }
        if uusiMaara > vanhaMaara && viimeinenOma { return true }
        return alhaalla
    }
}

/// Liitteet: nimi ja koko ennen lähetystä.
public enum Liitteet {
    public static func nimi(_ url: URL) -> String { url.lastPathComponent.isEmpty ? "liite" : url.lastPathComponent }
    public static func kokoSallittu(_ tavut: Int) -> Bool { tavut <= LiiteVastaus.maksimi }
    public static func liikaaTeksti(_ nimi: String) -> String {
        "\(nimi): liite ylittää \(LiiteVastaus.maksimi / (1024 * 1024)) Mt:n rajan"
    }
}
