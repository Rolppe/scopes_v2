// T-49: iOS-kuori. Oma solmu (S-8a) käynnistyy etualalle tullessa ja pysähtyy taustalle mennessä.
// Näkymä rakennetaan uudelleen (.id) jokaisen solmun käynnistyksen jälkeen, jolloin JuuriNakyma ottaa uuden osoitteen.
import SwiftUI
import ScopesCore2
import ScopesUI2

@main
struct ScopesV2App: App {
    @Environment(\.scenePhase) private var vaihe
    @State private var sukupolvi = 0
    @State private var nakyvissa = false

    var body: some Scene {
        WindowGroup {
            Group {
                if nakyvissa {
                    JuuriNakyma(solmuUudelleen: { await Self.kaynnistaUudelleen() }).id(sukupolvi)
                } else {
                    Color.clear
                }
            }
            .task { await etualalle() }
        }
        .onChange(of: vaihe) { _, uusi in
            switch uusi {
            case .active: Task { await etualalle() }
            case .background: Task { await taustalle() }
            default: break
            }
        }
    }

    private func etualalle() async {
        if await Solmu.jaettu.osoite == nil, let asetukset = Self.solmunAsetukset() {
            do { _ = try await Solmu.jaettu.kaynnista(asetukset) } catch { /* näkymä näyttää yhteysvirheen vertaisen kautta */ }
        }
        sukupolvi += 1
        nakyvissa = true
    }

    /// Näkymä pois (sen yhteys ja virta loppuvat) ennen solmun pysäytystä.
    private func taustalle() async {
        nakyvissa = false
        await Solmu.jaettu.pysayta()
    }

    /// Headless-kytkimen muutos (T-52): solmu pysäytetään ja käynnistetään uusilla asetuksilla.
    static func kaynnistaUudelleen() async {
        await Solmu.jaettu.pysayta()
        if let asetukset = solmunAsetukset() { _ = try? await Solmu.jaettu.kaynnista(asetukset) }
    }

    /// Avain puuttuu → ei solmua; JuuriNakyma avaa asetukset.
    static func solmunAsetukset() -> SolmuAsetukset? {
        guard let avain = Avain.hae() else { return nil }
        let env = ProcessInfo.processInfo.environment
        let data: URL
        if let d = env["SCOPES2_DATA"], !d.isEmpty {
            data = URL(fileURLWithPath: d, isDirectory: true)
            try? FileManager.default.createDirectory(at: data, withIntermediateDirectories: true)
        } else {
            data = Oletukset.dataHakemisto()
        }
        let vertainen = UserDefaults.standard.string(forKey: "scopes2.vertainen").flatMap(URL.init(string:)) ?? Oletukset.vertainen
        return SolmuAsetukset(
            data: data,
            avain: avain,
            vertaiset: [vertainen] + Oletukset.testiVertaiset(),
            vanha: vertainen,
            headless: UserDefaults.standard.bool(forKey: "scopes2.headless"),
            laite: Oletukset.laite(),
            portti: Oletukset.testiPortti()
        )
    }
}
