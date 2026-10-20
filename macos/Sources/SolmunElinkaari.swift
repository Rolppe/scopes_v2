// T-49: solmun asetukset ja käynnistys macOS-äpille (Contract: avain Avain.hae(), vertaiset UserDefaults → SCOPES2_VERTAINEN → Oletukset,
// vanha = sama vertainen (P-14), headless UserDefaults "scopes2.headless", data SCOPES2_DATA testeissä).
import Foundation
import ScopesCore2

enum SolmunElinkaari {
    static func asetukset() -> SolmuAsetukset? {
        guard let avain = Avain.hae() else { return nil }
        let ymparisto = ProcessInfo.processInfo.environment
        let vertainen: URL = {
            if let s = UserDefaults.standard.string(forKey: "scopes2.vertainen"), let u = URL(string: s) { return u }
            if let s = ymparisto["SCOPES2_VERTAINEN"], !s.isEmpty, let u = URL(string: s) { return u }
            return Oletukset.vertainen
        }()
        let data: URL = {
            if let s = ymparisto["SCOPES2_DATA"], !s.isEmpty {
                let u = URL(fileURLWithPath: s, isDirectory: true)
                try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
                return u
            }
            return Oletukset.dataHakemisto()
        }()
        return SolmuAsetukset(data: data, avain: avain, vertaiset: [vertainen] + Oletukset.testiVertaiset(), vanha: vertainen,
                              headless: UserDefaults.standard.bool(forKey: "scopes2.headless"), laite: Oletukset.laite(),
                              portti: Oletukset.testiPortti())
    }

    /// Käynnistää solmun, jos se ei ole käynnissä; puuttuva avain ei ole virhe (asetusnäkymä avautuu).
    static func kaynnista() async {
        if await Solmu.jaettu.osoite != nil { return }
        guard let a = asetukset() else { return }
        do {
            _ = try await Solmu.jaettu.kaynnista(a)
        } catch {
            NSLog("scopes-V2: solmun käynnistys epäonnistui: \(error)")
        }
    }

    /// Headless-kytkimen muutos (T-52): pysäytys ja käynnistys uusilla asetuksilla.
    static func uudelleen() async {
        await Solmu.jaettu.pysayta()
        await kaynnista()
    }

    static func asiakas() async -> Asiakas? {
        guard let avain = Avain.hae() else { return nil }
        let osoite: URL
        if let oma = await Solmu.jaettu.osoite { osoite = oma } else { osoite = Oletukset.vertainen }
        return Asiakas(osoite: osoite, avain: avain)
    }
}
