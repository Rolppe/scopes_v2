// T-71 (K-11): näyttö hereillä macOS-äpissä. Päällä äppi herättää näytön (IOPMAssertionDeclareUserActivity, vastaa `caffeinate -u`) ja
// pitää väitteen PreventUserIdleDisplaySleep (vastaa `caffeinate -d`); väitteet vapautetaan kytkimestä ja äpin lopetuksessa.
// Asetus on laitekohtainen UserDefaults-avain, ei tila-avain ytimeen (ei synkata); argumentti -scopes2.naytto-hereilla YES voittaa tallennetun.
import Foundation
import IOKit.pwr_mgt
import Observation

@MainActor
@Observable
final class NayttoHereilla {
    static let jaettu = NayttoHereilla()
    static let avain = "scopes2.naytto-hereilla"
    private static let nimi = "scopes-V2 näyttö hereillä"

    /// Näytön esto -väitteen id; 0 = ei väitettä.
    private var estoId: IOPMAssertionID = 0
    /// Käyttäjäaktiivisuuden julistuksen id (sama id uudelleenjulistuksessa); ei vaikuta näkymään.
    @ObservationIgnored private var aktiivisuusId: IOPMAssertionID = 0

    /// Väite on voimassa, kun näytön eston id ≠ 0.
    var voimassa: Bool { estoId != 0 }

    /// Tallennettu asetus (argumenttialue voittaa tallennetun; UserDefaults.standard lukee argumentin).
    static var asetettu: Bool { UserDefaults.standard.bool(forKey: avain) }

    /// Äpin käynnistys: noudattaa asetusta kirjoittamatta sitä (argumentti ei jää pysyväksi asetukseksi).
    func kaynnista() { aseta(Self.asetettu, tallenna: false) }

    /// Kytkimen muutos: tallentaa asetuksen laitteelle ja ottaa väitteen tai vapauttaa sen.
    func aseta(_ paalla: Bool) { aseta(paalla, tallenna: true) }

    private func aseta(_ paalla: Bool, tallenna: Bool) {
        if tallenna { UserDefaults.standard.set(paalla, forKey: Self.avain) }
        if paalla { ota() } else { vapauta() }
    }

    private func ota() {
        // herätys: julistus on kertaluonteinen (vastaa `caffeinate -u`); eston väite pitää näytön hereillä jatkossa
        let julistus = IOPMAssertionDeclareUserActivity(Self.nimi as CFString, kIOPMUserActiveLocal, &aktiivisuusId)
        if julistus != kIOReturnSuccess { NSLog("scopes-V2: näytön herätys epäonnistui: \(julistus)") }
        guard estoId == 0 else { return }
        var uusi: IOPMAssertionID = 0
        let tulos = IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString,
                                                IOPMAssertionLevel(kIOPMAssertionLevelOn), Self.nimi as CFString, &uusi)
        if tulos == kIOReturnSuccess {
            estoId = uusi
        } else {
            NSLog("scopes-V2: näytön eston väite epäonnistui: \(tulos)")
        }
    }

    /// Vapauttaa molemmat väitteet (kytkin pois, äpin lopetus); ei tee mitään, jos väitteitä ei ole.
    func vapauta() {
        if estoId != 0 {
            IOPMAssertionRelease(estoId)
            estoId = 0
        }
        if aktiivisuusId != 0 {
            IOPMAssertionRelease(aktiivisuusId)
            aktiivisuusId = 0
        }
    }
}
