import XCTest

/// Opt-in: uses an already authenticated simulator and an explicit test conversation.
@MainActor final class RemoteAcceptanceTests: XCTestCase {
    private func launch(clearDraft: Bool = false) throws -> XCUIApplication {
        let environment = ProcessInfo.processInfo.environment
        guard let id = environment["UNCENSIA_TEST_CONVERSATION_ID"],
              let server = environment["UNCENSIA_SERVER_URL"] else {
            throw XCTSkip("Supply a dedicated remote acceptance conversation and sign in on this simulator first")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launchEnvironment["UNCENSIA_SERVER_URL"] = server
        app.launchEnvironment["UNCENSIA_TEST_CONVERSATION_ID"] = id
        if clearDraft { app.launchEnvironment["UNCENSIA_TEST_CLEAR_DRAFT"] = "1" }
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any)["chat.composer"].waitForExistence(timeout: 20))
        return app
    }
    func testLongTranscriptReadingDraftAndRelaunch() throws {
        let app = try launch()
        let scroll = app.scrollViews.firstMatch
        XCTAssertTrue(scroll.waitForExistence(timeout: 15))
        for _ in 0..<3 { scroll.swipeDown(velocity: .slow) }
        let latest = app.buttons["Jump to latest"]
        XCTAssertTrue(latest.waitForExistence(timeout: 4), "Upward reading must reveal return-to-latest")
        let composer = app.descendants(matching: .any)["chat.composer"]
        composer.tap(); composer.typeText("Draft survives reading and relaunch")
        XCTAssertTrue(latest.exists)
        let before = XCTAttachment(screenshot: app.screenshot()); before.name = "remote-reading-with-draft"; before.lifetime = .keepAlways; add(before)
        latest.tap()
        XCTAssertFalse(latest.exists)
        app.terminate(); app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 15))
        XCTAssertTrue((composer.value as? String ?? "").contains("Draft survives"))
        let after = XCTAttachment(screenshot: app.screenshot()); after.name = "remote-draft-restored"; after.lifetime = .keepAlways; add(after)
    }
    func testStreamingAllowsReadingAndDraftAcrossForegroundRecovery() throws {
        let app = try launch(clearDraft: true)
        let composer = app.descendants(matching: .any)["chat.composer"]
        composer.tap()
        let marker = "Stream" + String(UUID().uuidString.prefix(6))
        composer.typeText("Explain streaming chat in 20 numbered sections, at least 100 words per section. Do not use tools; begin the response immediately. Use headings \(marker) 01 through \(marker) 20. Include a Markdown table and block quote. This is a technical client test; answer in English.")
        app.buttons["Send"].tap()
        XCTAssertTrue(app.buttons["Stop"].firstMatch.waitForExistence(timeout: 20))
        let live = app.descendants(matching: .any)["chat.live.text"]
        XCTAssertTrue(live.waitForExistence(timeout: 100), "The live text container exists only after real text arrives")
        let firstText = XCTAttachment(screenshot: app.screenshot()); firstText.name = "remote-stream-first-text"; firstText.lifetime = .keepAlways; add(firstText)
        XCTAssertTrue(app.buttons["Stop"].firstMatch.exists, "Observe text before generation completes")
        let transcript = app.scrollViews["chat.transcript"]
        for _ in 0..<3 {
            transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.55)).press(forDuration: 0.05, thenDragTo: transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)))
        }
        let latest = app.buttons["Jump to latest"]
        XCTAssertTrue(latest.waitForExistence(timeout: 5))
        composer.tap(); composer.typeText("A draft written during the real stream")
        let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = "remote-stream-reading-draft"; attachment.lifetime = .keepAlways; add(attachment)
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        XCTAssertTrue((composer.value as? String ?? "").contains("draft written during"))
        XCTAssertTrue(latest.exists, "Foreground recovery must preserve upward reading")
        latest.tap()
        let resumed = XCTAttachment(screenshot: app.screenshot()); resumed.name = "remote-stream-foreground-recovery"; resumed.lifetime = .keepAlways; add(resumed)
    }

    func testRemoteInlineMediaPreviews() throws {
        let app = try launch()
        let video = app.buttons["Play video"].firstMatch
        XCTAssertTrue(video.waitForExistence(timeout: 20))
        let rendered = XCTAttachment(screenshot: app.screenshot()); rendered.name = "remote-inline-media"; rendered.lifetime = .keepAlways; add(rendered)
        video.tap()
        XCTAssertTrue(app.buttons["media.close"].firstMatch.waitForExistence(timeout: 15))
        XCTAssertTrue(app.descendants(matching: .any)["media.preview"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.staticTexts["Could not open"].exists)
        let playing = XCTAttachment(screenshot: app.screenshot()); playing.name = "remote-video-preview"; playing.lifetime = .keepAlways; add(playing)
        app.buttons["media.close"].firstMatch.tap()
        let transcript = app.scrollViews["chat.transcript"]
        transcript.swipeDown(); transcript.swipeDown()
        let image = app.buttons["Open image"].firstMatch
        XCTAssertTrue(image.waitForExistence(timeout: 15))
        image.tap()
        XCTAssertTrue(app.buttons["media.close"].firstMatch.waitForExistence(timeout: 15))
        XCTAssertTrue(app.descendants(matching: .any)["media.preview"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.staticTexts["Could not open"].exists)
        let opened = XCTAttachment(screenshot: app.screenshot()); opened.name = "remote-image-preview"; opened.lifetime = .keepAlways; add(opened)
        app.buttons["media.close"].firstMatch.tap()
    }

}
