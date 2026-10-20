// Skoopin viestin lähetys: POST /api/skoopit/<nimi>/viesti {"teksti"}; liitteet asiakas.liite(…) (S-8b).
import SwiftUI
import ScopesCore2

public struct Lahetys: View {
    let asiakas: Asiakas
    let skooppi: String
    let voiLahettaa: Bool
    let jalkeen: () async -> Void
    /// Luonnos synkataan tilaan (luonnos/<skooppi>, 1 s viive) kun `tila` annetaan.
    let tila: Tilasynkka?
    @State private var luonnos = ""

    public init(asiakas: Asiakas, skooppi: String, voiLahettaa: Bool = true, tila: Tilasynkka? = nil, jalkeen: @escaping () async -> Void = {}) {
        self.asiakas = asiakas
        self.skooppi = skooppi
        self.voiLahettaa = voiLahettaa
        self.tila = tila
        self.jalkeen = jalkeen
    }

    private var avain: String { TilaAvain.luonnos(skooppi) }

    public var body: some View {
        Syottokentta(
            teksti: $luonnos,
            tunnus: "viesti",
            voiLahettaa: voiLahettaa,
            lataaLiite: { nimi, data in try await asiakas.liite(skooppi: skooppi, nimi: nimi, data: data) },
            laheta: { teksti, polut in
                let runko = ["teksti": LiiteVastaus.viesti(teksti, polut: polut)]
                let _: (TyhjaVastaus, lahde: String?) = try await asiakas.hae(Reitit.viesti(skooppi), metodi: "POST", runko: runko)
                await jalkeen()
            }
        )
        .onAppear { if let t = tila?.teksti(avain), t != luonnos { luonnos = t } }
        .onChange(of: tila?.teksti(avain)) { _, uusi in
            if let uusi, uusi != luonnos { luonnos = uusi }
        }
        .onChange(of: luonnos) { _, uusi in tila?.kirjoita(avain, .teksti(uusi)) }
    }
}
