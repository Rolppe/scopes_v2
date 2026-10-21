// kopio: scopes/shared/ScopesCore/Sources/ScopesCore/Models/ScopeModels.swift:3-104 (SkooppiYhteenveto, Seuraava, Viesti, Vaihtoehto, Kysymys, SkooppiViestit) (19.10.2026)
// kopio: scopes/shared/ScopesCore/Sources/ScopesCore/Models/ScopeModels.swift:134-152 (LiiteVastaus; S-8b lisää sha256 ja solmu) (19.10.2026)
// kopio: scopes/shared/ScopesCore/Sources/ScopesCore/Models/ScopeModels.swift:174-216 (ChatKeskustelu, ChatKeskustelunViestit, Agentti) (19.10.2026)
// kopio: scopes/shared/ScopesCore/Sources/ScopesCore/Models/ScopeModels.swift:267-299 (Konteksti, Istunto; SkooppiViestit tarvitsee ne) (19.10.2026)
import Foundation

public struct SkooppiYhteenveto: Codable, Identifiable, Hashable, Sendable {
    public let nimi: String
    public let seuraava: String?
    public let avoimia: Int
    public let vikoja: Int
    public let istuntoja: Int
    public let suurinKonteksti: Int?
    public let aika: String?
    public let tila: String?

    public var id: String { nimi }
    public var tilaNyt: String { tila ?? (istuntoja > 0 ? "kasittely" : "pakattu") }

    public init(nimi: String, seuraava: String? = nil, avoimia: Int = 0, vikoja: Int = 0, istuntoja: Int = 0, suurinKonteksti: Int? = nil, aika: String? = nil, tila: String? = nil) {
        self.nimi = nimi
        self.seuraava = seuraava
        self.avoimia = avoimia
        self.vikoja = vikoja
        self.istuntoja = istuntoja
        self.suurinKonteksti = suurinKonteksti
        self.aika = aika
        self.tila = tila
    }
}

public struct Seuraava: Codable, Hashable, Sendable {
    public let id: String?
    public let kuvaus: String
    public let polut: [String]
    public let aloitus: String?

    public init(id: String? = nil, kuvaus: String, polut: [String], aloitus: String? = nil) {
        self.id = id
        self.kuvaus = kuvaus
        self.polut = polut
        self.aloitus = aloitus
    }
}

/// Viesti. `id` on ytimen vakaa tunniste "<istunto>:<rivinro>"; puuttuessa SkooppiViestit antaa rivin indeksin.
public struct Viesti: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public let rooli: String
    public var teksti: String
    public let aika: String?
    public var kysymykset: [Kysymys]?
    public var vastattu: Bool?
    public var omaViesti: Bool { rooli == "kayttaja" }
    public var tyokalu: Bool { rooli == "tyokalu" }

    private enum CodingKeys: String, CodingKey {
        case id, rooli, teksti, aika, kysymykset, vastattu
    }

    public init(rooli: String, teksti: String, aika: String? = nil, kysymykset: [Kysymys]? = nil, vastattu: Bool? = nil, id: String = "") {
        self.id = id
        self.rooli = rooli
        self.teksti = teksti
        self.aika = aika
        self.kysymykset = kysymykset
        self.vastattu = vastattu
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decodeIfPresent(String.self, forKey: .id) ?? ""
        self.rooli = try c.decode(String.self, forKey: .rooli)
        self.teksti = try c.decode(String.self, forKey: .teksti)
        self.aika = try c.decodeIfPresent(String.self, forKey: .aika)
        self.kysymykset = try c.decodeIfPresent([Kysymys].self, forKey: .kysymykset)
        self.vastattu = try c.decodeIfPresent(Bool.self, forKey: .vastattu)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(rooli, forKey: .rooli)
        try c.encode(teksti, forKey: .teksti)
        try c.encodeIfPresent(aika, forKey: .aika)
        try c.encodeIfPresent(kysymykset, forKey: .kysymykset)
        try c.encodeIfPresent(vastattu, forKey: .vastattu)
    }
}

public struct Vaihtoehto: Codable, Hashable, Sendable, Identifiable {
    public let nimi: String
    public let kuvaus: String?
    public var id: String { nimi }

    public init(nimi: String, kuvaus: String? = nil) {
        self.nimi = nimi
        self.kuvaus = kuvaus
    }
}

public struct Kysymys: Codable, Hashable, Sendable, Identifiable {
    public let kysymys: String
    public let otsikko: String?
    public let monivalinta: Bool
    public let vaihtoehdot: [Vaihtoehto]
    public var id: String { kysymys }

    public init(kysymys: String, otsikko: String? = nil, monivalinta: Bool = false, vaihtoehdot: [Vaihtoehto] = []) {
        self.kysymys = kysymys
        self.otsikko = otsikko
        self.monivalinta = monivalinta
        self.vaihtoehdot = vaihtoehdot
    }
}

public struct SkooppiViestit: Codable, Hashable, Sendable {
    public let nimi: String
    public let auki: Bool
    public let pakattu: Bool?
    public let voiLahettaa: Bool
    public let viestit: [Viesti]
    public let istunto: Istunto?
    /// S-9: true = ikkunoitu solmu ei saanut haettua vanhempia viestejä vertaiselta (ytimen "haettavissa"; puuttuu täydeltä solmulta).
    public let haettavissa: Bool

    public init(nimi: String, auki: Bool, pakattu: Bool? = nil, voiLahettaa: Bool = true, viestit: [Viesti] = [], istunto: Istunto? = nil, haettavissa: Bool = false) {
        self.nimi = nimi
        self.auki = auki
        self.pakattu = pakattu
        self.voiLahettaa = voiLahettaa
        self.viestit = viestit
        self.istunto = istunto
        self.haettavissa = haettavissa
    }

    private enum CodingKeys: String, CodingKey {
        case nimi, auki, pakattu, voiLahettaa, viestit, istunto, haettavissa
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.nimi = try c.decode(String.self, forKey: .nimi)
        self.auki = try c.decode(Bool.self, forKey: .auki)
        self.pakattu = try c.decodeIfPresent(Bool.self, forKey: .pakattu)
        self.voiLahettaa = try c.decode(Bool.self, forKey: .voiLahettaa)
        var rivit = try c.decodeIfPresent([Viesti].self, forKey: .viestit) ?? []
        // Viesti.id puuttuessa (vanha 8787-muoto): rivin indeksi.
        for i in rivit.indices where rivit[i].id.isEmpty { rivit[i].id = String(i) }
        self.viestit = rivit
        self.istunto = try c.decodeIfPresent(Istunto.self, forKey: .istunto)
        self.haettavissa = try c.decodeIfPresent(Bool.self, forKey: .haettavissa) ?? false
    }
}

/// S-9: GET /api/peili/koko. Ytimen avaimet ovat snake_case (ikkuna_vrk, katto_mt); vanhin on vanhimman sisällön aika (ms) tai null.
public struct PeiliKoko: Codable, Hashable, Sendable {
    public let tavut: Int
    public let yksikot: Int
    public let vanhin: Int?
    public let ikkunaVrk: Int?
    public let kattoMt: Int

    public init(tavut: Int, yksikot: Int, vanhin: Int? = nil, ikkunaVrk: Int? = nil, kattoMt: Int) {
        self.tavut = tavut
        self.yksikot = yksikot
        self.vanhin = vanhin
        self.ikkunaVrk = ikkunaVrk
        self.kattoMt = kattoMt
    }

    private enum CodingKeys: String, CodingKey {
        case tavut, yksikot, vanhin
        case ikkunaVrk = "ikkuna_vrk"
        case kattoMt = "katto_mt"
    }

    /// Käytetty koko megatavuina (1 048 576 tavua, kuten ytimen MT).
    public var kokoMt: Double { Double(tavut) / 1_048_576 }
}

/// S-9f: GET /api/peili/<tiedosto>/raaka. rivi on 1-pohjainen (kuten Viesti.id); seuraava on jatkokohta tai nil tiedoston lopussa.
public struct PeiliRaaka: Codable, Hashable, Sendable {
    public let rivi: Int
    public let rivit: [String]
    public let seuraava: Int?

    public init(rivi: Int, rivit: [String], seuraava: Int? = nil) {
        self.rivi = rivi
        self.rivit = rivit
        self.seuraava = seuraava
    }
}

// Palvelun vastaus liitteen tallennukseen: polku, koko tavuina, sha256 ja solmu, joka tallensi (S-8b).
public struct LiiteVastaus: Codable, Hashable, Sendable {
    public let polku: String
    public let koko: Int
    public let sha256: String?
    public let solmu: String?

    public init(polku: String, koko: Int, sha256: String? = nil, solmu: String? = nil) {
        self.polku = polku
        self.koko = koko
        self.sha256 = sha256
        self.solmu = solmu
    }

    // Palvelun yläraja (LIITTEEN_MAKSIMI) ja viestin muoto samoin kuin iOS:n Liite.viesti.
    public static let maksimi = 25 * 1024 * 1024

    public static func viesti(_ teksti: String, polut: [String]) -> String {
        guard !polut.isEmpty else { return teksti }
        let liitteet = "Liitteet: " + polut.joined(separator: " ")
        return teksti.isEmpty ? liitteet : teksti + "\n\n" + liitteet
    }
}

public struct ChatKeskustelu: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let otsikko: String
    public let agentti: String?
    public let viesteja: Int
    public let aika: String

    public init(id: String, otsikko: String, agentti: String? = nil, viesteja: Int = 0, aika: String = "") {
        self.id = id
        self.otsikko = otsikko
        self.agentti = agentti
        self.viesteja = viesteja
        self.aika = aika
    }
}

public struct ChatKeskustelunViestit: Codable, Hashable, Sendable {
    public let id: String
    public let agentti: String?
    public let viestit: [Viesti]

    public init(id: String, agentti: String? = nil, viestit: [Viesti] = []) {
        self.id = id
        self.agentti = agentti
        self.viestit = viestit
    }
}

public struct Agentti: Codable, Identifiable, Hashable, Sendable {
    public let nimi: String
    public let kuvaus: String
    public let tyyppi: String

    public var id: String { nimi }
    public var otsikko: String { kuvaus.isEmpty ? nimi : kuvaus }

    public init(nimi: String, kuvaus: String = "", tyyppi: String = "malli") {
        self.nimi = nimi
        self.kuvaus = kuvaus
        self.tyyppi = tyyppi
    }
}

public struct Konteksti: Codable, Hashable, Sendable {
    public let tokenit: Int
    public let aika: String?

    public init(tokenit: Int, aika: String? = nil) {
        self.tokenit = tokenit
        self.aika = aika
    }
}

public struct Istunto: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let nimi: String?
    public let tila: String?
    public let konteksti: Konteksti?
    public let pakattu: Bool?
    public let hereilla: Bool?
    public let malli: String?
    public let effort: String?
    public let tyyppi: String?

    public init(id: String, nimi: String? = nil, tila: String? = nil, konteksti: Konteksti? = nil, pakattu: Bool? = nil, hereilla: Bool? = nil, malli: String? = nil, effort: String? = nil, tyyppi: String? = nil) {
        self.id = id
        self.nimi = nimi
        self.tila = tila
        self.konteksti = konteksti
        self.pakattu = pakattu
        self.hereilla = hereilla
        self.malli = malli
        self.effort = effort
        self.tyyppi = tyyppi
    }
}

// ARK-19 (T-87): Android-etäohjaus ja palvelin. Rungot = vanhan 8787:n (T-79-G:n fixturet scopes2/adapteri/testidata/toiminnot/);
// kentät valinnaisia, koska toiminnot palauttavat eri osat, ja tuntemattomat kentät sallitaan.

/// GET /api/android (ytimen lähdetilasta tai adapterista): { hereilla, heratimme, koko, kuiva }.
public struct AndroidTila: Codable, Hashable, Sendable {
    public let hereilla: Bool?
    public let heratimme: Bool?
    /// Ruudun koko pikseleinä [leveys, korkeus].
    public let koko: [Int]?
    public let kuiva: Bool?

    public init(hereilla: Bool? = nil, heratimme: Bool? = nil, koko: [Int]? = nil, kuiva: Bool? = nil) {
        self.hereilla = hereilla
        self.heratimme = heratimme
        self.koko = koko
        self.kuiva = kuiva
    }
}

/// Geminin keskustelun viesti (`talteen`-vastaus).
public struct AndroidViesti: Codable, Hashable, Sendable {
    public let rooli: String
    public let teksti: String

    public init(rooli: String, teksti: String) {
        self.rooli = rooli
        self.teksti = teksti
    }
}

/// POST /api/android/<toiminto> ja /liite: { ok, piste, nimi, liitetty, lahetetty, polku, teksti, viestit, kuiva }.
/// `kuiva` on koepalvelimen (kuivatila) komento, joka olisi ajettu.
public struct AndroidVastaus: Codable, Hashable, Sendable {
    public let ok: Bool?
    public let piste: [Int]?
    public let nimi: String?
    public let liitetty: Bool?
    public let lahetetty: Bool?
    public let polku: String?
    public let teksti: String?
    public let viestit: [AndroidViesti]?
    public let kuiva: String?

    public init(ok: Bool? = nil, piste: [Int]? = nil, nimi: String? = nil, liitetty: Bool? = nil, lahetetty: Bool? = nil,
                polku: String? = nil, teksti: String? = nil, viestit: [AndroidViesti]? = nil, kuiva: String? = nil) {
        self.ok = ok
        self.piste = piste
        self.nimi = nimi
        self.liitetty = liitetty
        self.lahetetty = lahetetty
        self.polku = polku
        self.teksti = teksti
        self.viestit = viestit
        self.kuiva = kuiva
    }
}

/// Laitteen tuotostiedosto (GET /api/android/tuotokset); `aika` ISO-merkkijonona.
public struct AndroidTuotos: Codable, Identifiable, Hashable, Sendable {
    public let polku: String
    public let nimi: String
    public let koko: Int
    public let aika: String

    public var id: String { polku }

    public init(polku: String, nimi: String, koko: Int, aika: String) {
        self.polku = polku
        self.nimi = nimi
        self.koko = koko
        self.aika = aika
    }
}

struct AndroidTuotokset: Decodable {
    let tiedostot: [AndroidTuotos]
}

/// GET /api/palvelin: tila linux | windows | sammuksissa (pingin TTL:stä), osoite kun PC vastaa.
public struct LinuxServerTila: Codable, Hashable, Sendable {
    public let tila: String
    public let osoite: String?

    public init(tila: String, osoite: String? = nil) {
        self.tila = tila
        self.osoite = osoite
    }
}

/// POST /api/palvelin/<kaynnista|sammuta>: tila toiminnon jälkeen (vaihtaa, heratetty, linux, sammuu), `lahto` = tila ennen.
public struct LinuxServerVastaus: Codable, Hashable, Sendable {
    public let tila: String
    public let lahto: String?
    public let viesti: String?
    /// Koepalvelin (kuivatila): komento, joka olisi ajettu.
    public let kuiva: String?

    public init(tila: String, lahto: String? = nil, viesti: String? = nil, kuiva: String? = nil) {
        self.tila = tila
        self.lahto = lahto
        self.viesti = viesti
        self.kuiva = kuiva
    }
}
