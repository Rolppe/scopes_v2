// T-71 (K-11): laitekohtainen Kehitys-osio macOS-asetuksiin (ei synkata): näyttö hereillä -kytkin ja vain luettava diagnostiikka.
// Ei avainta, tunnelia eikä SCOPES2_DATA-asetusta (arvot vain luettavina riveinä: portti, data-hakemisto, vertainen, ytimen versio).
import SwiftUI
import ScopesCore2

struct KehitysOsio: View {
    let varasto: Varasto
    @State private var portti: String = "–"
    @State private var data: String = "–"
    @State private var vertainen: String = "–"
    @State private var versio: String = "–"

    private var nayttoHereilla: NayttoHereilla { .jaettu }

    var body: some View {
        Section("Kehitys") {
            Toggle("Näyttö hereillä", isOn: Binding(get: { nayttoHereilla.voimassa }, set: { nayttoHereilla.aseta($0) }))
                .accessibilityIdentifier("kehitys-naytto")
            Text(nayttoHereilla.voimassa ? "Väite voimassa" : "Ei väitettä")
                .font(.caption).foregroundStyle(.secondary)
                .accessibilityIdentifier("kehitys-naytto-tila")
            LabeledContent("Ytimen portti ja tila", value: portti)
                .accessibilityIdentifier("kehitys-portti")
            LabeledContent("Data-hakemisto", value: data)
                .textSelection(.enabled)
                .accessibilityIdentifier("kehitys-data")
            LabeledContent("Vertainen", value: "\(vertainen) (\(Self.yhteys(varasto.yhteys)))")
                .accessibilityIdentifier("kehitys-vertainen")
            LabeledContent("Ytimen versio", value: versio)
                .accessibilityIdentifier("kehitys-versio")
        }
        .task { await lataa() }
    }

    private static func yhteys(_ y: Yhteys) -> String {
        switch y {
        case .auki: return "auki"
        case .katki: return "katki"
        case .avain: return "avain puuttuu tai väärä"
        }
    }

    private func lataa() async {
        if let o = await Solmu.jaettu.osoite, let p = o.port { portti = "\(p) käynnissä" } else { portti = "ei käynnissä" }
        versio = await Solmu.jaettu.versio ?? "–"
        let a = SolmunElinkaari.asetukset()
        data = a?.data.path ?? "–"
        vertainen = a?.vanha?.absoluteString ?? "–"
    }
}
