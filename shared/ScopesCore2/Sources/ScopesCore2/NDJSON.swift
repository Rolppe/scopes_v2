// kopio: scopes/shared/ScopesCore/Sources/ScopesCore/Client/NDJSONStream.swift:1-27 (19.10.2026)
import Foundation

public struct ChatTapahtuma: Codable, Hashable, Sendable {
    public let tyyppi: String
    public let teksti: String?
    public let vastaus: String?
    public let keskustelu: String?
    public let virhe: String?

    public init(tyyppi: String, teksti: String? = nil, vastaus: String? = nil, keskustelu: String? = nil, virhe: String? = nil) {
        self.tyyppi = tyyppi
        self.teksti = teksti
        self.vastaus = vastaus
        self.keskustelu = keskustelu
        self.virhe = virhe
    }
}

public enum NDJSONParser {
    public static func parsii<T: Decodable>(_ data: Data, tyyppi: T.Type = T.self) throws -> [T] {
        guard let s = String(data: data, encoding: .utf8) else { return [] }
        return try s.split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .map { try JSONDecoder().decode(T.self, from: Data($0.utf8)) }
    }
}
