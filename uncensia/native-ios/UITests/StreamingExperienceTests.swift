import XCTest

/// Opt in with UNCENSIA_STREAMING_FIXTURE=1 and run scripts/ios-streaming-fixture.py.
/// These assertions check actual visible text and server submissions, not just buttons.
@MainActor final class StreamingExperienceTests: XCTestCase {
    private let server = "http://127.0.0.1:18095"

    private func control(_ action: String, body: [String: Any] = [:]) async throws -> [String: Any] {
        var request = URLRequest(url: URL(string: server + "/__fixture/" + action)!)
        request.httpMethod = action == "state" ? "GET" : "POST"
        if request.httpMethod == "POST" {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func launch(_ conversation: String = "stream-fixture", holdQuotes: Bool = false, initialChunks: Int? = nil) async throws -> XCUIApplication {
        guard ProcessInfo.processInfo.environment["UNCENSIA_STREAMING_FIXTURE"] == "1" else {
            throw XCTSkip("Start the deterministic streaming fixture on 127.0.0.1:18095 and opt in")
        }
        var configuration: [String: Any] = ["holdQuotes": holdQuotes]
        if let initialChunks { configuration["initialChunks"] = initialChunks }
        _ = try await control("reset", body: configuration)
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launchEnvironment = ["UNCENSIA_SERVER_URL": server, "UNCENSIA_ACCESS_CODE": "local-fixture",
                                 "UNCENSIA_TEST_CONVERSATION_ID": conversation, "UNCENSIA_TEST_CLEAR_DRAFT": "1"]
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any)["chat.composer"].firstMatch.waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["SETTLED ANSWER END"].firstMatch.waitForExistence(timeout: 10))
        return app
    }

    private func settle(_ seconds: Double = 0.5) async throws {
        try await Task.sleep(for: .seconds(seconds))
    }

    private func screenshot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private struct ReadingSnapshot {
        let appFrame: CGRect
        let transcript: CGRect
        let composer: CGRect
        let keyboard: CGRect?
        let bounds: CGRect
        let anchor: (label: String, y: CGFloat)?
        let visibleLabels: [String]
    }

    /// One cross-process AX snapshot; all filtering below reads immutable local data.
    private func readingSnapshot(_ app: XCUIApplication, anchorPrefix: String = "History anchor ") throws -> ReadingSnapshot {
        let root = try app.snapshot()
        var pending: [any XCUIElementSnapshot] = [root]
        var nodes: [any XCUIElementSnapshot] = []
        while let node = pending.popLast() {
            nodes.append(node)
            pending.append(contentsOf: node.children)
        }
        let transcript = try XCTUnwrap(nodes.first { $0.identifier == "chat.transcript" && $0.elementType == .scrollView }).frame
        let composer = try XCTUnwrap(nodes.first { $0.identifier == "chat.composer" }).frame
        let keyboard = nodes.first { $0.elementType == .keyboard }?.frame
        let navigationBottom = nodes.filter { $0.elementType == .navigationBar }.map { $0.frame.maxY }.max() ?? root.frame.minY
        let clipped = transcript.intersection(root.frame)
        let top = max(clipped.minY, navigationBottom)
        // In landscape XCTest can report the keyboard in portrait coordinates
        // (a tall, narrow side strip). Only treat it as a bottom obstruction
        // when it actually spans most of the transcript width.
        let keyboardBottomLimit = keyboard.flatMap { frame in
            frame.intersection(clipped).width >= clipped.width * 0.5 ? frame.minY : nil
        } ?? root.frame.maxY
        let bottom = min(clipped.maxY, composer.minY, keyboardBottomLimit)
        let bounds = CGRect(x: clipped.minX, y: top, width: clipped.width, height: max(0, bottom - top))
        let anchor = nodes.filter {
            $0.elementType == .staticText && $0.label.hasPrefix(anchorPrefix)
                && $0.frame.minY > bounds.minY + 30 && $0.frame.maxY < bounds.maxY - 30
        }.min { $0.frame.minY < $1.frame.minY }
        let visibleLabels = nodes.filter {
            $0.elementType == .staticText && $0.frame.maxY > bounds.minY && $0.frame.minY < bounds.maxY
                && ($0.label.hasPrefix("Stream ") || $0.label.hasPrefix("History "))
        }.sorted { $0.frame.minY < $1.frame.minY }.prefix(3).map { String($0.label.prefix(120)) }
        return ReadingSnapshot(appFrame: root.frame, transcript: transcript, composer: composer,
                               keyboard: keyboard, bounds: bounds, anchor: anchor.map { ($0.label, $0.frame.minY) },
                               visibleLabels: visibleLabels)
    }

    private func assertVisible(_ element: XCUIElement, in app: XCUIApplication,
                               file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertTrue(element.exists, file: file, line: line)
        let frame = element.frame
        let bounds = try readingSnapshot(app).bounds
        XCTAssertGreaterThan(frame.height, 0, file: file, line: line)
        XCTAssertGreaterThan(bounds.height, 0, file: file, line: line)
        XCTAssertGreaterThanOrEqual(frame.minY, bounds.minY - 3,
                                   "The requested text must be below the navigation bar", file: file, line: line)
        XCTAssertLessThanOrEqual(frame.maxY, bounds.maxY + 3,
                                 "The requested text must be above the composer and keyboard", file: file, line: line)
    }

    private func dragReadingArea(_ app: XCUIApplication, towardOlder: Bool, distance: CGFloat = 160) throws {
        let snapshot = try readingSnapshot(app)
        let bounds = snapshot.bounds
        XCTAssertGreaterThan(bounds.height, 100)
        let movement = min(distance, bounds.height * 0.3)
        let origin = app.coordinate(withNormalizedOffset: .zero)
        // The gutter belongs to the outer transcript even beside a nested quote,
        // code block or formula scroller.
        let x = bounds.minX + 8 - snapshot.appFrame.minX
        let startY = bounds.midY - (towardOlder ? movement / 2 : -movement / 2) - snapshot.appFrame.minY
        let from = origin.withOffset(CGVector(dx: x, dy: startY))
        let to = origin.withOffset(CGVector(dx: x, dy: startY + (towardOlder ? movement : -movement)))
        from.press(forDuration: 0.05, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0)
    }

    private func startStream(_ app: XCUIApplication) {
        let composer = app.descendants(matching: .any)["chat.composer"].firstMatch
        composer.tap()
        composer.typeText("Start the deterministic streaming acceptance run")
        app.buttons["Send"].firstMatch.tap()
        XCTAssertTrue(app.buttons["Stop"].firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any)["chat.live.text"].firstMatch.waitForExistence(timeout: 10))
    }

    func testSettledLatestRemainsVisibleWhenKeyboardAndMultilineDraftOpen() async throws {
        let app = try await launch("settled-fixture")
        let transcript = app.scrollViews["chat.transcript"]
        let latestText = app.staticTexts["SETTLED ANSWER END"].firstMatch
        try assertVisible(latestText, in: app)
        let composer = app.descendants(matching: .any)["chat.composer"].firstMatch
        composer.tap()
        composer.typeText("First draft line\nSecond draft line\nThird draft line")
        try await settle()
        XCTAssertEqual(composer.value as? String, "First draft line\nSecond draft line\nThird draft line")
        XCTAssertGreaterThanOrEqual(transcript.frame.height, 100, "The keyboard must leave a usable reading area")
        try assertVisible(latestText, in: app)
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.exists)
        XCTAssertLessThanOrEqual(composer.frame.maxY, keyboard.frame.minY + 3)
        screenshot(app, "settled-answer-visible-above-multiline-composer")
    }

    func testStreamingAndFinalizationPreserveReadingAnchorAndExactDraft() async throws {
        try await checkStreamingReadingAndFinalization()
    }

    func testLongStreamingFinalizationPreservesHistoryAndShowsActualLastLine() async throws {
        try await checkStreamingReadingAndFinalization(minimumFinalChunks: 800)
    }

    func testLandscapeStreamingKeepsInputAndFinalLineVisible() async throws {
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }
        let app = try await launch(initialChunks: 2)
        startStream(app)
        let composer = app.descendants(matching: .any)["chat.composer"].firstMatch
        let draft = "Exact landscape draft 0123456789"
        composer.tap()
        composer.typeText(draft)
        let snapshot = try readingSnapshot(app)
        XCTAssertGreaterThan(snapshot.bounds.height, 44, "Landscape typing must leave at least one readable transcript line")
        XCTAssertGreaterThan(composer.frame.height, 0)
        XCTAssertNotNil(snapshot.keyboard)
        screenshot(app, "landscape-stream-input-visible")
        _ = try await control("release-stream")
        try await settle(2)
        _ = try await control("complete")
        XCTAssertTrue(app.buttons["Stop"].firstMatch.waitForNonExistence(timeout: 15))
        XCTAssertEqual(composer.value as? String, draft)
        let latest = app.buttons["Jump to latest"].firstMatch
        if latest.exists { latest.tap(); try await settle() }
        let end = app.staticTexts["FINAL ANSWER END"].firstMatch
        XCTAssertTrue(end.waitForExistence(timeout: 5))
        try assertVisible(end, in: app)
        screenshot(app, "landscape-final-line-visible")
    }

    private func checkStreamingReadingAndFinalization(minimumFinalChunks: Int = 0) async throws {
        // Limit only the setup phase. Slow XCTest typing must not build hundreds
        // of paragraphs before this test has even selected its reading position.
        let app = try await launch(initialChunks: 2)
        startStream(app)
        let composer = app.descendants(matching: .any)["chat.composer"].firstMatch
        let draft = "Exact draft during streaming 0123456789"
        composer.tap()
        composer.typeText(draft)
        let setupState = try await control("state")
        guard setupState["chunks"] as? Int == 2 else {
            XCTFail("The setup barrier must hold at 2 chunks while typing; restart the updated fixture")
            return
        }
        var diagnostics: [String] = []
        for index in 0..<4 {
            let snapshot = try readingSnapshot(app)
            diagnostics.append("Swipe \(index): transcript=\(snapshot.transcript), composer=\(snapshot.composer), keyboard=\(String(describing: snapshot.keyboard)), readBounds=\(snapshot.bounds), historyAnchor=\(String(describing: snapshot.anchor)), visible=\(snapshot.visibleLabels)")
            if index > 0 && snapshot.anchor != nil { break }
            let bounds = snapshot.bounds
            XCTAssertGreaterThan(bounds.height, 70, "A visible reading region must remain above the keyboard")
            let origin = app.coordinate(withNormalizedOffset: .zero)
            let from = origin.withOffset(CGVector(dx: bounds.midX - snapshot.appFrame.minX, dy: bounds.minY + bounds.height * 0.18 - snapshot.appFrame.minY))
            let to = origin.withOffset(CGVector(dx: bounds.midX - snapshot.appFrame.minX, dy: bounds.minY + bounds.height * 0.82 - snapshot.appFrame.minY))
            from.press(forDuration: 0.05, thenDragTo: to, withVelocity: .fast, thenHoldForDuration: 0)
        }
        let trace = XCTAttachment(string: diagnostics.joined(separator: "\n"))
        trace.name = "stream-gesture-visible-bounds"; trace.lifetime = .keepAlways; add(trace)
        try await settle()
        let anchor = try XCTUnwrap(try readingSnapshot(app).anchor, "The test must genuinely reach an older visible paragraph")
        let label = anchor.label
        let initialY = anchor.y
        XCTAssertTrue(app.buttons["Jump to latest"].exists,
                      "Release new output only after an actual scroll away from bottom following")
        let before = try await control("state")["chunks"] as? Int ?? 0
        screenshot(app, "stream-reading-anchor-before")
        _ = try await control("release-stream")
        try await settle(3)
        let after = try await control("state")["chunks"] as? Int ?? 0
        XCTAssertGreaterThan(after, before + 10, "Substantial output must arrive while the user reads history")
        XCTAssertEqual(app.staticTexts[label].firstMatch.frame.minY, initialY, accuracy: 3,
                       "New output must not move the same visible paragraph")
        XCTAssertEqual(composer.value as? String, draft, "Streaming must preserve every draft character")
        _ = try await control("complete", body: ["minimumChunks": minimumFinalChunks])
        let finalState = try await control("state")
        XCTAssertGreaterThanOrEqual(finalState["chunks"] as? Int ?? 0, minimumFinalChunks,
                                    "The long case must actually emit all additional chunks before the terminal event")
        // Stop belongs to the active SSE run. Waiting for its disappearance
        // ensures the position check observes finalization, not the pre-burst UI.
        let stop = app.buttons["Stop"].firstMatch
        XCTAssertTrue(stop.waitForNonExistence(timeout: 15), "The UI must consume the terminal event before measuring its final layout")
        try await settle(1)
        XCTAssertEqual(app.staticTexts[label].firstMatch.frame.minY, initialY, accuracy: 3,
                       "Replacing the streaming row with final Markdown must preserve reading position")
        XCTAssertEqual(composer.value as? String, draft)
        let latest = app.buttons["Jump to latest"].firstMatch
        XCTAssertTrue(latest.exists)
        screenshot(app, "stream-finalized-with-reading-anchor")
        latest.tap()
        try await settle()
        let end = app.staticTexts["FINAL ANSWER END"].firstMatch
        XCTAssertTrue(end.waitForExistence(timeout: 5))
        try assertVisible(end, in: app)
        screenshot(app, "final-answer-end-actually-visible")
    }

    func testFollowUpDoubleTapSubmitsOnceAndPreservesLaterTyping() async throws {
        let app = try await launch()
        startStream(app)
        let composer = app.descendants(matching: .any)["chat.composer"].firstMatch
        composer.tap()
        composer.typeText("Submit this follow up once")
        let send = app.buttons["Send"].firstMatch
        let center = send.frame
        let coordinate = app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: center.midX - app.frame.minX, dy: center.midY - app.frame.minY))
        coordinate.doubleTap()
        try await settle(2)
        let state = try await control("state")
        let commands = try XCTUnwrap(state["commands"] as? [[String: Any]])
        let followUps = commands.filter { $0["action"] as? String == "follow-up" }
        XCTAssertEqual(followUps.count, 1, "Two fast taps during acknowledgment must queue only one follow up")
        XCTAssertEqual(followUps.first?["text"] as? String, "Submit this follow up once")
        XCTAssertTrue(app.buttons["Stop"].firstMatch.exists, "Submitting a follow up must not stop the active reply")
        composer.tap()
        composer.typeText("A separate draft remains editable")
        XCTAssertEqual(composer.value as? String, "A separate draft remains editable")
        screenshot(app, "follow-up-acknowledged-once-next-draft")
        _ = try await control("complete")
    }

    func testLoadingEarlierMessagesPreservesVisibleParagraphOffset() async throws {
        let app = try await launch("settled-fixture")
        let transcript = app.scrollViews["chat.transcript"]
        let earlier = app.buttons["Load earlier messages"].firstMatch
        for _ in 0..<18 {
            if earlier.exists && earlier.isHittable { break }
            transcript.swipeDown(velocity: .fast)
        }
        XCTAssertTrue(earlier.isHittable, "Reach the actual first page before testing pagination")
        try await settle()
        let anchor = app.staticTexts["History anchor 060"].firstMatch
        try assertVisible(anchor, in: app)
        let initialY = anchor.frame.minY
        screenshot(app, "history-pagination-before")
        earlier.tap()
        try await settle(1.5)
        let state = try await control("state")
        XCTAssertTrue((state["olderRequests"] as? [Int] ?? []).contains(60), "A real older page must be requested")
        XCTAssertEqual(anchor.frame.minY, initialY, accuracy: 3,
                       "Prepending history must preserve the paragraph's pixel offset, not merely its message ID")
        screenshot(app, "history-pagination-after")
    }

    func testTranscriptScrollDecelerationPerformance() async throws {
        let app = try await launch("settled-fixture")
        let transcript = app.scrollViews["chat.transcript"]
        let options = XCTMeasureOptions()
        options.iterationCount = 3
        measure(metrics: [XCTOSSignpostMetric.scrollDecelerationMetric], options: options) {
            transcript.swipeDown(velocity: .fast)
            transcript.swipeUp(velocity: .fast)
        }
        screenshot(app, "scroll-deceleration-measurement")
    }

    func testLibraryHandoffKeepsTheChosenAttachmentInTheNewChat() async throws {
        let app = try await launch("settled-fixture")
        let composer = app.descendants(matching: .any)["chat.composer"].firstMatch
        composer.tap()
        composer.typeText("Old conversation draft must stay here")
        // The history action uses the app's real focus dismissal. Closing that
        // panel restores the tabs without relying on the removed keyboard bar.
        app.buttons["conversation.history"].tap()
        let closeHistory = app.buttons["Close"].firstMatch
        XCTAssertTrue(closeHistory.waitForExistence(timeout: 5))
        closeHistory.tap()
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        app.tabBars.buttons["Library"].tap()
        let attach = app.buttons["library.attach.fixture-note"]
        XCTAssertTrue(attach.waitForExistence(timeout: 10))
        attach.tap()
        app.buttons["Add as context"].firstMatch.tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Attach this exact note.txt"].firstMatch.waitForExistence(timeout: 5),
                      "The exact selected library item must survive the new-conversation transition")
        XCTAssertFalse((composer.value as? String ?? "").contains("Old conversation draft"))
        screenshot(app, "library-attachment-survives-new-chat-handoff")
    }

    func testResourceReaderShowsSourcesPaginatesAndChangesEncoding() async throws {
        let app = try await launch("settled-fixture")
        app.tabBars.buttons["Library"].tap()
        let note = app.staticTexts["Attach this exact note.txt"].firstMatch
        XCTAssertTrue(note.waitForExistence(timeout: 10))
        app.buttons["library.open.fixture-note"].tap()
        let reader = app.buttons["library.resourceReader"]
        XCTAssertTrue(reader.waitForExistence(timeout: 10))
        reader.tap()
        let text = app.staticTexts["resource.reader.text"]
        XCTAssertTrue(text.waitForExistence(timeout: 10))
        XCTAssertTrue(text.label.contains("Original page at line 1"))
        XCTAssertTrue(app.descendants(matching: .any)["resource.reader.source"].firstMatch.exists)
        app.buttons["resource.reader.next"].tap()
        try await settle()
        XCTAssertTrue(text.label.contains("Original page at line 3"))
        app.buttons["resource.reader.previous"].tap()
        try await settle()
        XCTAssertTrue(text.label.contains("Original page at line 1"))
        app.descendants(matching: .any)["resource.reader.encoding"].firstMatch.tap()
        app.buttons["GB18030"].firstMatch.tap()
        try await settle()
        XCTAssertTrue(text.label.contains("Encoding: gb18030"))
        let state = try await control("state")
        let reads = try XCTUnwrap(state["resourceReads"] as? [[String: Any]])
        XCTAssertTrue(reads.contains { $0["start"] as? Int == 3 })
        XCTAssertTrue(reads.contains { $0["encoding"] as? String == "gb18030" })
        screenshot(app, "resource-reader-original-source-and-encoding")
    }

    func testConversationEvidenceShowsPersistedDeliveryAndFeedback() async throws {
        let app = try await launch("settled-fixture")
        app.buttons["conversation.actions"].tap()
        app.buttons["Deliverables, feedback and execution"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Verified fixture delivery"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Keep the original wording."].exists)
        app.buttons["fixture-model"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Original selected source, version 2"].waitForExistence(timeout: 5))
        screenshot(app, "conversation-delivery-feedback-and-context")
        app.buttons["conversation.deliverable.fixture-delivery"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["media.preview"].waitForExistence(timeout: 10))
        screenshot(app, "conversation-delivered-file-opened")
    }

    func testOriginalExcerptAndMathRenderInsideTheTranscript() async throws {
        let app = try await launch("render-fixture")
        let copy = app.buttons["resource.quote.copy"].firstMatch
        let foundCopy = copy.waitForExistence(timeout: 10)
        if !foundCopy {
            var pending: [(any XCUIElementSnapshot, Int)] = [(try app.snapshot(), 0)]
            var lines: [String] = []
            while let (node, depth) = pending.popLast() {
                lines.append("\(String(repeating: "  ", count: depth))type=\(node.elementType.rawValue) id=\(String(reflecting: node.identifier)) label=\(String(reflecting: node.label)) value=\(String(reflecting: node.value)) frame=\(node.frame) enabled=\(node.isEnabled) selected=\(node.isSelected)")
                pending.append(contentsOf: node.children.reversed().map { ($0, depth + 1) })
            }
            let tree = XCTAttachment(string: lines.joined(separator: "\n"))
            tree.name = "native-excerpt-copy-missing-before-any-swipe-AX"; tree.lifetime = .keepAlways; add(tree)
            screenshot(app, "native-excerpt-copy-missing-before-any-swipe")
        }
        XCTAssertTrue(foundCopy, "Wait for the original-source request before scrolling its row away")
        screenshot(app, "native-excerpt-initial-loaded-state")
        let heading = app.staticTexts["Formula and original-source rendering"].firstMatch
        let formula = app.scrollViews["chat.math"].firstMatch
        XCTAssertTrue(heading.waitForExistence(timeout: 5))
        XCTAssertTrue(formula.waitForExistence(timeout: 5))
        for _ in 0..<10 {
            let bounds = try readingSnapshot(app).bounds
            let group = heading.frame.union(formula.frame)
            if group.minY >= bounds.minY + 20 && group.maxY <= bounds.maxY - 20 { break }
            try dragReadingArea(app, towardOlder: group.minY < bounds.minY + 20)
        }
        try assertVisible(heading, in: app)
        try assertVisible(formula, in: app)
        screenshot(app, "native-formula-heading-inline-and-display-visible")
        for _ in 0..<10 {
            let bounds = try readingSnapshot(app).bounds
            let frame = copy.frame
            if copy.exists && copy.isHittable && frame.minY >= bounds.minY + 10 && frame.maxY <= bounds.maxY - 10 { break }
            try dragReadingArea(app, towardOlder: frame.minY < bounds.minY + 10)
        }
        try assertVisible(copy, in: app)
        XCTAssertTrue(copy.isHittable, "Original excerpt must render as a native source card")
        XCTAssertTrue(app.staticTexts["Exact original text: keep line one.\nKeep the second line unchanged."].firstMatch.exists)
        screenshot(app, "native-exact-original-excerpt-controls-visible")
        copy.tap()
        try await settle()
        XCTAssertTrue(copy.label.contains("Copied"))
        app.buttons["resource.quote.download"].firstMatch.tap()
        XCTAssertTrue(app.descendants(matching: .any)["media.preview"].waitForExistence(timeout: 10))
        screenshot(app, "original-excerpt-file-preview")
    }

    func testHeldOriginalExcerptDoesNotMoveTheFollowingParagraph() async throws {
        let app = try await launch("render-fixture", holdQuotes: true)
        let transcript = app.scrollViews["chat.transcript"]
        let anchor = app.staticTexts["Quote loading anchor"].firstMatch
        let copy = app.buttons["resource.quote.copy"].firstMatch
        func captureMissingCopy(_ name: String) throws {
            var pending: [(any XCUIElementSnapshot, Int)] = [(try app.snapshot(), 0)]
            var lines: [String] = []
            while let (node, depth) = pending.popLast() {
                lines.append("\(String(repeating: "  ", count: depth))type=\(node.elementType.rawValue) id=\(String(reflecting: node.identifier)) label=\(String(reflecting: node.label)) value=\(String(reflecting: node.value)) frame=\(node.frame) enabled=\(node.isEnabled) selected=\(node.isSelected)")
                pending.append(contentsOf: node.children.reversed().map { ($0, depth + 1) })
            }
            let tree = XCTAttachment(string: lines.joined(separator: "\n"))
            tree.name = name + "-AX"; tree.lifetime = .keepAlways; add(tree)
            screenshot(app, name)
        }
        if !copy.exists { try captureMissingCopy("held-excerpt-copy-missing-before-any-swipe") }
        // Leave bottom-following even when the anchor is already visible at
        // launch. Drag the transcript gutter, outside the quote's inner scroller.
        let initial = try readingSnapshot(app, anchorPrefix: "Quote loading anchor")
        XCTAssertGreaterThan(initial.bounds.height, 100)
        let origin = app.coordinate(withNormalizedOffset: .zero)
        let x = initial.bounds.minX + 8 - initial.appFrame.minX
        let y = initial.bounds.minY + initial.bounds.height * 0.45 - initial.appFrame.minY
        let from = origin.withOffset(CGVector(dx: x, dy: y))
        let to = origin.withOffset(CGVector(dx: x, dy: y + min(100, initial.bounds.height * 0.2)))
        from.press(forDuration: 0.05, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0)
        try await settle()
        for _ in 0..<6 {
            let snapshot = try readingSnapshot(app, anchorPrefix: "Quote loading anchor")
            if snapshot.anchor != nil { break }
            if anchor.frame.minY < snapshot.bounds.minY { transcript.swipeDown(velocity: .slow) }
            else { transcript.swipeUp(velocity: .slow) }
        }
        let readingAnchor = try XCTUnwrap(try readingSnapshot(app, anchorPrefix: "Quote loading anchor").anchor)
        XCTAssertTrue(app.buttons["Jump to latest"].exists, "Observe the quote while reading away from automatic bottom following")
        let beforeState = try await control("state")
        XCTAssertEqual(beforeState["quoteDeliveries"] as? Int, 0, "The server must still be holding the original excerpt")
        let before = readingAnchor.y
        screenshot(app, "held-excerpt-before-original-arrives")
        _ = try await control("release-quote")
        let foundCopy = copy.waitForExistence(timeout: 10)
        if !foundCopy { try captureMissingCopy("held-excerpt-copy-missing-after-release") }
        XCTAssertTrue(foundCopy)
        try await settle()
        XCTAssertEqual(anchor.frame.minY, before, accuracy: 3,
                       "Loading the exact source must not move the paragraph below its card")
        screenshot(app, "held-excerpt-after-original-arrives")
    }

    func testImportOriginalFromLinkRefreshesTheLibrary() async throws {
        let app = try await launch("settled-fixture")
        app.tabBars.buttons["Library"].tap()
        app.buttons["library.import"].tap()
        app.buttons["Import from link"].firstMatch.tap()
        let address = app.textFields["resource.import.url"]
        XCTAssertTrue(address.waitForExistence(timeout: 5))
        address.tap(); address.typeText("https://example.com/original-document.txt")
        app.buttons["resource.import.submit"].tap()
        XCTAssertTrue(app.staticTexts["Imported original document.txt"].waitForExistence(timeout: 10),
                      "A successful server import must refresh the actual library")
        let state = try await control("state")
        XCTAssertEqual(state["imports"] as? [String], ["https://example.com/original-document.txt"])
        screenshot(app, "link-import-refreshed-library")
    }

    func testMessageFeedbackFailurePreservesTextAndRetryUsesTheCorrectMessage() async throws {
        let app = try await launch("settled-fixture")
        app.staticTexts["SETTLED ANSWER END"].firstMatch.press(forDuration: 0.8)
        app.buttons["message.feedback.open.settled-fixture-79"].firstMatch.tap()
        let editor = app.textViews["message.feedback.text"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        editor.tap(); editor.typeText("Retry this feedback once")
        app.buttons["message.feedback.save"].tap()
        XCTAssertTrue(app.staticTexts["message.feedback.error"].waitForExistence(timeout: 5))
        XCTAssertEqual(editor.value as? String, "Retry this feedback once")
        screenshot(app, "message-feedback-failure-keeps-text")
        app.buttons["message.feedback.save"].tap()
        try await settle()
        let state = try await control("state")
        let feedback = try XCTUnwrap(state["feedback"] as? [[String: Any]])
        XCTAssertEqual(feedback.count, 1)
        XCTAssertEqual(feedback.first?["conversationId"] as? String, "settled-fixture")
        XCTAssertEqual(feedback.first?["seq"] as? Int, 79)
        XCTAssertEqual(feedback.first?["text"] as? String, "Retry this feedback once")
        XCTAssertFalse(editor.exists, "Only an acknowledged save should dismiss the feedback editor")
    }
}
