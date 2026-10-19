// kopio: scopes/macos/Sources/MacSidebar.swift:45-48, :60-125 (skooppilista, suodatin), :246-266 (19.10.2026), sovitettu Varastoon
import SwiftUI
import ScopesCore2

public struct Sivupalkki: View {
    let varasto: Varasto
    @Binding var valinta: String?
    @State private var suodatus: SkooppiSuodatus = .kaikki
    @State private var haku: String = ""

    public init(varasto: Varasto, valinta: Binding<String?>) {
        self.varasto = varasto
        self._valinta = valinta
    }

    private var rivit: [SkooppiYhteenveto] {
        SkooppiSuodatus.suodata(varasto.skoopit, haku: haku, suodatus: suodatus)
    }

    public var body: some View {
        VStack(spacing: 0) {
            TextField("Suodata skoopit", text: $haku)
                .textFieldStyle(.roundedBorder)
                .padding(.horizontal, 10)
                .padding(.top, 8)
                .accessibilityIdentifier("skooppi-suodatin")

            Picker("Suodatus", selection: $suodatus) {
                ForEach(SkooppiSuodatus.allCases) { s in Text(s.rawValue).tag(s) }
            }
            .pickerStyle(.segmented)
            .controlSize(.small)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)

            List(selection: $valinta) {
                Section("Skoopit (\(rivit.count))") {
                    ForEach(rivit) { s in
                        rivi(s)
                            .tag(s.nimi)
                            .accessibilityIdentifier("skooppi-\(s.nimi)")
                    }
                }
            }
        }
    }

    private func rivi(_ s: SkooppiYhteenveto) -> some View {
        HStack(spacing: 8) {
            Circle()
                .fill(Self.tilavari(s.tilaNyt))
                .frame(width: 8, height: 8)
                .accessibilityLabel(s.tilaNyt)
            VStack(alignment: .leading, spacing: 1) {
                Text(s.nimi).font(.body).lineLimit(1)
                if let seuraava = s.seuraava, !seuraava.isEmpty {
                    Text(seuraava).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer()
            if s.avoimia > 0 {
                Text("\(s.avoimia)")
                    .font(.caption2).bold()
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Capsule().fill(Color.secondary.opacity(0.2)))
                    .accessibilityLabel("\(s.avoimia) avointa")
            }
        }
    }

    static func tilavari(_ tila: String) -> Color {
        switch tila {
        case "kasittely": return .green
        case "kysely": return .yellow
        case "odottaa": return .orange
        default: return .secondary
        }
    }
}
