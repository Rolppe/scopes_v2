// kopio: scopes/macos/Sources/MacChatView.swift:1-210 (19.10.2026), sovitettu Asiakas.virta-suoratoistoon; ei AppKitia
import SwiftUI
import ScopesCore2

struct ChatPyynto: Encodable {
    let teksti: String
    let agentti: String?
    let keskustelu: String?
}

public struct ChatNakyma: View {
    let asiakas: Asiakas

    @State private var agentit: [Agentti] = []
    @State private var valittuAgentti: String?
    @State private var keskustelu: String?
    @State private var viestit: [Viesti] = []
    @State private var luonnos = ""
    @State private var virhe: String?
    @State private var kesken = false
    @State private var tyo: Task<Void, Never>?
    @State private var alhaalla = true
    @State private var laskuri = 0

    public init(asiakas: Asiakas) {
        self.asiakas = asiakas
    }

    public var body: some View {
        VStack(spacing: 0) {
            yla
            Divider()
            if let v = virhe {
                HStack {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundColor(.yellow)
                    Text(v).font(.caption).accessibilityIdentifier("chat-virhe")
                    Spacer()
                    Button("Sulje") { virhe = nil }.buttonStyle(.borderless).font(.caption)
                }
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(Color.yellow.opacity(0.1))
            }
            if viestit.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "bubble.left.and.bubble.right").font(.system(size: 40)).foregroundColor(.secondary)
                    Text("Kysy mitä tahansa").font(.headline).foregroundColor(.secondary)
                    Text("Valitse agentti yläpalkista ja kirjoita kysymyksesi alle.").font(.caption).foregroundColor(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                lista
            }
            Divider()
            Syottokentta(
                teksti: $luonnos,
                tunnus: "chat",
                voiLahettaa: !kesken,
                laheta: { teksti, _ in await laheta(teksti) },
                stop: { pysayta() },
                kesken: kesken
            )
        }
        .task { await lataaAgentit() }
    }

    private var yla: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(otsikko).font(.title3).bold()
                Text(keskustelu == nil ? "Uusi keskustelu" : "Keskustelu jatkuu").font(.caption).foregroundColor(.secondary)
            }
            Spacer()
            Picker("Agentti", selection: $valittuAgentti) {
                ForEach(agentit) { a in Text(a.otsikko).tag(Optional(a.nimi)) }
            }
            .pickerStyle(.menu)
            .accessibilityIdentifier("chat-agentti")
            Button {
                uusi()
            } label: {
                Label("Uusi chat", systemImage: "plus")
            }
            .buttonStyle(.bordered)
            .disabled(kesken)
            .accessibilityIdentifier("chat-uusi")
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
    }

    private var otsikko: String {
        if let n = valittuAgentti, let a = agentit.first(where: { $0.nimi == n }) { return a.otsikko }
        return "Chat"
    }

    private var lista: some View {
        ScrollViewReader { vierita in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(viestit) { v in
                        Viestikupla(viesti: v)
                            .accessibilityElement(children: .combine)
                            .accessibilityIdentifier("chat-viesti")
                    }
                    if kesken {
                        HStack {
                            ProgressView().controlSize(.small)
                            Text("Kirjoittaa vastausta…").font(.caption).foregroundColor(.secondary)
                        }
                        .padding(.horizontal, 12)
                    }
                    Color.clear.frame(height: 1).id("loppu")
                }
                .padding(16)
            }
            .seuraaAlareunaa($alhaalla)
            .onChange(of: viestit.count) { vanha, uusi in
                if Vieritys.vieritaLoppuun(alhaalla: alhaalla, vanhaMaara: vanha, uusiMaara: uusi, viimeinenOma: viestit.last?.omaViesti == true) {
                    vierita.scrollTo("loppu", anchor: .bottom)
                }
            }
            .onChange(of: viestit.last?.teksti) {
                if alhaalla { vierita.scrollTo("loppu", anchor: .bottom) }
            }
        }
    }

    private func uusi() {
        keskustelu = nil
        viestit = []
        virhe = nil
    }

    private func lataaAgentit() async {
        do {
            let (a, _): ([Agentti], lahde: String?) = try await asiakas.hae("/api/agentit")
            agentit = a
            if valittuAgentti == nil { valittuAgentti = a.first?.nimi }
        } catch {
            virhe = "Agenttien lataus epäonnistui: \(Virheteksti.muodosta(error))"
        }
    }

    private func seuraavaId(_ etuliite: String) -> String {
        laskuri += 1
        return "\(etuliite)\(laskuri)"
    }

    private func laheta(_ teksti: String) async {
        guard !kesken, !teksti.isEmpty else { return }
        virhe = nil
        viestit.append(Viesti(rooli: "kayttaja", teksti: teksti, id: seuraavaId("k")))
        let vastausId = seuraavaId("a")
        viestit.append(Viesti(rooli: "assistentti", teksti: "", id: vastausId))
        kesken = true
        let pyynto = ChatPyynto(teksti: teksti, agentti: valittuAgentti, keskustelu: keskustelu)
        let virta = asiakas.virta("/api/chat/virta", runko: pyynto)
        let t = Task { @MainActor in
            var kokoaja = ChatKokoaja(keskustelu: keskustelu)
            do {
                for try await tapahtuma in virta {
                    kokoaja.kasittele(tapahtuma)
                    paivita(vastausId, kokoaja)
                }
            } catch is CancellationError {
            } catch {
                kokoaja.katko(Virheteksti.muodosta(error))
            }
            paivita(vastausId, kokoaja)
            keskustelu = kokoaja.keskustelu
            if let v = kokoaja.virhe { virhe = v }
            if kokoaja.teksti.isEmpty { viestit.removeAll { $0.id == vastausId } }
        }
        tyo = t
        await t.value
        tyo = nil
        kesken = false
    }

    private func paivita(_ id: String, _ k: ChatKokoaja) {
        guard let i = viestit.firstIndex(where: { $0.id == id }) else { return }
        viestit[i].teksti = k.teksti
    }

    private func pysayta() {
        tyo?.cancel()
        Task {
            do {
                let _: (TyhjaVastaus, lahde: String?) = try await asiakas.hae("/api/chat/stop", metodi: "POST", runko: [String: String]())
            } catch {
                virhe = "Pysäytys epäonnistui: \(Virheteksti.muodosta(error))"
            }
        }
    }
}
