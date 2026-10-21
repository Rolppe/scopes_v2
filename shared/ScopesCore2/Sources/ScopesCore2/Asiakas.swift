// pohja: scopes/shared/ScopesCore/Sources/ScopesCore/Client/ScopesClient.swift:41-72, :115-120, :127-149 (19.10.2026)
import Foundation

/// Ytimen virhevastaus. `lahde` on otsikko X-Lahde ("ydin" | "silta").
public struct ApiVirhe: Error, Sendable {
    public let tila: Int
    public let viesti: String?
    public let lahde: String?

    public init(tila: Int, viesti: String? = nil, lahde: String? = nil) {
        self.tila = tila
        self.viesti = viesti
        self.lahde = lahde
    }
}

/// Tyhjä vastaus (esim. kun runkoa ei tarvita).
public struct TyhjaVastaus: Decodable, Sendable {}

struct AnyEncodable: Encodable {
    let arvo: Encodable
    func encode(to encoder: Encoder) throws { try arvo.encode(to: encoder) }
}

public final class Asiakas: Sendable {
    public let osoite: URL
    let avain: String
    let session: URLSession

    public init(osoite: URL, avain: String, session: URLSession = .shared) {
        self.osoite = osoite
        self.avain = avain
        self.session = session
    }

    /// Skoopin nimi polun osana prosenttikoodattuna (nimissä välilyöntejä).
    public static func koodaa(_ nimi: String) -> String {
        var sallitut = CharacterSet.urlPathAllowed
        sallitut.remove(charactersIn: "/")
        return nimi.addingPercentEncoding(withAllowedCharacters: sallitut) ?? nimi
    }

    func pyynto(_ polku: String, metodi: String = "GET", runko: Data? = nil, tyyppi: String? = "application/json",
                aikaraja: TimeInterval? = nil) throws -> URLRequest {
        var perus = osoite.absoluteString
        while perus.hasSuffix("/") { perus.removeLast() }
        let teksti = perus + polku
        guard let url = URL(string: teksti) else { throw ApiVirhe(tila: 0, viesti: "osoite ei kelpaa") }
        var req = URLRequest(url: url)
        req.httpMethod = metodi
        req.httpBody = runko
        if runko != nil, let tyyppi { req.setValue(tyyppi, forHTTPHeaderField: "Content-Type") }
        req.setValue("Bearer \(avain)", forHTTPHeaderField: "Authorization")
        if let aikaraja { req.timeoutInterval = aikaraja }
        return req
    }

    static func virheViesti(_ data: Data) -> String? {
        guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return o["virhe"] as? String
    }

    static func virhe(_ vastaus: URLResponse, data: Data) -> ApiVirhe {
        let http = vastaus as? HTTPURLResponse
        return ApiVirhe(tila: http?.statusCode ?? 0, viesti: virheViesti(data), lahde: http?.value(forHTTPHeaderField: "X-Lahde"))
    }

    func laheta<T: Decodable>(_ req: URLRequest) async throws -> (T, lahde: String?) {
        let (data, vastaus) = try await session.data(for: req)
        guard let http = vastaus as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw Self.virhe(vastaus, data: data)
        }
        let kohde = try JSONDecoder().decode(T.self, from: data)
        return (kohde, lahde: http.value(forHTTPHeaderField: "X-Lahde"))
    }

    public func hae<T: Decodable>(_ polku: String, metodi: String = "GET", runko: Encodable? = nil,
                                  aikaraja: TimeInterval = 15) async throws -> (T, lahde: String?) {
        let data = try runko.map { try JSONEncoder().encode(AnyEncodable(arvo: $0)) }
        let req = try pyynto(polku, metodi: metodi, runko: data, aikaraja: aikaraja)
        return try await laheta(req)
    }

    /// S-9: GET /api/peili/koko; ikkunaVrk on nil täydellä solmulla.
    public func peiliKoko() async throws -> PeiliKoko {
        let (koko, _): (PeiliKoko, lahde: String?) = try await hae("/api/peili/koko")
        return koko
    }

    /// S-9f: GET /api/peili/<tiedosto>/raaka?rivi=&maara= (rivi 1-pohjainen, maara 1…200; ikkunoitu solmu välittää täydelle).
    public func peiliRaaka(tiedosto: String, rivi: Int, maara: Int = 50) async throws -> PeiliRaaka {
        let polku = "/api/peili/\(Asiakas.koodaa(tiedosto))/raaka?rivi=\(rivi)&maara=\(maara)"
        let (raaka, _): (PeiliRaaka, lahde: String?) = try await hae(polku)
        return raaka
    }

    /// NDJSON-virta (esim. POST /api/chat/virta); yksi ChatTapahtuma per rivi, virta päättyy yhteyden loppuun.
    public func virta(_ polku: String, runko: Encodable) -> AsyncThrowingStream<ChatTapahtuma, Error> {
        AsyncThrowingStream { jatko in
            let tyo = Task {
                do {
                    let data = try JSONEncoder().encode(AnyEncodable(arvo: runko))
                    var req = try self.pyynto(polku, metodi: "POST", runko: data, aikaraja: 600)
                    req.setValue("application/x-ndjson", forHTTPHeaderField: "Accept")
                    let (tavut, vastaus) = try await self.session.bytes(for: req)
                    guard let http = vastaus as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                        var virheData = Data()
                        for try await b in tavut {
                            virheData.append(b)
                            if virheData.count >= 4096 { break }
                        }
                        throw Self.virhe(vastaus, data: virheData)
                    }
                    for try await rivi in tavut.lines {
                        let siisti = rivi.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !siisti.isEmpty else { continue }
                        jatko.yield(try JSONDecoder().decode(ChatTapahtuma.self, from: Data(siisti.utf8)))
                    }
                    jatko.finish()
                } catch {
                    jatko.finish(throwing: error)
                }
            }
            jatko.onTermination = { _ in tyo.cancel() }
        }
    }

    /// Liite raakarunkona (S-8b): POST /api/skoopit/<nimi>/liite?nimi=<tiedosto> → {polku, koko, sha256, solmu}.
    public func liite(skooppi: String, nimi: String, data: Data) async throws -> LiiteVastaus {
        var sallitut = CharacterSet.alphanumerics
        sallitut.insert(charactersIn: "._-")
        let tiedosto = nimi.addingPercentEncoding(withAllowedCharacters: sallitut) ?? "liite"
        let req = try pyynto("/api/skoopit/\(Self.koodaa(skooppi))/liite?nimi=\(tiedosto)", metodi: "POST", runko: data,
                             tyyppi: "application/octet-stream", aikaraja: 120)
        let (v, _): (LiiteVastaus, lahde: String?) = try await laheta(req)
        return v
    }
}
