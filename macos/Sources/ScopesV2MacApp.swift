// T-49: macOS-kuori. Oma solmu käynnistyy äpin avautuessa (S-8a) ja pysähtyy lopetettaessa; näkymät tulevat ScopesUI2:sta.
// pohja: scopes/macos/Sources/ScopesMacApp.swift ja MacCommands (valikot) (19.10.2026)
import SwiftUI
import AppKit
import ScopesCore2
import ScopesUI2

extension Notification.Name {
    static let paivitaSkoopit = Notification.Name("com.example.scopes-v2.paivita")
}

final class SovellusValtuutettu: NSObject, NSApplicationDelegate {
    /// T-71: näyttö hereillä -asetus (tai argumentti -scopes2.naytto-hereilla YES) otetaan käyttöön heti, ilman asetusnäkymää.
    func applicationDidFinishLaunching(_ notification: Notification) {
        MainActor.assumeIsolated { NayttoHereilla.jaettu.kaynnista() }
    }

    func applicationWillTerminate(_ notification: Notification) {
        MainActor.assumeIsolated { NayttoHereilla.jaettu.vapauta() }   // väite pois ennen solmun pysäytystä
        let valmis = DispatchSemaphore(value: 0)
        Task.detached {
            await Solmu.jaettu.pysayta()
            valmis.signal()
        }
        _ = valmis.wait(timeout: .now() + 6)
    }
}

@main
struct ScopesV2MacApp: App {
    @NSApplicationDelegateAdaptor(SovellusValtuutettu.self) private var valtuutettu

    var body: some Scene {
        WindowGroup {
            Kuori()
        }
        .commands {
            CommandMenu("Skooppi") {
                Button("Päivitä") {
                    NotificationCenter.default.post(name: .paivitaSkoopit, object: nil)
                }
                .keyboardShortcut("r", modifiers: [.command])
            }
        }

        Settings {
            AsetuksetKuori()
        }
    }
}

struct Kuori: View {
    @State private var valmis = false
    @State private var kierros = 0

    var body: some View {
        Group {
            if valmis {
                JuuriNakyma(solmuUudelleen: { await SolmunElinkaari.uudelleen() }).id(kierros)
            } else {
                ProgressView("Käynnistetään solmua…")
            }
        }
        .frame(minWidth: 320, minHeight: 200)
        .task {
            await SolmunElinkaari.kaynnista()
            valmis = true
        }
        .onReceive(NotificationCenter.default.publisher(for: .paivitaSkoopit)) { _ in kierros += 1 }
    }
}

struct AsetuksetKuori: View {
    @State private var varasto = Varasto()
    @State private var asiakas: Asiakas?

    var body: some View {
        AsetuksetNakyma(varasto: varasto, asiakas: asiakas, avainMuuttui: {
            Task {
                await SolmunElinkaari.kaynnista()
                asiakas = await SolmunElinkaari.asiakas()
                NotificationCenter.default.post(name: .paivitaSkoopit, object: nil)
            }
        }, lisaosio: AnyView(KehitysOsio(varasto: varasto)))
        .frame(minWidth: 420, minHeight: 320)
        .task { asiakas = await SolmunElinkaari.asiakas() }
    }
}
