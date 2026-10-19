// Skoopin viestin lähetys: POST /api/skoopit/<nimi>/viesti {"teksti"}; liitteet asiakas.liite(…) (S-8b).
import SwiftUI
import ScopesCore2

public struct Lahetys: View {
    let asiakas: Asiakas
    let skooppi: String
    let voiLahettaa: Bool
    let jalkeen: () async -> Void
    /// Luonnos on @State; T-52 vie sen tilaan.
    @State private var luonnos = ""

    public init(asiakas: Asiakas, skooppi: String, voiLahettaa: Bool = true, jalkeen: @escaping () async -> Void = {}) {
        self.asiakas = asiakas
        self.skooppi = skooppi
        self.voiLahettaa = voiLahettaa
        self.jalkeen = jalkeen
    }

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
    }
}
