// ARK-19 (T-87): Android-etäohjaus ja palvelimen tila, herätys ja sammutus Asiakas-laajennuksena.
// pohja: scopes/ios/Sources/Asiakas.swift:114-145 (linuxServer, android*) ja scopes/ios/Sources/Android.swift:134-141 (osuus) (21.10.2026)
// Reitit vastaavat ytimestä tai adapterista samoilla rungoilla (S-6, S-10), joten kutsuja ei riipu siitä, kumpi vastaa.
import Foundation

public enum LinuxToiminto: String, Sendable {
    case kaynnista, sammuta
}

extension Asiakas {
    // MARK: Android

    /// GET /api/android: ruudun hereillä-tila ja koko (ydin lähdetilasta tai adapteri).
    public func androidTila() async throws -> AndroidTila {
        let (v, _): (AndroidTila, lahde: String?) = try await hae("/api/android")
        return v
    }

    /// GET /api/android/ruutu?leveys=: JPEG-kuva (image/jpeg). Palvelin herättää ruudun, joten aikaraja on väljempi kuin tilalla.
    public func androidRuutu(leveys: Int = 720) async throws -> Data {
        try await ohjausTavut(try pyynto("/api/android/ruutu?leveys=\(leveys)", aikaraja: 15))
    }

    /// POST /api/android/<nimi>: napauta {x,y}, pyyhkaise {x1,y1,x2,y2,kesto}, nappi {nimi}, avaa, uusi, kirjoita {teksti,laheta},
    /// laheta, talteen. Palvelin sarjallistaa toiminnot, ja kirjoitus voi odottaa muiden perässä, joten aikaraja on pitkä.
    /// Ilman runkoa lähetetään `{}` (vanhan fixturen runko).
    public func androidToiminto(_ nimi: String, runko: Encodable? = nil) async throws -> AndroidVastaus {
        let kuorma: Encodable
        if let runko { kuorma = runko } else { kuorma = TyhjaRunko() }
        let (v, _): (AndroidVastaus, lahde: String?) = try await hae("/api/android/\(Self.koodaa(nimi))", metodi: "POST",
                                                                       runko: kuorma, aikaraja: 150)
        return v
    }

    /// POST /api/android/liite?nimi=<tiedosto>[&teksti=<viesti>]: tiedosto raakarunkona Geminin liitteeksi; `teksti` lähetetään liitteen kanssa.
    public func androidLiite(nimi: String, teksti: String? = nil, data: Data) async throws -> AndroidVastaus {
        var polku = "/api/android/liite?nimi=\(Self.kyselyArvo(nimi, oletus: "liite"))"
        if let teksti, !teksti.isEmpty { polku += "&teksti=\(Self.kyselyArvo(teksti, oletus: ""))" }
        let req = try pyynto(polku, metodi: "POST", runko: data, tyyppi: "application/octet-stream", aikaraja: 150)
        let (v, _): (AndroidVastaus, lahde: String?) = try await laheta(req)
        return v
    }

    /// GET /api/android/tuotokset: laitteen tuotostiedostot (Download, Pictures, …), uusin ensin.
    public func androidTuotokset() async throws -> [AndroidTuotos] {
        let (v, _): (AndroidTuotokset, lahde: String?) = try await hae("/api/android/tuotokset", aikaraja: 30)
        return v.tiedostot
    }

    /// GET /api/android/tuotos?polku=: yksi tuotostiedosto raakatavuina.
    public func androidTuotos(polku: String) async throws -> Data {
        try await ohjausTavut(try pyynto("/api/android/tuotos?polku=\(Self.kyselyArvo(polku, oletus: ""))", aikaraja: 150))
    }

    // MARK: palvelin

    /// GET /api/palvelin: { tila, osoite? }.
    public func linuxServer() async throws -> LinuxServerTila {
        let (v, _): (LinuxServerTila, lahde: String?) = try await hae("/api/palvelin")
        return v
    }

    /// POST /api/palvelin/<kaynnista|sammuta>. Herätys odottaa, kunnes PC vastaa (adapterissa enintään 90 s + kertaboot), siksi
    /// pitkä aikaraja. Muu toiminto kuin kaynnista/sammuta ei lähde verkkoon (ApiVirhe tila 0).
    public func linuxToiminto(_ toiminto: String) async throws -> LinuxServerVastaus {
        guard LinuxToiminto(rawValue: toiminto) != nil else {
            throw ApiVirhe(tila: 0, viesti: "tuntematon palvelin-toiminto: \(toiminto)")
        }
        let (v, _): (LinuxServerVastaus, lahde: String?) = try await hae("/api/palvelin/\(toiminto)", metodi: "POST",
                                                                           runko: TyhjaRunko(), aikaraja: 150)
        return v
    }

    public func linuxToiminto(_ toiminto: LinuxToiminto) async throws -> LinuxServerVastaus {
        try await linuxToiminto(toiminto.rawValue)
    }

    // MARK: apu

    /// Kyselyparametrin arvo: vain ASCII-kirjaimet, numerot sekä . _ - jäävät koodaamatta (ääkköset koodataan, ei CharacterSet.alphanumerics).
    static func kyselyArvo(_ arvo: String, oletus: String) -> String {
        let sallitut = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
        return arvo.addingPercentEncoding(withAllowedCharacters: sallitut) ?? oletus
    }

    fileprivate func ohjausTavut(_ req: URLRequest) async throws -> Data {
        let (data, vastaus) = try await session.data(for: req)
        guard let http = vastaus as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw Self.virhe(vastaus, data: data)
        }
        return data
    }
}

private struct TyhjaRunko: Encodable {}

/// Kosketuspiste ruutukuvassa → 0–1-murto-osat laitteen ruudusta. Kuva piirretään aspectFit, joten reunojen tyhjä alue ei kuulu kuvaan.
public struct AndroidOsuus: Equatable, Sendable {
    public let x: Double
    public let y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }

    /// `piste` ja `alue` näkymän koordinaateissa, `kuva` kuvan koossa; nil jos kokoja ei voi käyttää.
    public static func laske(piste: CGPoint, alue: CGSize, kuva: CGSize) -> AndroidOsuus? {
        guard kuva.width > 0, kuva.height > 0, alue.width > 0, alue.height > 0 else { return nil }
        let mittakaava = min(alue.width / kuva.width, alue.height / kuva.height)
        let leveys = kuva.width * mittakaava, korkeus = kuva.height * mittakaava
        return AndroidOsuus(x: Double((piste.x - (alue.width - leveys) / 2) / leveys),
                            y: Double((piste.y - (alue.height - korkeus) / 2) / korkeus))
    }

    /// Piste on kuvan sisällä (napautus ulkopuolelle ei lähde laitteelle).
    public var kuvassa: Bool { (0...1).contains(x) && (0...1).contains(y) }

    /// Sama osuus rajattuna kuvaan (vedon loppupiste saa olla reunan yli).
    public var rajattu: AndroidOsuus { AndroidOsuus(x: min(1, max(0, x)), y: min(1, max(0, y))) }
}
