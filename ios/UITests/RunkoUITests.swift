import XCTest

final class RunkoUITests: XCTestCase {
    func testNayttaaTekstin() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts["scopes-V2"].waitForExistence(timeout: 15))
    }
}
