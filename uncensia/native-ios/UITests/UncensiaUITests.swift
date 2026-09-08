import XCTest

@MainActor final class UncensiaUITests: XCTestCase {
    func testEnglishWorkspaces() {
        let app = XCUIApplication()
        app.launchArguments += ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launchEnvironment["UNCENSIA_SERVER_URL"] = ProcessInfo.processInfo.environment["UNCENSIA_SERVER_URL"] ?? "http://127.0.0.1:18093"
        app.launchEnvironment["UNCENSIA_ACCESS_CODE"] = ProcessInfo.processInfo.environment["UNCENSIA_ACCESS_CODE"] ?? "IOS-CI-ACCEPTANCE"
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Chat"].waitForExistence(timeout: 10))
        for title in ["Studio", "Library", "Settings"] { XCTAssertTrue(app.tabBars.buttons[title].exists) }
    }

    func testFixtureLoginShowsAllNativeWorkspaces() {
        let app = XCUIApplication()
        app.launchArguments += ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launchEnvironment["UNCENSIA_SERVER_URL"] = ProcessInfo.processInfo.environment["UNCENSIA_SERVER_URL"] ?? "http://127.0.0.1:18093"
        app.launchEnvironment["UNCENSIA_ACCESS_CODE"] = ProcessInfo.processInfo.environment["UNCENSIA_ACCESS_CODE"] ?? "IOS-CI-ACCEPTANCE"
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["对话"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.tabBars.buttons["创作台"].exists)
        XCTAssertTrue(app.tabBars.buttons["资料库"].exists)
        XCTAssertTrue(app.tabBars.buttons["设置"].exists)
    }

    func testSendAndSessionSurvivesRelaunch() {
        let app = XCUIApplication()
        app.launchArguments += ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launchEnvironment["UNCENSIA_SERVER_URL"] = ProcessInfo.processInfo.environment["UNCENSIA_SERVER_URL"] ?? "http://127.0.0.1:18093"
        app.launchEnvironment["UNCENSIA_ACCESS_CODE"] = ProcessInfo.processInfo.environment["UNCENSIA_ACCESS_CODE"] ?? "IOS-CI-ACCEPTANCE"
        app.launch()
        let composer = app.textFields["发消息"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.tap(); composer.typeText("解释向量数据库和幂等重试")
        app.buttons["发送"].tap()
        let assistant = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "把内容做成向量后按相似度检索")).element
        XCTAssertTrue(assistant.waitForExistence(timeout: 20))
        app.terminate()
        app.launchEnvironment.removeValue(forKey: "UNCENSIA_ACCESS_CODE")
        app.launch()
        XCTAssertTrue(assistant.waitForExistence(timeout: 10), "重启后应从保存的服务器和 Keychain 会话恢复同一段对话")
    }
}
