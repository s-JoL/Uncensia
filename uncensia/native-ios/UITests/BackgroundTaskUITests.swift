import XCTest

@MainActor final class BackgroundTaskUITests: XCTestCase {
  func testCreatePauseResumeInspectAndCancelContinuousTask() throws {
    let environment = ProcessInfo.processInfo.environment
    guard environment["UNCENSIA_TASK_FIXTURE"] == "1",
          let conversationID = environment["UNCENSIA_TEST_CONVERSATION_ID"] else {
      throw XCTSkip("Run with the isolated iOS fixture and its conversation ID")
    }
    let app = XCUIApplication()
    app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
    app.launchEnvironment = [
      "UNCENSIA_SERVER_URL": environment["UNCENSIA_SERVER_URL"] ?? "http://127.0.0.1:18090",
      "UNCENSIA_ACCESS_CODE": environment["UNCENSIA_ACCESS_CODE"] ?? "IOS-CI-ACCEPTANCE",
      "UNCENSIA_TEST_CONVERSATION_ID": conversationID,
    ]
    app.launch()
    XCTAssertTrue(app.buttons["conversation.actions"].waitForExistence(timeout: 15))
    app.buttons["conversation.actions"].tap()
    app.buttons["Background tasks"].tap()

    let prompt = app.textFields["task.prompt"].firstMatch
    XCTAssertTrue(prompt.waitForExistence(timeout: 10))
    prompt.tap()
    prompt.typeText("UI controlled continuous task")
    app.buttons["task.mode"].tap()
    app.buttons["Continue until done"].tap()
    let keyboardDone = app.buttons["task.keyboardDone"]
    if keyboardDone.exists { keyboardDone.tap() }
    let scheduled = app.switches["task.scheduled"]
    scheduled.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
    XCTAssertEqual(scheduled.value as? String, "1")
    app.buttons["task.create"].tap()

    XCTAssertTrue(app.staticTexts["UI controlled continuous task"].waitForExistence(timeout: 10))
    let pause = app.buttons["Pause"].firstMatch
    XCTAssertTrue(pause.waitForExistence(timeout: 5))
    pause.tap()
    XCTAssertTrue(app.staticTexts["Paused"].waitForExistence(timeout: 5))
    app.buttons["Continue"].firstMatch.tap()
    XCTAssertTrue(app.staticTexts["Waiting"].waitForExistence(timeout: 5))
    app.buttons["Execution records"].firstMatch.tap()
    XCTAssertTrue(app.staticTexts["No runs yet"].waitForExistence(timeout: 5))
    app.buttons["Cancel task"].firstMatch.tap()
    XCTAssertTrue(app.staticTexts["Cancelled"].waitForExistence(timeout: 5))
  }
}
