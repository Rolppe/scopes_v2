// pohja: scopes/macos/Sources/Platform/MacKeychain.swift:1-39 (19.10.2026)
// Pysyvä avain Keychainissa (H-17:n yhteydessä, ei yöllä). Testeissä avain tulee ympäristöstä
// SCOPES2_AVAIN / TEST_RUNNER_SCOPES2_AVAIN (portti luo koeytimelle kertakäyttöavaimen); avainta ei lokiteta.
import Foundation
import Security

public enum Avain {
    static let palvelu = "com.example.scopes-v2"
    static let tili = "avain"

    /// Ympäristön koeavain, jos annettu (testit); ei koske Keychainiin.
    public static func ymparistosta() -> String? {
        let env = ProcessInfo.processInfo.environment
        for nimi in ["SCOPES2_AVAIN", "TEST_RUNNER_SCOPES2_AVAIN"] {
            if let s = env[nimi]?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty { return s }
        }
        return nil
    }

    private static func haku() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: palvelu,
            kSecAttrAccount as String: tili
        ]
    }

    /// Ympäristö ensin (testit), muuten Keychain.
    public static func hae() -> String? {
        if let s = ymparistosta() { return s }
        var kysely = haku()
        kysely[kSecReturnData as String] = true
        var tulos: AnyObject?
        guard SecItemCopyMatching(kysely as CFDictionary, &tulos) == errSecSuccess, let data = tulos as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public static func tallenna(_ s: String) throws {
        SecItemDelete(haku() as CFDictionary)
        guard !s.isEmpty else { return }
        var lisays = haku()
        lisays[kSecValueData as String] = Data(s.utf8)
        lisays[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let tila = SecItemAdd(lisays as CFDictionary, nil)
        guard tila == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(tila)) }
    }

    public static func poista() {
        SecItemDelete(haku() as CFDictionary)
    }
}
