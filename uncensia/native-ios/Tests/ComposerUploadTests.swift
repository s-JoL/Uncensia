import XCTest
@testable import Uncensia

final class ComposerUploadTests: XCTestCase {
    func testLeavingAnUploadingDraftAllowsOtherDraftsAndReturningRestoresItsRemainingWork() {
        let server = URL(string: "https://example.test")!
        var tracker = ComposerUploadTracker()
        let original = tracker.begin(server: server, conversationID: "a", count: 3)

        XCTAssertEqual(tracker.count(server: server, conversationID: "a"), 3)
        XCTAssertEqual(tracker.count(server: server, conversationID: "b"), 0,
                       "A slow upload in another conversation must not disable Send here")
        XCTAssertEqual(tracker.count(server: server, conversationID: nil), 0)

        let next = tracker.begin(server: server, conversationID: "b", count: 1)
        tracker.finish(original[1])
        tracker.finish(original[0])
        XCTAssertEqual(tracker.count(server: server, conversationID: "b"), 1)
        XCTAssertEqual(tracker.count(server: server, conversationID: "a"), 1,
                       "Returning before completion must still display the original upload")
        tracker.finish(next[0])
        XCTAssertEqual(tracker.count(server: server, conversationID: "b"), 0)
        tracker.finish(original[2])
        XCTAssertEqual(tracker.count(server: server, conversationID: "a"), 0)
    }

    func testLateCompletionCannotDecrementAnotherOperationOrCrossServers() {
        let first = URL(string: "https://first.example.test")!
        let second = URL(string: "https://second.example.test")!
        var tracker = ComposerUploadTracker()
        let old = tracker.begin(server: first, conversationID: nil, count: 1)[0]
        let newer = tracker.begin(server: first, conversationID: nil, count: 1)[0]
        let otherServer = tracker.begin(server: second, conversationID: nil, count: 1)[0]
        tracker.finish(old)
        tracker.finish(old)
        XCTAssertEqual(tracker.count(server: first, conversationID: nil), 1)
        XCTAssertEqual(tracker.count(server: second, conversationID: nil), 1)
        tracker.finish(newer)
        XCTAssertEqual(tracker.count(server: second, conversationID: nil), 1)
        tracker.finish(otherServer)
        XCTAssertEqual(tracker.count(server: second, conversationID: nil), 0)
    }

    func testCompletionSurvivesRestoringAnAlreadyReadDraftSnapshot() async throws {
        let name = "upload-restore-\(UUID().uuidString)"
        defer { UserDefaults(suiteName: name)?.removePersistentDomain(forName: name) }
        let drafts = DraftStore(defaults: try XCTUnwrap(UserDefaults(suiteName: name)))
        let server = URL(string: "https://example.test")!
        let original = JSONValue.object(["id": .string("original")])
        let uploaded = JSONValue.object(["id": .string("uploaded-while-restoring")])
        await drafts.save(Draft(text: "Exact unsent text", attachments: [original]), server: server, conversationID: "a")
        // open() has read this value, but has not yet adopted it on MainActor.
        let alreadyRead = await drafts.load(server: server, conversationID: "a")
        var tracker = ComposerUploadTracker()
        tracker.stage(uploaded, server: server, conversationID: "a")
        tracker.stage(uploaded, server: server, conversationID: "a")
        await drafts.appendAttachment(uploaded, server: server, conversationID: "a")

        var visible = alreadyRead
        let ready = tracker.takeCompleted(server: server, conversationID: "a")
        XCTAssertEqual(ready, [uploaded], "Even if disk already contains it, the older restoration still needs this completion")
        for attachment in ready where !visible.attachments.contains(attachment) {
            visible.attachments.append(attachment)
        }
        await drafts.save(visible, server: server, conversationID: "a")
        let savedAgain = await drafts.load(server: server, conversationID: "a")
        XCTAssertEqual(savedAgain.text, "Exact unsent text")
        XCTAssertEqual(savedAgain.attachments, [original, uploaded])
        XCTAssertTrue(tracker.takeCompleted(server: server, conversationID: "a").isEmpty,
                      "Repeated restore notifications cannot replay a consumed completion")
    }

    func testStagedCompletionsStayIsolatedFromOtherDraftsAndInFlightCounts() {
        let server = URL(string: "https://first.example.test")!
        let otherServer = URL(string: "https://second.example.test")!
        let a = JSONValue.object(["id": .string("a-upload")])
        let b = JSONValue.object(["id": .string("b-upload")])
        let remote = JSONValue.object(["id": .string("other-server-upload")])
        var tracker = ComposerUploadTracker()
        let ticket = tracker.begin(server: server, conversationID: "a", count: 1)[0]
        tracker.stage(a, server: server, conversationID: "a")
        tracker.stage(b, server: server, conversationID: nil)
        tracker.stage(remote, server: otherServer, conversationID: "a")
        tracker.finish(ticket)
        XCTAssertEqual(tracker.count(server: server, conversationID: "a"), 0)
        XCTAssertTrue(tracker.takeCompleted(server: server, conversationID: "b").isEmpty)
        XCTAssertEqual(tracker.takeCompleted(server: server, conversationID: "a"), [a],
                       "Finishing network work must not drop an unconsumed draft completion")
        XCTAssertEqual(tracker.takeCompleted(server: server, conversationID: nil), [b])
        XCTAssertEqual(tracker.takeCompleted(server: otherServer, conversationID: "a"), [remote])
    }
}
