// Jaettu juurinäkymä molemmille V2-äpeille (ARK-08): sivupalkki | välilehdet Viestit, Chat, Infra, Asetukset.
import SwiftUI
import ScopesCore2

public struct JuuriNakyma: View {
    enum Valilehti: String, CaseIterable, Identifiable {
        case viestit = "Viestit", chat = "Chat", infra = "Infra", asetukset = "Asetukset"
        var id: String { rawValue }
        var ikoni: String {
            switch self {
            case .viestit: return "text.bubble"
            case .chat: return "bubble.left.and.bubble.right"
            case .infra: return "server.rack"
            case .asetukset: return "gearshape"
            }
        }
    }

    @State private var varasto = Varasto()
    @State private var asiakas: Asiakas?
    @State private var valinta: String?
    @State private var valilehti: Valilehti = .viestit
    @State private var tila = "Yhdistetään…"

    public init() {}

    public var body: some View {
        NavigationSplitView {
            Sivupalkki(varasto: varasto, valinta: $valinta)
                .navigationTitle("scopes-V2")
        } detail: {
            TabView(selection: $valilehti) {
                viestit.tabItem { Label(Valilehti.viestit.rawValue, systemImage: Valilehti.viestit.ikoni) }.tag(Valilehti.viestit)
                chat.tabItem { Label(Valilehti.chat.rawValue, systemImage: Valilehti.chat.ikoni) }.tag(Valilehti.chat)
                infra.tabItem { Label(Valilehti.infra.rawValue, systemImage: Valilehti.infra.ikoni) }.tag(Valilehti.infra)
                asetukset.tabItem { Label(Valilehti.asetukset.rawValue, systemImage: Valilehti.asetukset.ikoni) }.tag(Valilehti.asetukset)
            }
        }
        .task { await yhdista() }
        .onChange(of: valinta) { _, uusi in varasto.valittu = uusi }
    }

    @ViewBuilder private var viestit: some View {
        if let asiakas, let valinta {
            SkoopinViestit(varasto: varasto, asiakas: asiakas, skooppi: valinta).id(valinta)
        } else {
            tyhja(asiakas == nil ? tila : "Valitse skooppi")
        }
    }

    @ViewBuilder private var chat: some View {
        if let asiakas { ChatNakyma(asiakas: asiakas) } else { tyhja(tila) }
    }

    @ViewBuilder private var infra: some View {
        if let asiakas { InfraNakyma(asiakas: asiakas) } else { tyhja(tila) }
    }

    private var asetukset: some View {
        AsetuksetNakyma(varasto: varasto, asiakas: asiakas) { Task { await yhdista() } }
    }

    private func tyhja(_ teksti: String) -> some View {
        Text(teksti).foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Oma ydin, jos käynnissä (T-49 käynnistää sen äpissä), muuten vertaisen osoite (UserDefaults "scopes2.vertainen", oletus P-14).
    private func yhdista() async {
        guard let avain = Avain.hae() else {
            asiakas = nil
            varasto.pysayta()
            tila = "Avain puuttuu. Aseta se Asetukset-välilehdellä."
            valilehti = .asetukset
            return
        }
        let osoite: URL
        if let oma = await Solmu.jaettu.osoite {
            osoite = oma
        } else if let s = UserDefaults.standard.string(forKey: "scopes2.vertainen"), let u = URL(string: s) {
            osoite = u
        } else {
            osoite = Oletukset.vertainen
        }
        let uusi = Asiakas(osoite: osoite, avain: avain)
        asiakas = uusi
        tila = "Yhdistetty"
        await varasto.kaynnista(asiakas: uusi)
    }
}
