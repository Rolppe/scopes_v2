import XCTest
import SwiftUI
@testable import ScopesUI2

final class ScopesUI2Tests: XCTestCase {
    func testJuuriNakymaLuodaan() {
        let nakyma = JuuriNakyma()
        _ = nakyma.body
    }
}
