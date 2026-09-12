import XCTest
@testable import Uncensia

final class DraftHandoffTests: XCTestCase {
    func testConcurrentUploadCompletionsPreserveEveryAttachmentAndText() async throws {
        let name = "draft-upload-\(UUID().uuidString)"
        defer { UserDefaults(suiteName: name)?.removePersistentDomain(forName: name) }
        let drafts = DraftStore(defaults: try XCTUnwrap(UserDefaults(suiteName: name)))
        let server = URL(string: "https://example.test")!
        await drafts.save(Draft(text: "Original draft"), server: server, conversationID: "a")
        await withTaskGroup(of: Void.self) { group in
            for index in 0..<30 {
                group.addTask {
                    await drafts.appendAttachment(.object(["id": .string("file-\(index)")]), server: server, conversationID: "a")
                }
            }
        }
        let saved = await drafts.load(server: server, conversationID: "a")
        XCTAssertEqual(saved.text, "Original draft")
        XCTAssertEqual(Set(saved.attachments.compactMap { $0["id"].stringValue }).count, 30)
        let unrelated = await drafts.load(server: server, conversationID: "b")
        XCTAssertEqual(unrelated, Draft())
    }

    @MainActor func testLibraryHandoffLeavesOldAttachmentsUntouchedUntilNewDraftIsReady() {
        let server = URL(string: "https://handoff.example.test")!
        let app = AppModel(api: APIClient(server: server, token: { nil }))
        app.selectedConversationID = "old"
        let old = JSONValue.object(["id": .string("old-file")])
        let incoming = JSONValue.object(["id": .string("new-file")])
        app.pendingAttachments = [old]
        app.startNewChat(attachments: [incoming])
        XCTAssertNil(app.selectedConversationID)
        XCTAssertEqual(app.pendingAttachments, [old], "The old draft must be saved before consuming the incoming item")
        let handoff = app.chatHandoff!
        app.pendingAttachments = []
        app.consumeChatHandoff(handoff.id)
        XCTAssertEqual(app.pendingAttachments, [incoming])
        app.consumeChatHandoff(handoff.id)
        XCTAssertEqual(app.pendingAttachments, [incoming], "Consumption is idempotent")
    }

    @MainActor func testStaleHandoffCannotConsumeANewerRequestOrAttachToAnotherConversation() {
        let app = AppModel(api: APIClient(server: URL(string: "https://handoff.example.test")!, token: { nil }))
        app.startNewChat(attachments: [.object(["id": .string("first")])])
        let oldID = app.chatHandoff!.id
        app.startNewChat(attachments: [.object(["id": .string("second")])])
        app.consumeChatHandoff(oldID)
        XCTAssertTrue(app.pendingAttachments.isEmpty)
        let id = app.chatHandoff!.id
        app.selectedConversationID = "other"
        app.consumeChatHandoff(id)
        XCTAssertTrue(app.pendingAttachments.isEmpty)
        app.selectedConversationID = nil
        app.consumeChatHandoff(id)
        XCTAssertEqual(app.pendingAttachments.first?["id"].stringValue, "second")
    }
}
