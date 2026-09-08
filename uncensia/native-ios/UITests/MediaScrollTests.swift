import XCTest

/// Run scripts/ios-scroll-fixture.py first. No real conversations are modified.
@MainActor final class MediaScrollTests: XCTestCase {
    func testDelayedPortraitAndLandscapeImagesDoNotMoveReadingPosition() throws {
        guard ProcessInfo.processInfo.environment["UNCENSIA_SCROLL_FIXTURE"] == "1" else { throw XCTSkip("Start the delayed-image fixture and opt in") }
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launchEnvironment = ["UNCENSIA_SERVER_URL": "http://127.0.0.1:18094", "UNCENSIA_ACCESS_CODE": "local-fixture", "UNCENSIA_TEST_CONVERSATION_ID": "scroll-fixture"]
        app.launch()
        let transcript = app.scrollViews["chat.transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 15))
        XCTAssertTrue(app.descendants(matching: .any)["chat.message.message-79"].firstMatch.waitForExistence(timeout: 10))
        for _ in 0..<3 { transcript.swipeDown(velocity: .fast) }
        let rows = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Read marker"))
        let bounds = transcript.frame
        guard let anchor = rows.allElementsBoundByIndex.first(where: { $0.frame.minY > max(bounds.minY, 150) && $0.frame.maxY < bounds.maxY - 100 }) else { return XCTFail("Expected a visible reading anchor") }
        let label = anchor.label
        let before = anchor.frame.minY
        let start = XCTAttachment(screenshot: app.screenshot()); start.name = "reading-before-delayed-images"; start.lifetime = .keepAlways; add(start)
        let settled = expectation(description: "Delayed image responses settle")
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { settled.fulfill() }
        wait(for: [settled], timeout: 12)
        let restored = app.staticTexts[label].firstMatch
        XCTAssertTrue(restored.exists)
        XCTAssertEqual(restored.frame.minY, before, accuracy: 3, "Image completion must not move the reading anchor")
        let finish = XCTAttachment(screenshot: app.screenshot()); finish.name = "reading-after-delayed-images"; finish.lifetime = .keepAlways; add(finish)
        XCTAssertTrue(app.buttons["Jump to latest"].exists)
    }
}
