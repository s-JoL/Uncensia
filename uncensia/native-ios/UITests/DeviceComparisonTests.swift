import XCTest

/// Explicit, device-only visual evidence. Does not send prompts or change chats.
@MainActor final class DeviceComparisonTests: XCTestCase {
    func testCaptureInstalledChatGPTAndUncensiaReferenceScreens() throws {
        guard ProcessInfo.processInfo.environment["UNCENSIA_DEVICE_COMPARISON"] == "1" else {
            throw XCTSkip("Opt in on a physical iPhone with ChatGPT installed")
        }
        for (id, name) in [("com.openai.chat", "ChatGPT-reference"), ("app.uncensia.native", "Uncensia-device")] {
            let app = XCUIApplication(bundleIdentifier: id)
            app.launch()
            XCTAssertTrue(app.wait(for: .runningForeground, timeout: 20))
            let image = XCTAttachment(screenshot: app.screenshot())
            image.name = name; image.lifetime = .keepAlways; add(image)
            let hierarchy = XCTAttachment(string: app.debugDescription)
            hierarchy.name = name + "-accessibility"; hierarchy.lifetime = .keepAlways; add(hierarchy)
        }
    }
}
