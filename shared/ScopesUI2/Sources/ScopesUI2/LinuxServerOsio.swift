// ARK-19 (T-87): palvelimen tila, herätys ja sammutus Infra-välilehdellä (GET /api/palvelin, POST /api/palvelin/<kaynnista|sammuta>).
// pohja: scopes/ios/Sources/Infra.swift:305-365 (LinuxServerOsio) (21.10.2026). Käynnistys herättää PC:n (WoL) ja vaihtaa Windowsin
// Linuxiin; sammutus vain, kun Linux on päällä. Molemmat vahvistetaan, ja vahvistus kertoo, mitä PC:lle tapahtuu: sammutus ei lähde
// ilman vahvistusdialogia, eikä peruutus lähetä mitään. Toiminnon jälkeen tila tulee vastauksesta (ping vastaa vielä hetken
// sammutuksen jälkeen); päivitysnappi lukee sen uudelleen.
import SwiftUI
import ScopesCore2

public struct LinuxServerOsio: View {
    let asiakas: Asiakas

    @State private var tila: LinuxServerTila?
    @State private var vahvista: LinuxToiminto?
    @State private var kaynnissa: LinuxToiminto?
    @State private var viesti: String?
    @State private var virhe: String?

    public init(asiakas: Asiakas) {
        self.asiakas = asiakas
    }

    private var paalla: Bool { tila?.tila == "linux" }

    public var body: some View {
        Section("palvelin") {
            HStack {
                Text("Tila")
                Spacer()
                Text(Self.nimi(tila?.tila)).foregroundStyle(.secondary).accessibilityIdentifier("linux-tila")
                Button { Task { await lataa() } } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless).disabled(kaynnissa != nil)
                    .accessibilityLabel("Päivitä palvelimen tila").accessibilityIdentifier("linux-paivita")
            }
            .task { await lataa() }
            Button { vahvista = .kaynnista } label: { Label("Käynnistä", systemImage: "power") }
                .disabled(kaynnissa != nil || paalla)
                .accessibilityIdentifier("linux-kaynnista")
            Button(role: .destructive) { vahvista = .sammuta } label: { Label("Sammuta", systemImage: "poweroff") }
                .disabled(kaynnissa != nil || !paalla)
                .accessibilityIdentifier("linux-sammuta")
            if let k = kaynnissa {
                ProgressView(k == .kaynnista ? "Käynnistetään… (enintään 2 min)" : "Sammutetaan…")
            }
            if let viesti { Text(viesti).font(.footnote).foregroundStyle(.secondary).accessibilityIdentifier("linux-viesti") }
            if let virhe { Text(virhe).font(.footnote).foregroundStyle(.red).accessibilityIdentifier("linux-virhe") }
        }
        .confirmationDialog(vahvista.map { Self.vahvistus($0, tila: tila).kysymys } ?? "",
                            isPresented: Binding(get: { vahvista != nil }, set: { if !$0 { vahvista = nil } }),
                            titleVisibility: .visible, presenting: vahvista) { t in
            Button(Self.vahvistus(t, tila: tila).nappi, role: t == .sammuta ? .destructive : nil) { Task { await aja(t) } }
                .accessibilityIdentifier("linux-vahvista")
            Button("Peruuta", role: .cancel) {}
                .accessibilityIdentifier("linux-peruuta")
        } message: { t in
            Text(Self.vahvistus(t, tila: tila).seuraus)
        }
    }

    static func nimi(_ tila: String?) -> String {
        switch tila {
        case "linux": return "Linux päällä"
        case "windows": return "Windows päällä"
        case "sammuksissa": return "Sammuksissa"
        case "vaihtaa": return "Vaihtaa Linuxiin…"
        case "heratetty": return "Herätetty"
        case "sammuu": return "Sammuu…"
        default: return "Ei tiedossa"
        }
    }

    static func vahvistus(_ t: LinuxToiminto, tila: LinuxServerTila?) -> (kysymys: String, seuraus: String, nappi: String) {
        switch t {
        case .kaynnista:
            return ("Käynnistetäänkö palvelin?",
                    tila?.tila == "windows" ? "PC:ssä on Windows päällä: se käynnistyy uudelleen Linuxiin (noin 45 s)."
                                            : "PC herätetään verkon yli. Jos se nousee Windowsiin, se vaihdetaan Linuxiin.",
                    "Käynnistä palvelin")
        case .sammuta:
            return ("Sammutetaanko palvelin?",
                    "PC sammuu. LM Studion paikalliset mallit ja muut palvelimen palvelut ovat poissa, kunnes se käynnistetään.",
                    "Sammuta palvelin")
        }
    }

    private func lataa() async {
        do {
            tila = try await asiakas.linuxServer()
            virhe = nil
        } catch {
            if Task.isCancelled || (error as? URLError)?.code == .cancelled { return }
            virhe = "palvelimen tila: \(Self.virheteksti(error))"
        }
    }

    private func aja(_ t: LinuxToiminto) async {
        kaynnissa = t
        viesti = nil
        virhe = nil
        defer { kaynnissa = nil }
        do {
            let v = try await asiakas.linuxToiminto(t)
            tila = LinuxServerTila(tila: v.tila, osoite: tila?.osoite)
            viesti = [v.viesti, v.kuiva.map { "kuiva: \($0)" }].compactMap { $0 }.joined(separator: " · ")
        } catch {
            virhe = Self.virheteksti(error)
        }
    }

    static func virheteksti(_ virhe: Error) -> String {
        if let v = virhe as? ApiVirhe, v.tila == 503 { return "Toimintoportti ei vastaa (503)." }
        return String(Virheteksti.muodosta(virhe).prefix(200))
    }
}
