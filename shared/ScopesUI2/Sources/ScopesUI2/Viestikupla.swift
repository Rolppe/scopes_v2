// kopio: scopes/shared/ScopesUI/Sources/ScopesUI/Chat/Viestikupla.swift:1-84 (19.10.2026), sovitettu ScopesCore2:n Viestiin; ei UIKit/AppKit-riippuvuutta
import SwiftUI
import ScopesCore2

public struct Viestikupla: View {
    public let viesti: Viesti

    public init(viesti: Viesti) {
        self.viesti = viesti
    }

    public var body: some View {
        if viesti.tyokalu {
            tyokaluRivi
        } else {
            tekstiKupla
        }
    }

    private var tyokaluRivi: some View {
        HStack(spacing: 6) {
            Image(systemName: "wrench.and.screwdriver")
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(verbatim: viesti.teksti)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .textSelection(.enabled)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 2)
        .accessibilityIdentifier("tyokalu-rivi")
    }

    private var tekstiKupla: some View {
        HStack {
            if viesti.omaViesti { Spacer(minLength: 60) }
            VStack(alignment: viesti.omaViesti ? .trailing : .leading, spacing: 4) {
                Text(LocalizedStringKey(viesti.teksti))
                    .font(.body)
                    .textSelection(.enabled)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(viesti.omaViesti ? Color.accentColor : Color.secondary.opacity(0.15))
                    .foregroundColor(viesti.omaViesti ? .white : .primary)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                if let aika = viesti.aika, !aika.isEmpty {
                    Text(aika)
                        .font(.caption2)
                        .foregroundColor(.secondary)
                        .padding(.horizontal, 4)
                }
            }
            if !viesti.omaViesti { Spacer(minLength: 60) }
        }
    }
}
