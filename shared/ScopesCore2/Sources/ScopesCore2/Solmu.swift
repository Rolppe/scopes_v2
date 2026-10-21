// S-8a: äpin sisäinen ydin XCFrameworkin C-rajapinnalla (scopes_solmu.h). Yksi solmu per prosessi.
import Foundation
import ScopesSolmu
#if os(iOS)
import UIKit
#endif

public struct SolmuAsetukset: Codable, Sendable {
    public var data: URL
    public var avain: String
    public var vertaiset: [URL]
    public var vanha: URL?
    public var headless: Bool
    public var laite: String
    /// 0 = järjestelmän valitsema; kiinteä portti vain testeille (kaksi-laitetta.sh: solmut ovat toistensa vertaisia).
    public var portti: Int
    /// S-9: transkriptipeilin ikkuna vuorokausina; nil = täysi solmu (asetukset_json "peili_ikkuna_vrk": null).
    public var peiliIkkunaVrk: Int?
    /// S-9: peilin katto megatavuina (asetukset_json "peili_katto_mt"); käytössä vain ikkunan kanssa.
    public var peiliKattoMt: Int

    public init(data: URL, avain: String, vertaiset: [URL] = [], vanha: URL? = nil, headless: Bool = false, laite: String, portti: Int = 0,
                peiliIkkunaVrk: Int? = nil, peiliKattoMt: Int = Oletukset.peiliKattoMt) {
        self.data = data
        self.avain = avain
        self.vertaiset = vertaiset
        self.vanha = vanha
        self.headless = headless
        self.laite = laite
        self.portti = portti
        self.peiliIkkunaVrk = peiliIkkunaVrk
        self.peiliKattoMt = peiliKattoMt
    }

    /// scopes_solmu_kaynnista-kutsun asetukset_json (scopes_solmu.h).
    func ytimenAsetukset() -> [String: Any] {
        var vanhaArvo: Any = NSNull()
        if let v = vanha { vanhaArvo = v.absoluteString }
        return [
            "data": data.path,
            "avain": avain,
            "portti": portti,
            "vertaiset": vertaiset.map { $0.absoluteString },
            "vanha": vanhaArvo,
            "vanha_avain": avain,
            "headless": headless,
            "laite": laite,
            "peili_ikkuna_vrk": peiliIkkunaVrk.map { $0 as Any } ?? NSNull(),
            "peili_katto_mt": peiliKattoMt
        ]
    }
}

public enum SolmuVirhe: Error, Sendable {
    case kaynnistys(koodi: Int32, viesti: String)
    case jo_kaynnissa
    case avain_puuttuu
}

public actor Solmu {
    public static let jaettu = Solmu()

    private var _osoite: URL?

    public init() {}

    /// Ytimen versio: kaynnista-vastauksen "versio" (S-8a); nil, kun solmu ei ole käynnissä.
    public private(set) var versio: String?

    public var osoite: URL? { _osoite }

    /// Käynnistää solmun ja palaa, kun portti kuuntelee. Palauttaa http://127.0.0.1:<portti>.
    public func kaynnista(_ a: SolmuAsetukset) throws -> URL {
        if _osoite != nil { throw SolmuVirhe.jo_kaynnissa }
        guard !a.avain.isEmpty else { throw SolmuVirhe.avain_puuttuu }
        let asetukset = a.ytimenAsetukset()
        let json = try JSONSerialization.data(withJSONObject: asetukset)
        guard let jsonTeksti = String(data: json, encoding: .utf8) else {
            throw SolmuVirhe.kaynnistys(koodi: -1, viesti: "asetukset eivät ole UTF-8")
        }
        var ulos = [CChar](repeating: 0, count: 4096)
        let koko = ulos.count
        let koodi: Int32 = ulos.withUnsafeMutableBufferPointer { puskuri in
            scopes_solmu_kaynnista(jsonTeksti, puskuri.baseAddress, koko)
        }
        let vastaus = ulos.withUnsafeBufferPointer { String(cString: $0.baseAddress!) }
        guard koodi >= 1 else {
            if koodi == -4 { throw SolmuVirhe.jo_kaynnissa }
            let viesti = (try? JSONSerialization.jsonObject(with: Data(vastaus.utf8)) as? [String: Any])?["virhe"] as? String
            throw SolmuVirhe.kaynnistys(koodi: koodi, viesti: viesti ?? vastaus)
        }
        guard let url = URL(string: "http://127.0.0.1:\(koodi)") else {
            throw SolmuVirhe.kaynnistys(koodi: koodi, viesti: "osoite ei kelpaa")
        }
        _osoite = url
        versio = (try? JSONSerialization.jsonObject(with: Data(vastaus.utf8)) as? [String: Any])?["versio"] as? String
        return url
    }

    /// scopes_solmu_pysayta: sulkee kuuntelijan ja taustatehtävät (enintään 5 s).
    public func pysayta() {
        _ = scopes_solmu_pysayta()
        _osoite = nil
        versio = nil
    }
}

public enum Oletukset {
    /// S-9: peilin oletuskatto (Mt).
    public static let peiliKattoMt = 38
    /// UserDefaults-avaimet (laitekohtaiset; ei tila-avain eikä synkkaa). Käynnistysargumentti `-scopes2.peili-ikkuna-vrk <n>`
    /// tulee UserDefaultsin argumenttialueelle ja ohittaa tallennetun arvon.
    public static let peiliIkkunaAvain = "scopes2.peili-ikkuna-vrk"
    public static let peiliKattoAvain = "scopes2.peili-katto-mt"

    /// Fyysinen iOS-laite 7 vrk; simulaattori ja macOS 0 = täysi solmu (P-17).
    public static var peiliIkkunaOletusVrk: Int {
        #if os(iOS) && !targetEnvironment(simulator)
        return 7
        #else
        return 0
        #endif
    }

    /// Peilin ikkuna vuorokausina; nil (täysi solmu), kun arvo on 0 tai negatiivinen.
    public static func peiliIkkunaVrk(_ d: UserDefaults = .standard, oletus: Int? = nil) -> Int? {
        let n = d.object(forKey: peiliIkkunaAvain) != nil ? d.integer(forKey: peiliIkkunaAvain) : (oletus ?? peiliIkkunaOletusVrk)
        return n > 0 ? n : nil
    }

    /// Peilin katto Mt; oletus 38, ei-positiivinen arvo → oletus.
    public static func peiliKattoMt(_ d: UserDefaults = .standard) -> Int {
        let n = d.object(forKey: peiliKattoAvain) != nil ? d.integer(forKey: peiliKattoAvain) : peiliKattoMt
        return n > 0 ? n : peiliKattoMt
    }

    /// Testikoukku (T-52): SCOPES2_PORTTI = solmun kiinteä portti; SCOPES2_VERTAISET = pilkuilla erotetut lisävertaiset.
    /// Tuotannossa ei asetettu. Tarvitaan, koska replikointi vetää vain vertaisen virrasta: kaksi laitetta näkevät toistensa
    /// tilamuutokset vain, jos ne ovat toistensa vertaisia (palvelimen koeydin ei tunne äppien osoitteita).
    public static func testiPortti() -> Int {
        ProcessInfo.processInfo.environment["SCOPES2_PORTTI"].flatMap(Int.init) ?? 0
    }

    public static func testiVertaiset() -> [URL] {
        (ProcessInfo.processInfo.environment["SCOPES2_VERTAISET"] ?? "")
            .split(separator: ",").compactMap { URL(string: $0.trimmingCharacters(in: .whitespaces)) }
    }

    /// Macin tilapäinen tunneli koeytimeen (P-14); ei tuotannon 8797:ää. Ympäristö SCOPES2_VERTAINEN ohittaa.
    public static var vertainen: URL {
        if let s = ProcessInfo.processInfo.environment["SCOPES2_VERTAINEN"], !s.isEmpty, let u = URL(string: s) { return u }
        return URL(string: "http://127.0.0.1:18797")!
    }

    /// Application Support/com.example.scopes-v2/ydin (luodaan).
    public static func dataHakemisto() -> URL {
        let tuki = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
            ?? FileManager.default.temporaryDirectory
        let kansio = tuki.appendingPathComponent("com.example.scopes-v2/ydin", isDirectory: true)
        try? FileManager.default.createDirectory(at: kansio, withIntermediateDirectories: true)
        return kansio
    }

    /// macOS: "mac-<hostname>", iOS: "ios-<identifierForVendor 8 merkkiä>".
    public static func laite() -> String {
        #if os(iOS)
        let tunnus: String = {
            func lue() -> String {
                MainActor.assumeIsolated { UIDevice.current.identifierForVendor?.uuidString ?? "00000000" }
            }
            return Thread.isMainThread ? lue() : DispatchQueue.main.sync { lue() }
        }()
        return "ios-" + String(tunnus.prefix(8)).lowercased()
        #else
        var nimi = ProcessInfo.processInfo.hostName
        if let piste = nimi.firstIndex(of: ".") { nimi = String(nimi[nimi.startIndex..<piste]) }
        let sallitut = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
        let siisti = String(nimi.map { sallitut.contains($0) ? $0 : "-" })
        return "mac-" + (siisti.isEmpty ? "tuntematon" : siisti.lowercased())
        #endif
    }
}
