// kopio: scopes/macos/Sources/MacQuestionCard.swift:1-76 (19.10.2026), ilman AppKitia; vastausteksti Vastausteksti-funktiosta
import SwiftUI
import ScopesCore2

public struct Kysymyskortti: View {
    public let kysymys: Kysymys
    public var vastaus: (String) -> Void
    @State private var valitut: Set<String> = []

    public init(kysymys: Kysymys, vastaus: @escaping (String) -> Void) {
        self.kysymys = kysymys
        self.vastaus = vastaus
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let otsikko = kysymys.otsikko, !otsikko.isEmpty {
                Text(otsikko)
                    .font(.caption)
                    .bold()
                    .foregroundColor(.secondary)
                    .textCase(.uppercase)
            }

            Text(kysymys.kysymys)
                .font(.headline)
                .foregroundColor(.primary)

            VStack(spacing: 8) {
                ForEach(kysymys.vaihtoehdot) { v in
                    Button {
                        if kysymys.monivalinta {
                            if valitut.contains(v.nimi) { valitut.remove(v.nimi) } else { valitut.insert(v.nimi) }
                        } else {
                            vastaus(Vastausteksti.muodosta(kysymys, valitut: [], yksi: v.nimi))
                        }
                    } label: {
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: kysymys.monivalinta ? (valitut.contains(v.nimi) ? "checkmark.square.fill" : "square") : "circle")
                                .foregroundColor(valitut.contains(v.nimi) ? .accentColor : .secondary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(v.nimi).font(.body).bold()
                                if let kuvaus = v.kuvaus, !kuvaus.isEmpty {
                                    Text(kuvaus).font(.caption).foregroundColor(.secondary)
                                }
                            }
                            Spacer()
                        }
                        .padding(10)
                        .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.12)))
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("vaihtoehto-\(v.nimi)")
                }
            }

            if kysymys.monivalinta && !valitut.isEmpty {
                Button("Vahvista valinnat (\(valitut.count))") {
                    vastaus(Vastausteksti.muodosta(kysymys, valitut: valitut))
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("vahvista-valinnat")
            }
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.secondary.opacity(0.06)))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.secondary.opacity(0.2), lineWidth: 1))
    }
}
