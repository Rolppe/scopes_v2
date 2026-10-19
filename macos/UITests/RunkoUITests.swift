import XCTest

final class RunkoUITests: XCTestCase {
    func testNayttaaTekstin() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any)["scopes-V2"].firstMatch.waitForExistence(timeout: 15))
    }
}
