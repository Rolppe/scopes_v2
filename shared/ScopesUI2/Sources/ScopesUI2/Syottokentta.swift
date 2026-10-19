// kopio: scopes/macos/Sources/MacChatInput.swift:1-109 (macOS: Enter lähettää, Shift+Enter rivinvaihto, pudotus, tiedostovalinta)
//        ja scopes/ios/Sources/Viestit.swift:403-498 (Syottorivi: lähetyspainike, estetty-tila) (19.10.2026)
// Yksi jaettu syöttökenttä Lahetys- ja ChatNakyma-näkymille. Liitteet ladataan heti valinnan jälkeen (asiakas.liite);
// lähetyksessä polut annetaan kutsujalle, joka muodostaa viestin (LiiteVastaus.viesti).
import SwiftUI
import UniformTypeIdentifiers
#if os(iOS)
import PhotosUI
#endif
import ScopesCore2

struct Syottokentta: View {
    @Binding var teksti: String
    let tunnus: String
    var voiLahettaa: Bool = true
    /// nil = ei liitteitä (chat).
    var lataaLiite: ((String, Data) async throws -> LiiteVastaus)? = nil
    /// (teksti, liitepolut); heitto näytetään kentän alla.
    let laheta: (String, [String]) async throws -> Void
    /// Stop-painike kesken vastauksen (chat).
    var stop: (() -> Void)? = nil
    var kesken: Bool = false

    @State private var liitteet: [Liite] = []
    @State private var virhe: String?
    @State private var lahettaa = false
    @State private var lataamassa = 0
    @State private var valitsin = false
    #if os(iOS)
    @State private var kuvat: [PhotosPickerItem] = []
    #endif

    struct Liite: Identifiable, Hashable {
        let id = UUID()
        let nimi: String
        let polku: String
    }

    private var onSisaltoa: Bool {
        !teksti.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !liitteet.isEmpty
    }
    private var estetty: Bool { !voiLahettaa || lahettaa || kesken || lataamassa > 0 || !onSisaltoa }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !liitteet.isEmpty { liiteRivi }
            HStack(alignment: .bottom, spacing: 8) {
                if lataaLiite != nil { liitePainikkeet }
                kentta
                painike
            }
            if lataamassa > 0 {
                Text("Ladataan liitettä…").font(.caption).foregroundStyle(.secondary)
            }
            if let virhe {
                Text(virhe)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("\(tunnus)-virhe")
            }
        }
        .padding(12)
        .fileImporter(isPresented: $valitsin, allowedContentTypes: [.item], allowsMultipleSelection: true) { tulos in
            switch tulos {
            case .success(let urlit): for u in urlit { Task { await liita(u) } }
            case .failure(let e): virhe = Virheteksti.muodosta(e)
            }
        }
    }

    private var liiteRivi: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(liitteet) { l in
                    HStack(spacing: 4) {
                        Image(systemName: "doc")
                        Text(l.nimi).lineLimit(1)
                        Button {
                            liitteet.removeAll { $0.id == l.id }
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Poista liite")
                    }
                    .font(.caption)
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(Capsule().fill(Color.secondary.opacity(0.15)))
                }
            }
        }
    }

    @ViewBuilder private var liitePainikkeet: some View {
        Button { valitsin = true } label: {
            Image(systemName: "paperclip")
                .resizable().scaledToFit()
                .frame(width: 18, height: 18)
                .foregroundColor(.secondary)
                .padding(6)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Liitä tiedosto")
        .accessibilityIdentifier("\(tunnus)-liite")
        #if os(iOS)
        PhotosPicker(selection: $kuvat, matching: .any(of: [.images, .videos])) {
            Image(systemName: "photo")
                .resizable().scaledToFit()
                .frame(width: 18, height: 18)
                .foregroundColor(.secondary)
                .padding(6)
        }
        .accessibilityLabel("Liitä kuva")
        .onChange(of: kuvat) { _, uudet in
            guard !uudet.isEmpty else { return }
            let nyt = uudet
            kuvat = []
            for (i, k) in nyt.enumerated() { Task { await liitaKuva(k, numero: i + 1) } }
        }
        #endif
    }

    private var kentta: some View {
        TextEditor(text: $teksti)
            .scrollContentBackground(.hidden)
            .frame(minHeight: 36, maxHeight: 140)
            .padding(4)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.1)))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.3), lineWidth: 1))
            .overlay(alignment: .topLeading) {
                if teksti.isEmpty {
                    Text(Self.vihje)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 10).padding(.vertical, 12)
                        .allowsHitTesting(false)
                }
            }
            .accessibilityIdentifier("\(tunnus)-kentta")
            #if os(macOS)
            .onKeyPress(.return, phases: .down) { paine in
                if paine.modifiers.contains(.shift) { return .ignored }
                if !estetty { lahetaNyt() }
                return .handled
            }
            .onDrop(of: [.fileURL], isTargeted: nil) { toimittajat in
                guard lataaLiite != nil else { return false }
                for t in toimittajat {
                    t.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { kohde, _ in
                        guard let data = kohde as? Data, let url = URL(dataRepresentation: data, relativeTo: nil) else { return }
                        Task { @MainActor in await liita(url) }
                    }
                }
                return true
            }
            #endif
    }

    #if os(macOS)
    static let vihje = "Kirjoita viesti… (Enter lähettää, Shift+Enter rivinvaihto)"
    #else
    static let vihje = "Kirjoita viesti"
    #endif

    @ViewBuilder private var painike: some View {
        if kesken, let stop {
            Button(action: stop) {
                Image(systemName: "stop.circle.fill").resizable().frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Pysäytä")
            .accessibilityIdentifier("\(tunnus)-stop")
        } else {
            Button(action: lahetaNyt) {
                Image(systemName: "arrow.up.circle.fill")
                    .resizable().frame(width: 28, height: 28)
                    .foregroundColor(estetty ? .secondary : .accentColor)
            }
            .buttonStyle(.plain)
            .disabled(estetty)
            .accessibilityLabel("Lähetä")
            .accessibilityIdentifier("\(tunnus)-laheta")
        }
    }

    private func lahetaNyt() {
        guard !estetty else { return }
        let sisalto = teksti.trimmingCharacters(in: .whitespacesAndNewlines)
        let polut = liitteet.map(\.polku)
        let vanhatLiitteet = liitteet
        let vanhaTeksti = teksti
        lahettaa = true
        virhe = nil
        // Kenttä tyhjenee heti (chatin suoratoisto kestää); virheessä sisältö palautetaan, jos kenttä on yhä tyhjä.
        teksti = ""
        liitteet = []
        Task {
            do {
                try await laheta(sisalto, polut)
            } catch {
                virhe = Virheteksti.muodosta(error)
                if teksti.isEmpty { teksti = vanhaTeksti }
                if liitteet.isEmpty { liitteet = vanhatLiitteet }
            }
            lahettaa = false
        }
    }

    private func liita(_ url: URL) async {
        let kaytto = url.startAccessingSecurityScopedResource()
        defer { if kaytto { url.stopAccessingSecurityScopedResource() } }
        let nimi = Liitteet.nimi(url)
        if let koko = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize, !Liitteet.kokoSallittu(koko) {
            virhe = Liitteet.liikaaTeksti(nimi)
            return
        }
        do {
            let data = try await Task.detached { try Data(contentsOf: url) }.value
            await tallennaLiite(nimi, data)
        } catch {
            virhe = "\(nimi): \(Virheteksti.muodosta(error))"
        }
    }

    #if os(iOS)
    private func liitaKuva(_ kohde: PhotosPickerItem, numero: Int) async {
        do {
            guard let data = try await kohde.loadTransferable(type: Data.self) else { throw URLError(.cannotDecodeContentData) }
            let paate = kohde.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg"
            await tallennaLiite("kuva-\(numero).\(paate)", data)
        } catch {
            virhe = "Kuvan luku epäonnistui: \(Virheteksti.muodosta(error))"
        }
    }
    #endif

    private func tallennaLiite(_ nimi: String, _ data: Data) async {
        guard let lataaLiite else { return }
        guard Liitteet.kokoSallittu(data.count) else { virhe = Liitteet.liikaaTeksti(nimi); return }
        lataamassa += 1
        defer { lataamassa -= 1 }
        do {
            let v = try await lataaLiite(nimi, data)
            liitteet.append(Liite(nimi: nimi, polku: v.polku))
            virhe = nil
        } catch {
            virhe = "\(nimi): \(Virheteksti.muodosta(error))"
        }
    }
}
