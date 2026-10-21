// kopio: scopes/ios/Sources/Viestit.swift:275-400 (Viestilista: vieritys loppuun vain alhaalla oltaessa, E-33) (19.10.2026),
// ilman UIKitiä; LazyVStack (T-48-sopimus), vakaat id:t Viesti.id:stä
import SwiftUI
import ScopesCore2

public struct SkoopinViestit: View {
    let varasto: Varasto
    let asiakas: Asiakas
    let skooppi: String

    @State private var alhaalla = true
    @State private var virhe: String?
    /// Ylin näkyvä viesti (scrollPosition); synkataan tilaan vierityskohta/<skooppi> (2 s viive).
    @State private var ylin: String?

    public init(varasto: Varasto, asiakas: Asiakas, skooppi: String) {
        self.varasto = varasto
        self.asiakas = asiakas
        self.skooppi = skooppi
    }

    private var tiedot: SkooppiViestit? { varasto.viestit[skooppi] }

    public var body: some View {
        VStack(spacing: 0) {
            if let t = tiedot {
                if t.auki {
                    lista(t)
                    Divider()
                    Lahetys(asiakas: asiakas, skooppi: skooppi, voiLahettaa: t.voiLahettaa, tila: varasto.tila) {
                        await varasto.paivitaViestit(skooppi)
                    }
                } else {
                    tyhja("Ei avointa istuntoa")
                }
            } else {
                tyhja("Ladataan viestejä…")
            }
        }
        .task(id: skooppi) {
            varasto.valittu = skooppi
            await varasto.paivitaViestit(skooppi)
            kuittaaJosAlhaalla()
        }
        .overlay(alignment: .topLeading) {
            // Testikoukku: avattu skooppi ja vierityskohta luettavissa käyttöliittymätestille.
            Color.clear.frame(width: 1, height: 1)
                .accessibilityElement()
                .accessibilityIdentifier("avattu-\(skooppi)")
            Color.clear.frame(width: 1, height: 1)
                .accessibilityElement()
                .accessibilityIdentifier("vierityskohta")
                .accessibilityLabel(ylin ?? "-")
        }
        .onChange(of: alhaalla) { _, _ in kuittaaJosAlhaalla() }
        .onChange(of: tiedot?.viestit.last?.id) { _, _ in kuittaaJosAlhaalla() }
        .onChange(of: ylin) { _, uusi in
            if let uusi, uusi != "loppu" { varasto.tila.kirjoita(TilaAvain.vierityskohta(skooppi), .teksti(uusi)) }
        }
    }

    /// Skoopin avaus ja vieritys loppuun kuittaavat luetuksi (kuittaus/<skooppi>).
    private func kuittaaJosAlhaalla() {
        guard alhaalla, let t = tiedot else { return }
        varasto.tila.kuittaa(skooppi: skooppi, viestit: t.viestit)
    }

    private func tyhja(_ teksti: String) -> some View {
        Text(teksti)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier("viestit-tyhja")
    }

    private func lista(_ t: SkooppiViestit) -> some View {
        ScrollViewReader { vierita in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    // S-9: ikkunoitu solmu ei saanut haettua vanhempia viestejä (vertainen poissa); viestit ovat ikkunan sisältö.
                    if t.haettavissa {
                        Text("Vanhempia viestejä ei saatu haettua. Ne haetaan, kun yhteys palvelimeen palaa.")
                            .font(.caption).foregroundStyle(.secondary)
                            .accessibilityIdentifier("haettavissa")
                    }
                    ForEach(t.viestit) { v in
                        rivi(v, viimeinen: v.id == t.viestit.last?.id)
                    }
                    if let virhe {
                        Text(virhe).font(.caption).foregroundStyle(.red)
                    }
                    Color.clear.frame(height: 1).id("loppu")
                }
                .scrollTargetLayout()
                .padding(16)
            }
            .scrollPosition(id: $ylin, anchor: .top)
            .seuraaAlareunaa($alhaalla)
            .onChange(of: varasto.tila.teksti(TilaAvain.vierityskohta(skooppi))) { _, uusi in
                if let uusi, uusi != ylin, t.viestit.contains(where: { $0.id == uusi }) {
                    ylin = uusi
                    vierita.scrollTo(uusi, anchor: .top)
                }
            }
            .onChange(of: t.viestit.count) { vanha, uusi in
                if Vieritys.vieritaLoppuun(alhaalla: alhaalla, vanhaMaara: vanha, uusiMaara: uusi, viimeinenOma: t.viestit.last?.omaViesti == true) {
                    vierita.scrollTo("loppu", anchor: .bottom)
                }
            }
            .onChange(of: t.viestit.last?.teksti) {
                if alhaalla { vierita.scrollTo("loppu", anchor: .bottom) }
            }
            .onAppear {
                if let kohta = varasto.tila.teksti(TilaAvain.vierityskohta(skooppi)), t.viestit.contains(where: { $0.id == kohta }) {
                    ylin = kohta
                    vierita.scrollTo(kohta, anchor: .top)
                } else if !t.viestit.isEmpty {
                    vierita.scrollTo("loppu", anchor: .bottom)
                }
            }
        }
    }

    @ViewBuilder
    private func rivi(_ v: Viesti, viimeinen: Bool) -> some View {
        if let kysymykset = v.kysymykset, !kysymykset.isEmpty, v.vastattu != true {
            VStack(alignment: .leading, spacing: 10) {
                if !v.teksti.isEmpty { Viestikupla(viesti: v) }
                ForEach(kysymykset) { k in
                    Kysymyskortti(kysymys: k) { vastaus in vastaa(vastaus) }
                        .accessibilityIdentifier("kysymyskortti")
                }
            }
        } else {
            Viestikupla(viesti: v)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier(v.tyokalu ? "tyokalu-rivi" : "viesti")
        }
    }

    private func vastaa(_ teksti: String) {
        Task {
            do {
                let _: (TyhjaVastaus, lahde: String?) = try await asiakas.hae(Reitit.viesti(skooppi), metodi: "POST", runko: ["teksti": teksti])
                virhe = nil
                await varasto.paivitaViestit(skooppi)
            } catch {
                virhe = "Vastauksen lähetys epäonnistui: \(Virheteksti.muodosta(error))"
            }
        }
    }
}

/// Seuraa, onko käyttäjä listan alareunassa (iOS 18 / macOS 15 -rajapinta; vanhemmilla oletus on alhaalla).
struct AlareunaSeuranta: ViewModifier {
    @Binding var alhaalla: Bool

    func body(content: Content) -> some View {
        if #available(iOS 18.0, macOS 15.0, *) {
            content
                .defaultScrollAnchor(alhaalla ? .bottom : nil, for: .sizeChanges)
                .onScrollGeometryChange(for: Bool.self) { geo in
                    Vieritys.onAlhaalla(sisaltoKorkeus: geo.contentSize.height, nakymaKorkeus: geo.containerSize.height, siirtymaY: geo.contentOffset.y)
                } action: { _, uusi in
                    alhaalla = uusi
                }
        } else {
            content
        }
    }
}

extension View {
    func seuraaAlareunaa(_ alhaalla: Binding<Bool>) -> some View {
        modifier(AlareunaSeuranta(alhaalla: alhaalla))
    }
}
