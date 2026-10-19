// S-1: muutosvirta GET /api/virta (text/event-stream), luettuna URLSession.bytes:llä.
import Foundation

public struct Muutos: Codable, Sendable, Equatable {
    public let seq: Int
    public let polku: String
    public let id: String
    public let aika: String

    public init(seq: Int, polku: String, id: String, aika: String) {
        self.seq = seq
        self.polku = polku
        self.id = id
        self.aika = aika
    }
}

/// Yksi valmis SSE-kehys (tyhjä rivi päättää kehyksen).
public struct SseKehys: Equatable, Sendable {
    public let id: String?
    public let tapahtuma: String
    public let data: String

    public init(id: String?, tapahtuma: String, data: String) {
        self.id = id
        self.tapahtuma = tapahtuma
        self.data = data
    }
}

/// Puhdas kehysjäsennin: syötä mielivaltaisia pätkiä, saat valmiit kehykset.
/// ":"-kommentit ohi, monirivinen data, rivinvaihdot \n, \r\n ja \r (myös pätkän rajalla).
public struct SseJasennin: Sendable {
    private var rivi: [UInt8] = []
    private var edellinenCR = false
    private var id: String?
    private var tapahtuma: String?
    private var dataRivit: [String] = []

    public init() {}

    public mutating func syota(_ pala: Data) -> [SseKehys] {
        var valmiit: [SseKehys] = []
        for b in pala {
            if edellinenCR {
                edellinenCR = false
                if b == 10 { continue }
            }
            if b == 13 {
                edellinenCR = true
                kasitteleRivi(&valmiit)
            } else if b == 10 {
                kasitteleRivi(&valmiit)
            } else {
                rivi.append(b)
            }
        }
        return valmiit
    }

    public mutating func syota(_ teksti: String) -> [SseKehys] {
        syota(Data(teksti.utf8))
    }

    private mutating func kasitteleRivi(_ valmiit: inout [SseKehys]) {
        let teksti = String(decoding: rivi, as: UTF8.self)
        rivi.removeAll(keepingCapacity: true)
        if teksti.isEmpty {
            if !dataRivit.isEmpty {
                valmiit.append(SseKehys(id: id, tapahtuma: tapahtuma ?? "message", data: dataRivit.joined(separator: "\n")))
            }
            tapahtuma = nil
            dataRivit.removeAll()
            return
        }
        if teksti.hasPrefix(":") { return }
        let kentta: String
        var arvo: String
        if let kohta = teksti.firstIndex(of: ":") {
            kentta = String(teksti[teksti.startIndex..<kohta])
            arvo = String(teksti[teksti.index(after: kohta)...])
            if arvo.hasPrefix(" ") { arvo.removeFirst() }
        } else {
            kentta = teksti
            arvo = ""
        }
        switch kentta {
        case "data": dataRivit.append(arvo)
        case "event": tapahtuma = arvo
        case "id": if !arvo.contains("\0") { id = arvo }
        default: break
        }
    }
}

/// Muutosvirran lukija: yhdistää, jäsentää, uusii katkon jälkeen (1, 2, 4 … 30 s); 401 → ei uusintaa.
public final class Virta: @unchecked Sendable {
    private let asiakas: Asiakas
    private let muutosFn: @Sendable (Muutos) -> Void
    private let nollausFn: @Sendable (Int) -> Void
    private let tilaFn: @Sendable (Bool) -> Void
    private let lukko = NSLock()
    private var _seq = 0
    private var seqTiedossa = false
    private var _auki = false
    private var sukupolvi = 0
    private var tehtava: Task<Void, Never>?

    public init(asiakas: Asiakas,
                muutos: @escaping @Sendable (Muutos) -> Void,
                nollaus: @escaping @Sendable (Int) -> Void,
                tila: @escaping @Sendable (Bool) -> Void) {
        self.asiakas = asiakas
        self.muutosFn = muutos
        self.nollausFn = nollaus
        self.tilaFn = tila
    }

    /// Viimeisin nähty seq (0, jos ei vielä yhtään).
    public var seq: Int { lukko.withLock { _seq } }

    /// since nil → vain uudet tapahtumat; muuten tapahtumat since:n jälkeen (Last-Event-ID).
    public func aloita(since: Int?) {
        sulje()
        let sp = lukko.withLock { () -> Int in
            if let since { _seq = since; seqTiedossa = true } else { _seq = 0; seqTiedossa = false }
            sukupolvi += 1
            return sukupolvi
        }
        let t = Task { [self] in await silmukka(sp) }
        lukko.withLock { tehtava = t }
    }

    public func sulje() {
        let t = lukko.withLock { () -> Task<Void, Never>? in
            let t = tehtava
            tehtava = nil
            sukupolvi += 1
            return t
        }
        t?.cancel()
        aseta(false, nil)
    }

    /// sp nil → ehdoton; muuten vain, jos silmukka on yhä voimassa oleva sukupolvi.
    private func aseta(_ auki: Bool, _ sp: Int?) {
        let muuttui = lukko.withLock { () -> Bool in
            if let sp, sp != sukupolvi { return false }
            let m = _auki != auki
            _auki = auki
            return m
        }
        if muuttui { tilaFn(auki) }
    }

    private func silmukka(_ sp: Int) async {
        var viive: UInt64 = 1
        while !Task.isCancelled {
            do {
                let (alku, tiedossa) = lukko.withLock { (_seq, seqTiedossa) }
                var req = try asiakas.pyynto(tiedossa ? "/api/virta?since=\(alku)" : "/api/virta", tyyppi: nil, aikaraja: 90)
                req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                req.cachePolicy = .reloadIgnoringLocalCacheData
                if tiedossa { req.setValue(String(alku), forHTTPHeaderField: "Last-Event-ID") }
                let (tavut, vastaus) = try await asiakas.session.bytes(for: req)
                guard let http = vastaus as? HTTPURLResponse else { throw ApiVirhe(tila: 0) }
                if http.statusCode == 401 {
                    aseta(false, sp)
                    return
                }
                guard (200..<300).contains(http.statusCode) else { throw ApiVirhe(tila: http.statusCode) }
                viive = 1
                aseta(true, sp)
                var jasennin = SseJasennin()
                var puskuri = [UInt8]()
                for try await b in tavut {
                    puskuri.append(b)
                    if b == 10 {
                        for kehys in jasennin.syota(Data(puskuri)) { kasittele(kehys, sp) }
                        puskuri.removeAll(keepingCapacity: true)
                    }
                }
            } catch {
                if Task.isCancelled { break }
            }
            aseta(false, sp)
            if Task.isCancelled { break }
            try? await Task.sleep(nanoseconds: viive * 1_000_000_000)
            viive = min(viive * 2, 30)
        }
        aseta(false, sp)
    }

    private func kasittele(_ kehys: SseKehys, _ sp: Int) {
        guard lukko.withLock({ sp == sukupolvi }) else { return }
        aseta(true, sp)   // palvelin voi lähettää otsakkeet vasta ensimmäisen kehyksen mukana
        guard let data = kehys.data.data(using: .utf8) else { return }
        switch kehys.tapahtuma {
        case "muutos":
            guard let m = try? JSONDecoder().decode(Muutos.self, from: data) else { return }
            lukko.withLock {
                if m.seq > _seq { _seq = m.seq }
                seqTiedossa = true
            }
            muutosFn(m)
        case "nollaus":
            struct Nollaus: Decodable { let seq: Int }
            guard let n = try? JSONDecoder().decode(Nollaus.self, from: data) else { return }
            lukko.withLock {
                _seq = n.seq
                seqTiedossa = true
            }
            nollausFn(n.seq)
        default:
            break
        }
    }
}
