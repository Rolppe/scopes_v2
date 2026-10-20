// kopio: scopes/macos/Sources/MacSettingsView.swift:1-120 (palvelinasetukset: osoite, SecureField, tallennus) (19.10.2026), sovitettu Avain.tallenna:an;
// avain tallennetaan Keychainiin (Avain), arvoa ei näytetä eikä lokiteta
import SwiftUI
import ScopesCore2

public struct AsetuksetNakyma: View {
    let varasto: Varasto
    let asiakas: Asiakas?
    let avainMuuttui: () -> Void
    let headlessMuuttui: () -> Void

    @AppStorage("scopes2.headless") private var headless: Bool = false
    @AppStorage("scopes2.vertainen") private var vertainen: String = Oletukset.vertainen.absoluteString
    @State private var uusiAvain = ""
    @State private var avainOlemassa: Bool?
    @State private var ilmoitus: String?
    @State private var virhe: String?
    @State private var seq: String = "–"
    @State private var portti: String = "–"

    public init(varasto: Varasto, asiakas: Asiakas? = nil, avainMuuttui: @escaping () -> Void = {}, headlessMuuttui: @escaping () -> Void = {}) {
        self.varasto = varasto
        self.asiakas = asiakas
        self.avainMuuttui = avainMuuttui
        self.headlessMuuttui = headlessMuuttui
    }

    private struct Terveys: Decodable { let seq: Int? }

    public var body: some View {
        Form {
            Section("Avain") {
                SecureField("Palvelun avain", text: $uusiAvain)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("asetukset-avain")
                HStack {
                    Button("Tallenna avain") { tallenna() }
                        .disabled(uusiAvain.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("asetukset-tallenna")
                    Button("Poista avain", role: .destructive) { poista() }
                        .disabled(avainOlemassa != true)
                    Spacer()
                    Text(avainOlemassa == nil ? "" : (avainOlemassa == true ? "Avain on tallennettu" : "Avainta ei ole tallennettu"))
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let ilmoitus { Text(ilmoitus).font(.caption).foregroundStyle(.green) }
                if let virhe { Text(virhe).font(.caption).foregroundStyle(.red).accessibilityIdentifier("asetukset-virhe") }
            }
            Section("Vertainen") {
                TextField("Vertaisen osoite", text: $vertainen)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("asetukset-vertainen")
                Text("Käytetään, kun oma ydin ei ole käynnissä. Muutos tulee voimaan uudelleenyhdistettäessä.")
                    .font(.caption).foregroundStyle(.secondary)
                Button("Yhdistä uudelleen") { avainMuuttui() }
            }
            Section("Synkka") {
                Toggle("Headless (ei UI-tilan synkkaa)", isOn: $headless)
                    .accessibilityIdentifier("headless")
                    .onChange(of: headless) { _, _ in headlessMuuttui() }
                Text("Valinta, luonnos, vierityskohta ja suodatin pysyvät tällä laitteella; lukemattomien kuittaus synkataan silti. Solmu käynnistyy uudelleen.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("Yhteys") {
                LabeledContent("Tila", value: Self.yhteysTeksti(varasto.yhteys))
                    .accessibilityIdentifier("asetukset-yhteys")
                LabeledContent("Ytimen portti", value: portti)
                LabeledContent("Tapahtumanumero (seq)", value: seq)
                Button("Tarkista yhteys") { Task { await tarkista() } }
                    .disabled(asiakas == nil)
            }
        }
        .formStyle(.grouped)
        .task {
            avainOlemassa = Avain.hae() != nil
            if let o = await Solmu.jaettu.osoite, let p = o.port { portti = String(p) }
            await tarkista()
        }
    }

    static func yhteysTeksti(_ y: Yhteys) -> String {
        switch y {
        case .auki: return "Yhteys auki"
        case .katki: return "Yhteys katki"
        case .avain: return "Avain puuttuu tai on väärä"
        }
    }

    private func tallenna() {
        let a = uusiAvain.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            try Avain.tallenna(a)
            uusiAvain = ""
            avainOlemassa = true
            virhe = nil
            ilmoitus = "Avain tallennettu"
            avainMuuttui()
        } catch {
            virhe = "Avaimen tallennus epäonnistui: \(Virheteksti.muodosta(error))"
        }
    }

    private func poista() {
        Avain.poista()
        avainOlemassa = Avain.ymparistosta() != nil
        ilmoitus = "Avain poistettu"
        avainMuuttui()
    }

    private func tarkista() async {
        guard let asiakas else { seq = "–"; return }
        do {
            let (t, _): (Terveys, lahde: String?) = try await asiakas.hae("/api/terveys")
            seq = t.seq.map(String.init) ?? "–"
        } catch {
            seq = "virhe: \(Virheteksti.muodosta(error))"
        }
    }
}
