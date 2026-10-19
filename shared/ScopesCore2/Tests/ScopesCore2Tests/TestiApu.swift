import XCTest
import Foundation
@testable import ScopesCore2

/// Vanhan ScopesClientTests.swift:n MockURLProtocol (kopio 19.10.2026), laajennettu runkovirralla.
final class MockURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var kasittelija: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let kasittelija = Self.kasittelija else {
            client?.urlProtocol(self, didFailWithError: URLError(.unknown))
            return
        }
        do {
            let (vastaus, data) = try kasittelija(request)
            client?.urlProtocol(self, didReceive: vastaus, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}

    static func sessio() -> URLSession {
        let asetus = URLSessionConfiguration.ephemeral
        asetus.protocolClasses = [MockURLProtocol.self]
        return URLSession(configuration: asetus)
    }

    static func vastaus(_ req: URLRequest, tila: Int = 200, otsikot: [String: String] = [:]) -> HTTPURLResponse {
        HTTPURLResponse(url: req.url!, statusCode: tila, httpVersion: nil, headerFields: otsikot)!
    }
}

extension URLRequest {
    func runkoData() -> Data? {
        if let b = httpBody { return b }
        guard let virta = httpBodyStream else { return nil }
        virta.open()
        defer { virta.close() }
        var data = Data()
        var puskuri = [UInt8](repeating: 0, count: 4096)
        while virta.hasBytesAvailable {
            let n = virta.read(&puskuri, maxLength: puskuri.count)
            if n <= 0 { break }
            data.append(puskuri, count: n)
        }
        return data
    }
}

/// Ytimen fixture (Tests/ScopesCore2Tests/fixture/, kopio scopes2/ydin/tests/fixture/).
func fixture(_ nimi: String) throws -> Data {
    guard let kansio = Bundle.module.resourceURL?.appendingPathComponent("fixture") else {
        throw XCTSkip("fixture-hakemisto puuttuu")
    }
    return try Data(contentsOf: kansio.appendingPathComponent(nimi))
}

/// Pollaa ehtoa, kunnes se täyttyy tai aika loppuu.
func odota(_ sekuntia: Double, _ ehto: @escaping @Sendable () -> Bool) async -> Bool {
    let raja = Date().addingTimeInterval(sekuntia)
    while Date() < raja {
        if ehto() { return true }
        try? await Task.sleep(nanoseconds: 50_000_000)
    }
    return ehto()
}

/// Sama MainActorilla (ehto lukee @MainActor-tilaa).
@MainActor
func odotaMainissa(_ sekuntia: Double, _ ehto: @MainActor () -> Bool) async -> Bool {
    let raja = Date().addingTimeInterval(sekuntia)
    while Date() < raja {
        if ehto() { return true }
        try? await Task.sleep(nanoseconds: 50_000_000)
    }
    return ehto()
}

/// Virran takaisinkutsujen keräys testeille.
final class Kerays: @unchecked Sendable {
    private let lukko = NSLock()
    private var _muutokset: [Muutos] = []
    private var _nollaukset: [Int] = []
    private var _tilat: [Bool] = []

    var muutokset: [Muutos] { lukko.withLock { _muutokset } }
    var nollaukset: [Int] { lukko.withLock { _nollaukset } }
    var tilat: [Bool] { lukko.withLock { _tilat } }
    var auki: Bool { lukko.withLock { _tilat.last ?? false } }

    func lisaaMuutos(_ m: Muutos) { lukko.withLock { _muutokset.append(m) } }
    func lisaaNollaus(_ n: Int) { lukko.withLock { _nollaukset.append(n) } }
    func lisaaTila(_ t: Bool) { lukko.withLock { _tilat.append(t) } }

    func virta(_ asiakas: Asiakas) -> Virta {
        Virta(asiakas: asiakas,
              muutos: { [self] in lisaaMuutos($0) },
              nollaus: { [self] in lisaaNollaus($0) },
              tila: { [self] in lisaaTila($0) })
    }
}

/// Pyyntöjen kirjanpito (kasittelija ajaa URLSessionin säikeessä).
final class Pyynnot: @unchecked Sendable {
    private let lukko = NSLock()
    private var _pyynnot: [URLRequest] = []
    var kaikki: [URLRequest] { lukko.withLock { _pyynnot } }
    func lisaa(_ r: URLRequest) { lukko.withLock { _pyynnot.append(r) } }
}
