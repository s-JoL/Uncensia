import XCTest

@MainActor final class ProjectUITests: XCTestCase {
  func testCreateProjectLinkResourceAndStartConversation() throws {
    let environment = ProcessInfo.processInfo.environment
    guard environment["UNCENSIA_PROJECT_FIXTURE"] == "1" else {
      throw XCTSkip("Run with the isolated iOS fixture")
    }
    let app = XCUIApplication()
    app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
    app.launchEnvironment = [
      "UNCENSIA_SERVER_URL": environment["UNCENSIA_SERVER_URL"] ?? "http://127.0.0.1:18090",
      "UNCENSIA_ACCESS_CODE": environment["UNCENSIA_ACCESS_CODE"] ?? "IOS-CI-ACCEPTANCE",
      "UNCENSIA_TEST_CONVERSATION_ID": environment["UNCENSIA_TEST_CONVERSATION_ID"] ?? "",
    ]
    app.launch()

    let projectsTab = app.tabBars.buttons["Projects"]
    XCTAssertTrue(projectsTab.waitForExistence(timeout: 15))
    projectsTab.tap()
    app.buttons["project.create"].tap()
    let title = app.textFields["project.title"]
    XCTAssertTrue(title.waitForExistence(timeout: 5))
    title.tap()
    title.typeText("Native project fixture")
    let instructions = app.textViews["project.instructions"]
    instructions.tap()
    instructions.typeText("Keep this project isolated and use its linked source.")
    app.buttons["project.save"].tap()

    let project = app.staticTexts["Native project fixture"].firstMatch
    XCTAssertTrue(project.waitForExistence(timeout: 10))
    project.tap()
    let addFile = app.buttons["project.addFile"]
    XCTAssertTrue(addFile.waitForExistence(timeout: 10))
    addFile.tap()
    let source = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "ios-ui-fixture.md")).firstMatch
    XCTAssertTrue(source.waitForExistence(timeout: 10))
    source.tap()
    XCTAssertTrue(app.staticTexts["ios-ui-fixture.md"].waitForExistence(timeout: 10))

    app.buttons["project.newConversation"].tap()
    XCTAssertTrue(app.buttons["conversation.actions"].waitForExistence(timeout: 10))
    app.buttons["conversation.actions"].tap()
    app.buttons["Conversation settings"].tap()
    XCTAssertTrue(app.staticTexts["Native project fixture"].firstMatch.waitForExistence(timeout: 10))
  }
}
