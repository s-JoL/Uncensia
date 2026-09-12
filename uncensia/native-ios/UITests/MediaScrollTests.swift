import XCTest

/// Run scripts/ios-scroll-fixture.py first. No real conversations are modified.
@MainActor final class MediaScrollTests: XCTestCase {
    private let server = "http://127.0.0.1:18094"

    private func control(_ action: String, body: [String: Any] = [:]) async throws -> [String: Any] {
        var request = URLRequest(url: URL(string: server + "/__fixture/" + action)!)
        request.httpMethod = action.hasPrefix("state") ? "GET" : "POST"
        if request.httpMethod == "POST" {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private struct ReadingSnapshot {
        let appFrame: CGRect
        let bounds: CGRect
        let anchor: (label: String, index: Int, y: CGFloat)?
    }

    private func readingSnapshot(_ app: XCUIApplication) throws -> ReadingSnapshot {
        let root = try app.snapshot()
        var pending: [any XCUIElementSnapshot] = [root]
        var nodes: [any XCUIElementSnapshot] = []
        while let node = pending.popLast() {
            nodes.append(node)
            pending.append(contentsOf: node.children)
        }
        let transcript = try XCTUnwrap(nodes.first { $0.identifier == "chat.transcript" && $0.elementType == .scrollView }).frame
        let composer = try XCTUnwrap(nodes.first { $0.identifier == "chat.composer" }).frame
        let navigationBottom = nodes.filter { $0.elementType == .navigationBar }.map { $0.frame.maxY }.max() ?? root.frame.minY
        let keyboardTop = nodes.first { $0.elementType == .keyboard }?.frame.minY ?? root.frame.maxY
        let clipped = transcript.intersection(root.frame)
        let top = max(clipped.minY, navigationBottom)
        let bottom = min(clipped.maxY, composer.minY, keyboardTop)
        let bounds = CGRect(x: clipped.minX, y: top, width: clipped.width, height: max(0, bottom - top))
        let candidate = nodes.filter {
            $0.elementType == .staticText && $0.label.hasPrefix("Read marker ")
                && $0.frame.minY > bounds.minY + 30 && $0.frame.maxY < bounds.maxY - 100
        }.min { abs($0.frame.minY - bounds.minY - 60) < abs($1.frame.minY - bounds.minY - 60) }
        let anchor = candidate.flatMap { node -> (label: String, index: Int, y: CGFloat)? in
            guard let index = Int(node.label.replacingOccurrences(of: "Read marker ", with: "")) else { return nil }
            return (node.label, index, node.frame.minY)
        }
        return ReadingSnapshot(appFrame: root.frame, bounds: bounds, anchor: anchor)
    }

    func testDelayedPortraitAndLandscapeImagesDoNotMoveReadingPosition() async throws {
        guard ProcessInfo.processInfo.environment["UNCENSIA_SCROLL_FIXTURE"] == "1" else { throw XCTSkip("Start the delayed-image fixture and opt in") }
        _ = try await control("reset", body: ["hold": true])
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launchEnvironment = ["UNCENSIA_SERVER_URL": server, "UNCENSIA_ACCESS_CODE": "local-fixture", "UNCENSIA_TEST_CONVERSATION_ID": "scroll-fixture", "UNCENSIA_TEST_CLEAR_DRAFT": "1"]
        app.launch()
        XCTAssertTrue(app.scrollViews["chat.transcript"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.descendants(matching: .any)["chat.message.message-79"].firstMatch.waitForExistence(timeout: 10))
        // Use one local AX tree per gesture, and remain near the initial image
        // requests instead of doing a fixed number of full-screen flings.
        for step in 0..<5 {
            let snapshot = try readingSnapshot(app)
            if step > 0, snapshot.anchor != nil { break }
            let bounds = snapshot.bounds
            XCTAssertGreaterThan(bounds.height, 150)
            let distance = min(160, bounds.height * 0.3)
            let origin = app.coordinate(withNormalizedOffset: .zero)
            let x = bounds.minX + 8 - snapshot.appFrame.minX
            let y = bounds.midY - distance / 2 - snapshot.appFrame.minY
            origin.withOffset(CGVector(dx: x, dy: y)).press(forDuration: 0.05,
                thenDragTo: origin.withOffset(CGVector(dx: x, dy: y + distance)),
                withVelocity: .slow, thenHoldForDuration: 0)
        }
        let snapshot = try readingSnapshot(app)
        let anchor = try XCTUnwrap(snapshot.anchor, "Expected a real visible reading anchor below the navigation bar")
        XCTAssertGreaterThan(anchor.index, 0)
        XCTAssertTrue(app.buttons["Jump to latest"].exists)
        let held = try await control("state")
        XCTAssertEqual(held["held"] as? Bool, true)
        XCTAssertEqual(held["delivered"] as? [Int], [], "No image response may finish before the reading anchor is established")
        let requested = try XCTUnwrap(held["requested"] as? [Int])
        XCTAssertTrue(requested.contains { $0 % 2 == 0 }, "A landscape image must actually be waiting")
        XCTAssertTrue(requested.contains { $0 % 2 == 1 }, "A portrait image must actually be waiting")
        let start = XCTAttachment(screenshot: app.screenshot()); start.name = "reading-before-held-images-release"; start.lifetime = .keepAlways; add(start)

        _ = try await control("release")
        // Check the images beside this specific anchor, not just any unrelated
        // image from an earlier off-screen row. Adjacent indices have opposite shapes.
        let delivered = try await control("state?waitForImages=\(anchor.index - 1),\(anchor.index)")
        let completed = try XCTUnwrap(delivered["delivered"] as? [Int])
        XCTAssertTrue(completed.contains(anchor.index - 1))
        XCTAssertTrue(completed.contains(anchor.index))
        XCTAssertGreaterThanOrEqual(delivered["portraitDelivered"] as? Int ?? 0, 1)
        XCTAssertGreaterThanOrEqual(delivered["landscapeDelivered"] as? Int ?? 0, 1)
        // The fixture's completion means response bytes were flushed. Give the
        // tiny local PNGs a render pass before measuring the resulting layout.
        try await Task.sleep(for: .seconds(1))
        let restored = app.staticTexts[anchor.label].firstMatch
        XCTAssertTrue(restored.exists)
        XCTAssertEqual(restored.frame.minY, anchor.y, accuracy: 3, "Image completion must not move the reading anchor")
        let finalBounds = try readingSnapshot(app).bounds
        XCTAssertGreaterThanOrEqual(restored.frame.minY, finalBounds.minY - 3)
        XCTAssertLessThanOrEqual(restored.frame.maxY, finalBounds.maxY + 3)
        let finish = XCTAttachment(screenshot: app.screenshot()); finish.name = "reading-after-portrait-and-landscape-delivery"; finish.lifetime = .keepAlways; add(finish)
        XCTAssertTrue(app.buttons["Jump to latest"].exists)
    }
}
