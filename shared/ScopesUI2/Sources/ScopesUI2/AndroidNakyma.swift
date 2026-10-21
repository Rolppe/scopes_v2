// ARK-19 (T-87): Android-etäohjaus Infra-välilehdellä. Gemini-äppiä käytetään V2:n kautta /api/android-reiteillä (ydin lukee tilan,
// adapteri ajaa toiminnot; reitit ovat samat riippumatta siitä, kumpi vastaa, S-6 ja S-10).
// pohja: scopes/ios/Sources/Android.swift:29-364 (AndroidView, AndroidTiedostot) (21.10.2026), tehty jaetuksi iOS/macOS-näkymäksi:
// kosketus SwiftUI:n DragGestureen (UIKit-eleet pois), tiedoston valinta fileImporterilla, tallennus fileExporterilla.
// Ruutu päivittyy noin sekunnin välein vain, kun näkymä on esillä eikä äppi ole taustalla; ei taustakyselyä.
import SwiftUI
import UniformTypeIdentifiers
import ScopesCore2
#if canImport(UIKit)
import UIKit
typealias RuutuKuva = UIImage
#else
import AppKit
typealias RuutuKuva = NSImage
#endif

extension Image {
    init(ruutu kuva: RuutuKuva) {
        #if canImport(UIKit)
        self.init(uiImage: kuva)
        #else
        self.init(nsImage: kuva)
        #endif
    }
}

public struct AndroidNakyma: View {
    let asiakas: Asiakas

    @Environment(\.scenePhase) private var vaihe
    @State private var nakyvissa = false
    @State private var kuva: RuutuKuva?
    @State private var tila: AndroidTila?
    @State private var ruutuVirhe: String?
    @State private var virhe: String?
    @State private var ilmoitus: String?
    @State private var toiminnossa = 0
    @State private var teksti = ""
    @State private var tallennettu: AndroidTallennettu?
    @State private var tiedostotAuki = false
    @State private var liiteValinta = false
    @State private var vetoAlkoi: Date?
    @State private var haussa = false
    @State private var uusiHaku = false

    public init(asiakas: Asiakas) {
        self.asiakas = asiakas
    }

    /// Pollaus vain kun näkymä on esillä ja äppi ei ole taustalla: poistuttaessa tai taustalle mentäessä silmukka peruuntuu.
    private var aktiivinen: Bool { nakyvissa && vaihe != .background }

    public var body: some View {
        VStack(spacing: 0) {
            yla
            ruutu
            if let v = virhe ?? ruutuVirhe {
                Text(v).font(.footnote).foregroundStyle(.red).frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12).accessibilityIdentifier("android-virhe")
            } else if let ilmoitus {
                Text(ilmoitus).font(.footnote).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12).accessibilityIdentifier("android-ilmoitus")
            }
            if toiminnossa > 0 {
                ProgressView("Odotetaan Androidia… (voi kestää 15 s)").font(.footnote).padding(.top, 4)
            }
            napit
            syotto
        }
        .navigationTitle("Android")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .onAppear { nakyvissa = true }
        .onDisappear { nakyvissa = false }
        .task(id: aktiivinen) { await silmukka() }
        .sheet(item: $tallennettu) { t in AndroidTeksti(teksti: t.teksti) }
        .sheet(isPresented: $tiedostotAuki) { AndroidTiedostot(asiakas: asiakas) }
        .fileImporter(isPresented: $liiteValinta, allowedContentTypes: [.item], allowsMultipleSelection: false) { tulos in
            do {
                guard let url = try tulos.get().first else { return }
                Task { await liita(url) }
            } catch {
                virhe = "Tiedoston valinta epäonnistui: \(error.localizedDescription)"
            }
        }
    }

    // MARK: osat

    private var yla: some View {
        HStack {
            Text(Self.tilarivi(tila)).font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("android-tila")
            Spacer()
            Button { tiedostotAuki = true } label: { Image(systemName: "folder") }
                .accessibilityLabel("Tiedostot").accessibilityIdentifier("android-tiedostot")
            Button { Task { await paivita() } } label: { Image(systemName: "arrow.clockwise") }
                .accessibilityLabel("Päivitä Android").accessibilityIdentifier("android-paivita")
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
    }

    // Ruutu kuvana; napautus ja veto välittyvät laitteelle 0–1-osuuksina kuvan näkyvästä alueesta (letterbox huomioitu).
    private var ruutu: some View {
        GeometryReader { g in
            ZStack {
                Color.gray.opacity(0.15)
                if let kuva {
                    Image(ruutu: kuva).resizable().scaledToFit().frame(width: g.size.width, height: g.size.height)
                } else {
                    ProgressView()
                }
            }
            .frame(width: g.size.width, height: g.size.height)
            .clipped()
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in if vetoAlkoi == nil { vetoAlkoi = Date() } }
                    .onEnded { v in
                        let alkoi = vetoAlkoi ?? Date()
                        vetoAlkoi = nil
                        eleValmis(alku: v.startLocation, loppu: v.location, kesto: Date().timeIntervalSince(alkoi), alue: g.size)
                    }
            )
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Android-ruutu")
            .accessibilityValue(kuva.map { "kuva \(Int($0.size.width))x\(Int($0.size.height))" } ?? "ladataan")
            .accessibilityAddTraits(.isImage)
            .accessibilityIdentifier("android-ruutu")
        }
        .frame(minHeight: 160)
    }

    private var napit: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                nappi("Takaisin", "chevron.backward", "android-takaisin") { _ = await aja { try await asiakas.androidToiminto("nappi", runko: AndroidNappi(nimi: "takaisin")) } }
                nappi("Koti", "house", "android-koti") { _ = await aja { try await asiakas.androidToiminto("nappi", runko: AndroidNappi(nimi: "koti")) } }
                nappi("Sovellukset", "square.on.square", "android-sovellukset") { _ = await aja { try await asiakas.androidToiminto("nappi", runko: AndroidNappi(nimi: "sovellukset")) } }
                nappi("Avaa Gemini", "sparkles", "android-avaa") { _ = await aja { try await asiakas.androidToiminto("avaa") } }
                nappi("Uusi chat", "square.and.pencil", "android-uusi") { _ = await aja { try await asiakas.androidToiminto("uusi") } }
                nappi("Tallenna vastaus", "square.and.arrow.down", "android-talteen") { await tallennaVastaus() }
                Button { liiteValinta = true } label: { Label("Liitä tiedosto", systemImage: "paperclip") }
                    .buttonStyle(.bordered).disabled(toiminnossa > 0)
                    .accessibilityIdentifier("android-liite")
            }
            .padding(.horizontal, 12)
        }
        .padding(.vertical, 6)
    }

    private func nappi(_ otsikko: String, _ kuvake: String, _ tunnus: String, _ tyo: @escaping () async -> Void) -> some View {
        Button { Task { await tyo() } } label: { Label(otsikko, systemImage: kuvake) }
            .buttonStyle(.bordered).disabled(toiminnossa > 0)
            .accessibilityIdentifier(tunnus)
    }

    private var syotto: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Viesti Geminille", text: $teksti, axis: .vertical)
                .lineLimit(1...4).textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("android-teksti")
            Button { Task { await laheta() } } label: { Image(systemName: "arrow.up.circle.fill").font(.title) }
                .buttonStyle(.plain)
                .disabled(teksti.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || toiminnossa > 0)
                .accessibilityLabel("Lähetä").accessibilityIdentifier("android-laheta")
        }
        .padding(.horizontal, 12).padding(.bottom, 8)
    }

    // MARK: ruudun päivitys

    private func silmukka() async {
        guard aktiivinen else { return }
        await haeTila()
        while !Task.isCancelled {
            await haeRuutu()
            if Task.isCancelled { break }
            try? await Task.sleep(for: .seconds(ruutuVirhe == nil ? 1 : 3))
        }
    }

    /// Yksi haku kerrallaan: jos haku on kesken, uusi pyyntö (toiminnon jälkeen) merkitään ja kesken oleva tekee uusinnan heti.
    private func haeRuutu() async {
        if haussa { uusiHaku = true; return }
        haussa = true
        defer { haussa = false }
        repeat {
            uusiHaku = false
            do {
                let data = try await asiakas.androidRuutu()
                if let k = RuutuKuva(data: data) {
                    kuva = k
                    ruutuVirhe = nil
                } else {
                    ruutuVirhe = "Ruutu ei ole kuva."
                }
            } catch {
                if Task.isCancelled || (error as? URLError)?.code == .cancelled { return }
                ruutuVirhe = Self.virheteksti(error)
            }
        } while uusiHaku && !Task.isCancelled
    }

    private func haeTila() async {
        tila = try? await asiakas.androidTila()
    }

    private func paivita() async {
        await haeTila()
        await haeRuutu()
    }

    // MARK: toiminnot

    private func eleValmis(alku: CGPoint, loppu: CGPoint, kesto: TimeInterval, alue: CGSize) {
        guard let kuva, let a = AndroidOsuus.laske(piste: alku, alue: alue, kuva: kuva.size), a.kuvassa else { return }
        if hypot(loppu.x - alku.x, loppu.y - alku.y) < 10 {
            Task { _ = await aja { try await asiakas.androidToiminto("napauta", runko: AndroidPiste(x: a.x, y: a.y)) } }
        } else if let b = AndroidOsuus.laske(piste: loppu, alue: alue, kuva: kuva.size)?.rajattu {
            let ms = min(2000, max(100, Int(kesto * 1000)))
            let veto = AndroidVeto(x1: a.x, y1: a.y, x2: b.x, y2: b.y, kesto: ms)
            Task { _ = await aja { try await asiakas.androidToiminto("pyyhkaise", runko: veto) } }
        }
    }

    /// Toiminto palvelimelle; onnistuttua ruutu haetaan heti uudelleen. Palvelin sarjallistaa toiminnot, joten kirjoitus ja liite
    /// voivat odottaa muiden perässä.
    private func aja(_ tyo: () async throws -> AndroidVastaus) async -> AndroidVastaus? {
        toiminnossa += 1
        defer { toiminnossa -= 1 }
        do {
            let v = try await tyo()
            virhe = nil
            await haeRuutu()
            await haeTila()
            return v
        } catch {
            virhe = Self.virheteksti(error)
            return nil
        }
    }

    private func laheta() async {
        let t = teksti.trimmingCharacters(in: .whitespacesAndNewlines)
        ilmoitus = nil
        if await aja({ try await asiakas.androidToiminto("kirjoita", runko: AndroidKirjoita(teksti: t, laheta: true)) }) != nil { teksti = "" }
    }

    private func tallennaVastaus() async {
        ilmoitus = nil
        guard let v = await aja({ try await asiakas.androidToiminto("talteen") }) else { return }
        guard let t = v.teksti else { virhe = "Palvelin ei palauttanut vastauksen tekstiä."; return }
        tallennettu = AndroidTallennettu(teksti: t)
    }

    private func liita(_ url: URL) async {
        ilmoitus = nil
        let kaytossa = url.startAccessingSecurityScopedResource()
        defer { if kaytossa { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { virhe = "Tiedoston luku epäonnistui."; return }
        guard data.count <= 25 << 20 else { virhe = "Tiedosto on yli 25 Mt."; return }
        let viesti = teksti.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let v = await aja({ try await asiakas.androidLiite(nimi: url.lastPathComponent, teksti: viesti.isEmpty ? nil : viesti, data: data) }) else { return }
        if v.liitetty == true {
            ilmoitus = v.lahetetty == true ? "Liitetty ja lähetetty: \(url.lastPathComponent)" : "Liitetty: \(url.lastPathComponent)"
            if v.lahetetty == true { teksti = "" }
        } else {
            virhe = "Tiedosto on laitteella, mutta liitteeksi asettumista ei voitu varmistaa. Tarkista ruudulta ja valitse tiedosto tarvittaessa käsin."
        }
    }

    // MARK: apu

    static func tilarivi(_ t: AndroidTila?) -> String {
        guard let t else { return "Tila ei tiedossa" }
        var osat = [t.hereilla == true ? "Hereillä" : "Nukkuu"]
        if let k = t.koko, k.count == 2 { osat.append("\(k[0])×\(k[1])") }
        if t.kuiva == true { osat.append("kuivatila") }
        return osat.joined(separator: " · ")
    }

    static func virheteksti(_ virhe: Error) -> String {
        if let v = virhe as? ApiVirhe {
            if v.tila == 404, v.viesti?.contains("tuntematon") == true { return "Palvelin ei tue Android-ohjausta (404)." }
            if v.tila == 503 { return "Toimintoportti ei vastaa (503)." }
        }
        return String(Virheteksti.muodosta(virhe).prefix(200))
    }
}

private struct AndroidPiste: Encodable { let x: Double; let y: Double }
private struct AndroidVeto: Encodable { let x1: Double; let y1: Double; let x2: Double; let y2: Double; let kesto: Int }
private struct AndroidNappi: Encodable { let nimi: String }
private struct AndroidKirjoita: Encodable { let teksti: String; let laheta: Bool }

struct AndroidTallennettu: Identifiable {
    let id = UUID()
    let teksti: String
}

// Tallennettu vastaus arkissa: valinta, kopiointi ja jako.
struct AndroidTeksti: View {
    let teksti: String
    @Environment(\.dismiss) private var sulje

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(teksti).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding()
                    .accessibilityIdentifier("android-vastaus")
            }
            .navigationTitle("Vastaus")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Valmis") { sulje() }.accessibilityIdentifier("android-vastaus-valmis") }
                ToolbarItem(placement: .primaryAction) {
                    ShareLink(item: teksti) { Image(systemName: "square.and.arrow.up") }.accessibilityIdentifier("android-jaa")
                }
            }
        }
        .frame(minWidth: 360, minHeight: 300)
    }
}

// Laitteen tuotostiedostot (Download, Pictures, …, 14 vrk): rivin valinta hakee tiedoston ja tarjoaa sen tallennettavaksi.
struct AndroidTiedostot: View {
    let asiakas: Asiakas
    @Environment(\.dismiss) private var sulje
    @State private var tiedostot: [AndroidTuotos]?
    @State private var virhe: String?
    @State private var haetaan: String?
    @State private var vienti: TuotosAsiakirja?
    @State private var viennissa = false
    @State private var vientiNimi = "tuotos"

    var body: some View {
        NavigationStack {
            List {
                if let virhe { Text(virhe).foregroundStyle(.red).accessibilityIdentifier("android-tiedostot-virhe") }
                if let tiedostot {
                    if tiedostot.isEmpty { Text("Ei tiedostoja viimeiseltä 14 vuorokaudelta.").foregroundStyle(.secondary) }
                    ForEach(tiedostot) { t in
                        Button { Task { await avaa(t) } } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(verbatim: t.nimi).lineLimit(2)
                                    Text("\(ByteCountFormatter.string(fromByteCount: Int64(t.koko), countStyle: .file)) · \(Self.aika(t.aika))")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if haetaan == t.polku { ProgressView() }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).disabled(haetaan != nil)
                        .accessibilityIdentifier("android-tuotos")
                    }
                } else if virhe == nil {
                    ProgressView()
                }
            }
            .navigationTitle("Tiedostot")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Valmis") { sulje() }.accessibilityIdentifier("android-tiedostot-valmis") }
            }
            .refreshable { await lataa() }
        }
        .frame(minWidth: 360, minHeight: 320)
        .task { await lataa() }
        .fileExporter(isPresented: $viennissa, document: vienti, contentType: .data, defaultFilename: vientiNimi) { _ in vienti = nil }
    }

    private static func aika(_ iso: String) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let d = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return iso }
        return d.formatted(date: .abbreviated, time: .shortened)
    }

    private func lataa() async {
        do {
            tiedostot = try await asiakas.androidTuotokset()
            virhe = nil
        } catch {
            virhe = AndroidNakyma.virheteksti(error)
        }
    }

    private func avaa(_ t: AndroidTuotos) async {
        haetaan = t.polku
        defer { haetaan = nil }
        do {
            let data = try await asiakas.androidTuotos(polku: t.polku)
            vientiNimi = URL(fileURLWithPath: t.nimi).lastPathComponent
            vienti = TuotosAsiakirja(data: data)
            viennissa = true
            virhe = nil
        } catch {
            virhe = AndroidNakyma.virheteksti(error)
        }
    }
}

/// Haettu tuotostiedosto tallennettavaksi (fileExporter).
struct TuotosAsiakirja: FileDocument {
    static var readableContentTypes: [UTType] { [.data] }
    var data: Data

    init(data: Data) { self.data = data }

    init(configuration: ReadConfiguration) throws {
        data = configuration.file.regularFileContents ?? Data()
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}
