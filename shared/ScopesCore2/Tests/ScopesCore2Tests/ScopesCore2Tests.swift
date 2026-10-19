import XCTest
@testable import ScopesCore2

final class ScopesCore2Tests: XCTestCase {
    func testVersio() {
        XCTAssertEqual(ScopesCore2.versio, "0.1.0")
    }
}
