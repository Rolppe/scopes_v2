// kopio: scopes/macos/Sources/MacLrView.swift:1-160 (otsikkopalkki, päivitys, virheilmoitus) (19.10.2026), sovitettu Asiakas.hae:hen;
// rekisterilista ja osat GET /api/rekisterit*, LR-ristiriidat GET /api/lr/ristiriidat
import SwiftUI
import ScopesCore2

public struct InfraNakyma: View {
    let asiakas: Asiakas

    @State private var rivit: [RekisteriRivi] = []
    @State private var lahde: String?
    @State private var ristiriidat: Int?
    @State private var virhe: String?
    @State private var lataa = false

    public init(asiakas: Asiakas) {
        self.asiakas = asiakas
    }

    public var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                yla
                Divider()
                if let virhe {
                    Text(virhe).font(.caption).foregroundStyle(.red).padding(8).accessibilityIdentifier("infra-virhe")
                }
                List {
                    // ARK-19 (T-87): kehityspaneelit. palvelimen osio ja linkki Android-etäohjaukseen.
                    LinuxServerOsio(asiakas: asiakas)
                    Section {
                        NavigationLink { AndroidNakyma(asiakas: asiakas) } label: { Label("Android-etäohjaus", systemImage: "iphone") }
                            .accessibilityIdentifier("infra-android")
                    }
                    Section("Rekisterit") {
                        ForEach(rivit) { r in
                            NavigationLink(value: r) { rivi(r) }
                                .accessibilityIdentifier("rekisteri-\(r.polku)")
                        }
                        if rivit.isEmpty && !lataa { Text("Ei rekistereitä").foregroundStyle(.secondary) }
                    }
                }
            }
            .navigationDestination(for: RekisteriRivi.self) { r in
                RekisterinOsatNakyma(asiakas: asiakas, rivi: r)
            }
        }
        .task { await lataaKaikki() }
    }

    private var yla: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("Rekisterit").font(.title3).bold()
                HStack(spacing: 8) {
                    Text(ristiriidat.map { "LR-ristiriitoja: \($0)" } ?? "LR-ristiriidat: –")
                        .font(.caption).foregroundStyle((ristiriidat ?? 0) > 0 ? Color.orange : Color.secondary)
                        .accessibilityIdentifier("lr-ristiriidat")
                    if let lahde { Text("lähde: \(lahde)").font(.caption2).foregroundStyle(.secondary).accessibilityIdentifier("infra-lahde") }
                }
            }
            Spacer()
            if lataa { ProgressView().controlSize(.small) }
            Button { Task { await lataaKaikki() } } label: { Image(systemName: "arrow.clockwise") }
                .accessibilityLabel("Päivitä rekisterit")
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
    }

    private func rivi(_ r: RekisteriRivi) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(r.polku).font(.body).lineLimit(1).truncationMode(.middle)
                Text([r.laji, r.skoopit.first].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption2).foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(Self.koko(r)).font(.caption.monospacedDigit()).foregroundStyle(Self.vari(r.luokka))
                if let t = r.tokenit { Text("\(t) tok").font(.caption2).foregroundStyle(.secondary) }
            }
        }
    }

    static func koko(_ r: RekisteriRivi) -> String {
        if let raja = r.raja, raja > 0 { return "\(r.tavut)/\(raja) t" }
        return "\(r.tavut) t"
    }

    static func vari(_ l: RekisteriRaja) -> Color {
        switch l {
        case .ylitetty: return .red
        case .lahella: return .orange
        case .ok, .eiRajaa: return .secondary
        }
    }

    private func lataaKaikki() async {
        lataa = true
        defer { lataa = false }
        do {
            let (r, l): ([RekisteriRivi], lahde: String?) = try await asiakas.hae("/api/rekisterit")
            rivit = r
            lahde = l
            virhe = nil
        } catch {
            virhe = "Rekisterien lataus epäonnistui: \(Virheteksti.muodosta(error))"
        }
        do {
            let (m, _): (RistiriitaMaara, lahde: String?) = try await asiakas.hae("/api/lr/ristiriidat")
            ristiriidat = m.maara
        } catch {
            ristiriidat = nil
        }
    }
}

struct RekisterinOsatNakyma: View {
    let asiakas: Asiakas
    let rivi: RekisteriRivi
    @State private var osat: [RekisterinOsa] = []
    @State private var lahde: String?
    @State private var virhe: String?

    var body: some View {
        List {
            if let virhe { Text(virhe).font(.caption).foregroundStyle(.red) }
            ForEach(osat) { o in
                DisclosureGroup {
                    Text(verbatim: o.teksti).font(.caption.monospaced()).textSelection(.enabled)
                } label: {
                    HStack {
                        Text(o.otsikko).lineLimit(1)
                        Spacer()
                        if let t = o.tokenit { Text("\(t) tok").font(.caption2).foregroundStyle(.secondary) }
                    }
                }
            }
            if let lahde { Text("lähde: \(lahde)").font(.caption2).foregroundStyle(.secondary) }
        }
        .navigationTitle(rivi.polku)
        .task {
            do {
                let (v, l): (RekisterinOsat, lahde: String?) = try await asiakas.hae(Reitit.rekisteri(rivi.polku))
                osat = v.osat
                lahde = l
            } catch {
                virhe = "Rekisterin lataus epäonnistui: \(Virheteksti.muodosta(error))"
            }
        }
    }
}
