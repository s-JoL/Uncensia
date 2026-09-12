import XCTest
@testable import Uncensia

@MainActor final class HistoryLoadingTests: XCTestCase {
    private func setup() -> (ChatStore, AppModel) {
        HistoryProtocol.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HistoryProtocol.self]
        let api = APIClient(server: URL(string: "https://history.test")!, session: URLSession(configuration: configuration))
        return (ChatStore(), AppModel(api: api))
    }
    func testQueuedSendCannotPostThePreviousDraftToANewSelection() async {
        let (store, app) = setup()
        app.selectedConversationID = "a"
        await store.open(id: "a", app: app)
        store.draft = "Only intended for A"
        // The button enqueues a MainActor Task. Selection changes synchronously,
        // while SwiftUI has not yet cleared/restored the displayed draft.
        let queued = Task { await store.send(app: app, fromSeq: 1) }
        app.selectedConversationID = "b"
        let accepted = await queued.value
        XCTAssertFalse(accepted)
        XCTAssertFalse(HistoryProtocol.paths().contains { $0.contains("/runs") }, "No content or edit sequence may reach another conversation")
        XCTAssertEqual(store.draft, "Only intended for A")
        XCTAssertTrue(store.ownsDraft(server: app.api!.server, conversationID: "a"))
        XCTAssertFalse(store.isSending)
        XCTAssertNil(store.error)
    }

    func testUnrestoredDraftCannotStartANewConversation() async {
        let (store, app) = setup()
        store.draft = "Input without a restored owner"
        let accepted = await store.send(app: app)
        XCTAssertFalse(accepted)
        XCTAssertTrue(HistoryProtocol.paths().isEmpty)
        XCTAssertEqual(store.draft, "Input without a restored owner")
        XCTAssertFalse(store.isSending)
    }

    func testLateConversationCreationCannotChangeAnotherServersSelectionOrAttachments() async {
        let (store, app) = setup()
        let api = app.api!
        store.adoptDraft(Draft(text: "For the original server"), server: api.server, conversationID: nil)
        let creation = HistoryResponseGate()
        defer { creation.release() }
        HistoryProtocol.respond("/v1/conversations", json: "{\"id\":\"old-server-chat\",\"modelId\":\"old-model\"}", gate: creation)
        let sending = Task { await store.send(app: app) }
        let requested = await creation.waitUntilRequested()
        XCTAssertTrue(requested)
        guard requested else { return }
        // The old screen's task can outlive that screen. The new server shares
        // AppModel, but must never inherit the old server's returned chat ID.
        app.api = APIClient(server: URL(string: "https://new-server.test")!)
        let newAttachments: [JSONValue] = [.object(["id": .string("new-server-file")])]
        app.pendingAttachments = newAttachments
        creation.release()
        let accepted = await sending.value
        XCTAssertFalse(accepted)
        XCTAssertNil(app.selectedConversationID)
        XCTAssertNil(store.createdConversationID)
        XCTAssertEqual(app.pendingAttachments, newAttachments)
        XCTAssertEqual(store.draft, "For the original server")
        XCTAssertFalse(HistoryProtocol.paths().contains { $0.contains("/runs") })
    }

    func testUnloadedIntermediateConversationCannotOverwriteItsSavedDraft() async {
        let (store, app) = setup()
        let server = app.api!.server
        let saved = Draft(text: "Keep B's exact draft", attachments: [.object(["id": .string("file-b")])])
        await app.drafts.save(saved, server: server, conversationID: "draft-b")
        store.adoptDraft(Draft(text: "Draft A"), server: server, conversationID: "draft-a")
        app.selectedConversationID = "draft-a"

        // A selection can change again before the intermediate open task starts.
        store.clearForConversationSwitch(loading: true)
        app.selectedConversationID = "draft-b"
        XCTAssertNil(store.draftScope)
        await store.saveDraft(app: app)
        store.clearForConversationSwitch(loading: true)
        app.selectedConversationID = "draft-c"
        await store.open(id: "draft-c", app: app)
        let untouched = await app.drafts.load(server: server, conversationID: "draft-b")
        XCTAssertEqual(untouched, saved)
        XCTAssertTrue(store.ownsDraft(server: server, conversationID: "draft-c"))
        XCTAssertFalse(store.ownsDraft(server: URL(string: "https://other.test")!, conversationID: "draft-c"))

        // Selection mismatch is also protected before clear/open gets a turn.
        app.selectedConversationID = "draft-b"
        store.draft = "Still C's input"
        await store.saveDraft(app: app)
        let stillUntouched = await app.drafts.load(server: server, conversationID: "draft-b")
        XCTAssertEqual(stillUntouched, saved)
        await app.drafts.clear(server: server, conversationID: "draft-b")
    }

    func testDraftIsOwnedBeforeSlowHistoryLoadsAndOldOpenCannotReclaimIt() async throws {
        let (store, app) = setup()
        let server = app.api!.server
        await app.drafts.save(Draft(text: "Saved slow draft"), server: server, conversationID: "slow")
        let currentDraft = Draft(text: "Current C draft", attachments: [.object(["id": .string("file-c")])])
        await app.drafts.save(currentDraft, server: server, conversationID: "draft-c")
        app.selectedConversationID = "slow"
        let old = Task { await store.open(id: "slow", app: app) }
        for _ in 0..<50 {
            if HistoryProtocol.paths().contains(where: { $0.contains("/slow/messages") }) { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertTrue(store.isLoading)
        XCTAssertTrue(store.ownsDraft(server: server, conversationID: "slow"))
        XCTAssertEqual(store.draft, "Saved slow draft")
        store.draft = "Updated during history load"
        await store.saveDraft(app: app)
        let updated = await app.drafts.load(server: server, conversationID: "slow")
        XCTAssertEqual(updated.text, "Updated during history load")

        store.clearForConversationSwitch(loading: true)
        app.selectedConversationID = "draft-c"
        await store.open(id: "draft-c", app: app)
        await old.value
        XCTAssertTrue(store.ownsDraft(server: server, conversationID: "draft-c"))
        XCTAssertEqual(store.draft, currentDraft.text)
        XCTAssertEqual(app.pendingAttachments, currentDraft.attachments)
        await app.drafts.clear(server: server, conversationID: "slow")
        await app.drafts.clear(server: server, conversationID: "draft-c")
    }

    func testCreatingConversationMovesDraftOwnershipBeforeSendAcknowledgement() async throws {
        let (store, app) = setup()
        let server = app.api!.server
        store.adoptDraft(Draft(text: "Keep the unsent new question"), server: server, conversationID: nil)
        HistoryProtocol.respond("/v1/conversations", json: "{\"id\":\"draft-created\",\"modelId\":\"model-a\"}")
        HistoryProtocol.respond("/v1/conversations/draft-created/runs", status: 422,
            json: "{\"error\":{\"message\":\"Model unavailable\"}}", delay: 0.2)
        let sending = Task { await store.send(app: app) }
        for _ in 0..<50 {
            if HistoryProtocol.paths().contains(where: { $0.contains("/draft-created/runs") }) { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertTrue(store.isSending)
        XCTAssertEqual(app.selectedConversationID, "draft-created")
        XCTAssertTrue(store.ownsDraft(server: server, conversationID: "draft-created"))
        XCTAssertFalse(store.ownsDraft(server: server, conversationID: nil))
        await store.saveDraft(app: app)
        let saved = await app.drafts.load(server: server, conversationID: "draft-created")
        XCTAssertEqual(saved.text, "Keep the unsent new question")
        let accepted = await sending.value
        XCTAssertFalse(accepted)
        XCTAssertTrue(store.ownsDraft(server: server, conversationID: "draft-created"))
        XCTAssertEqual(store.draft, saved.text)
        await app.drafts.clear(server: server, conversationID: "draft-created")
    }

    func testSendingInExistingConversationPreservesNewConversationDraft() async {
        let (store, app) = setup()
        let api = app.api!
        await app.drafts.save(Draft(text: "Unsent new conversation"), server: api.server, conversationID: nil)
        app.selectedConversationID = "a"
        await store.open(id: "a", app: app)
        store.draft = "Send to existing conversation"
        await store.send(app: app)
        let saved = await app.drafts.load(server: api.server, conversationID: nil)
        XCTAssertEqual(saved.text, "Unsent new conversation")
        await app.drafts.clear(server: api.server, conversationID: nil)
    }
    func testLateCommandCannotAttachOldRunToNewConversation() async throws {
        let (store, app) = setup()
        app.selectedConversationID = "slow"
        await store.open(id: "slow", app: app)
        let command = Task { await store.command("continue", id: "slow", api: app.api!) }
        try await Task.sleep(for: .milliseconds(30))
        store.clearForConversationSwitch()
        app.selectedConversationID = "b"
        await store.open(id: "b", app: app)
        let accepted = await command.value
        XCTAssertFalse(accepted)
        XCTAssertFalse(store.isRunning)
        XCTAssertEqual(store.selectedModelID, "model-b")
        XCTAssertEqual(store.messages.first?.id, "message-b")
    }
    func testRecentListIsReusedAndForcedRefreshStillWorks() async {
        let (store, app) = setup()
        await store.loadConversations(api: app.api!)
        await store.loadConversations(api: app.api!)
        XCTAssertEqual(HistoryProtocol.paths().count, 1)
        XCTAssertEqual(store.conversationCursor, "next")
        await store.loadConversations(api: app.api!, force: true)
        XCTAssertEqual(HistoryProtocol.paths().count, 2)
    }
    func testUnchangedIdleForegroundRefreshDoesNotRedownloadTheLastAnswer() async {
        let (store, app) = setup()
        app.selectedConversationID = "a"
        await store.open(id: "a", app: app)
        let initial = HistoryProtocol.paths().filter { $0.contains("/messages") }.count
        await store.resync(id: "a", api: app.api!)
        await store.resync(id: "a", api: app.api!)
        XCTAssertEqual(HistoryProtocol.paths().filter { $0.contains("/messages") }.count, initial)
        XCTAssertEqual(store.messages.first?.id, "message-a")
    }

    func testEveryTerminalEventImmediatelyReleasesControlsAndKeepsPartialAnswer() {
        for type in ["run.completed", "run.failed", "run.cancelled"] {
            let store = ChatStore()
            store.isRunning = true; store.liveThinking = "Reasoning tail"; store.liveText = "Visible answer tail"
            store.apply(ServerEvent(type: type, data: .object(["message": .string("Provider error")]), sequence: 1))
            XCTAssertFalse(store.isRunning, type)
            XCTAssertTrue(store.messages.last?.text.contains("Visible answer tail") == true, type)
            XCTAssertTrue(store.messages.last?.text.contains("Reasoning tail") == true, type)
            XCTAssertEqual(store.liveText, "")
            if type == "run.failed" { XCTAssertEqual(store.error, "Provider error") }
        }
    }

    func testTerminalReleasesControlsDuringSlowReconciliationAndLateResponseCannotOverwriteNextRun() async throws {
        let (store, app) = setup()
        app.selectedConversationID = "a"
        await store.open(id: "a", app: app)
        HistoryProtocol.respond("/v1/conversations/a/runs", json: "{\"runId\":\"first-run\",\"seq\":0}")
        let firstEvents = """
        event: message.end
        data: {"seq":1,"data":{"messageId":"first-user","message":{"role":"user","content":"First question"}}}

        event: message.delta
        data: {"seq":2,"data":{"assistantMessageEvent":{"type":"thinking_delta","delta":"First reasoning"}}}

        event: message.delta
        data: {"seq":3,"data":{"assistantMessageEvent":{"type":"text_delta","delta":"First answer tail"}}}

        event: run.completed
        data: {"seq":4,"data":{}}


        """
        HistoryProtocol.respond("/v1/runs/first-run/events", json: firstEvents)
        let oldTail = "{\"items\":[{\"id\":\"first-user\",\"seq\":2,\"role\":\"user\",\"content\":\"First question\"},{\"id\":\"first-answer\",\"seq\":3,\"role\":\"assistant\",\"content\":\"First answer tail\"}]}"
        let tailPath = "/v1/conversations/a/messages?after=1"
        HistoryProtocol.respond(tailPath, json: oldTail, delay: 5)
        store.draft = "First question"
        let firstAccepted = await store.send(app: app)
        XCTAssertTrue(firstAccepted)
        for _ in 0..<100 {
            if HistoryProtocol.paths().contains(where: { $0.hasSuffix(tailPath) }) { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertTrue(HistoryProtocol.paths().contains { $0.hasSuffix(tailPath) }, "The first canonical response must actually be in flight")
        XCTAssertFalse(store.isRunning, "A five-second transcript fetch cannot keep Stop enabled")
        XCTAssertTrue(store.messages.contains { $0.text.contains("First answer tail") })

        HistoryProtocol.respond("/v1/conversations/a/runs", json: "{\"runId\":\"second-run\",\"seq\":4}")
        let secondEvents = """
        event: message.end
        data: {"seq":5,"data":{"messageId":"second-user","message":{"role":"user","content":"Second question"}}}

        event: message.delta
        data: {"seq":6,"data":{"assistantMessageEvent":{"type":"text_delta","delta":"Second answer"}}}

        event: run.completed
        data: {"seq":7,"data":{}}


        """
        HistoryProtocol.respond("/v1/runs/second-run/events", json: secondEvents, delay: 6)
        let complete = "{\"items\":[{\"id\":\"first-user\",\"seq\":2,\"role\":\"user\",\"content\":\"First question\"},{\"id\":\"first-answer\",\"seq\":3,\"role\":\"assistant\",\"content\":\"First answer tail\"},{\"id\":\"second-user\",\"seq\":4,\"role\":\"user\",\"content\":\"Second question\"},{\"id\":\"second-answer\",\"seq\":5,\"role\":\"assistant\",\"content\":\"Second answer\"}]}"
        HistoryProtocol.respond(tailPath, json: complete)
        store.draft = "Second question"
        let secondAccepted = await store.send(app: app)
        XCTAssertTrue(secondAccepted)
        XCTAssertTrue(store.isRunning)
        store.draft = "Keep my third draft"
        for _ in 0..<300 {
            if HistoryProtocol.completedResponseAttempts().contains(where: { $0.hasSuffix(tailPath) }) { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertTrue(HistoryProtocol.completedResponseAttempts().contains { $0.hasSuffix(tailPath) })
        XCTAssertTrue(store.isRunning, "The old response must not stop the new run")
        XCTAssertEqual(store.draft, "Keep my third draft")
        XCTAssertTrue(store.messages.contains { $0.text.contains("First answer tail") })
        XCTAssertTrue(store.messages.contains { $0.text == "Second question" })
        for _ in 0..<150 {
            if store.messages.last?.id == "second-answer" { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertFalse(store.isRunning)
        XCTAssertEqual(store.messages.map(\.id), ["message-a", "first-user", "first-answer", "second-user", "second-answer"])
        XCTAssertEqual(store.draft, "Keep my third draft")
        XCTAssertNil(store.error)
        store.clearForConversationSwitch()
    }

    func testForegroundRecoveryBeforeSendAcknowledgementDoesNotDuplicateUser() async throws {
        let (store, app) = setup()
        app.selectedConversationID = "a"
        await store.open(id: "a", app: app)
        HistoryProtocol.respond("/v1/conversations/a/runs", json: "{\"runId\":\"long-run\",\"seq\":1}", delay: 0.25)
        HistoryProtocol.respond("/v1/runs/long-run/events", json: "event: run.completed\ndata: {\"seq\":3,\"data\":{}}\n\n", delay: 0.5)
        store.draft = "Only one question"
        let sending = Task { await store.send(app: app) }
        try await Task.sleep(for: .milliseconds(30))
        HistoryProtocol.respond("/v1/conversations/a", json: "{\"id\":\"a\",\"modelId\":\"model-a\",\"updatedAt\":2,\"activeRun\":{\"id\":\"long-run\",\"resumeSeq\":2}}")
        let recovered = "{\"items\":[{\"id\":\"message-a\",\"seq\":1,\"role\":\"assistant\",\"content\":\"History\"},{\"id\":\"canonical-user\",\"seq\":2,\"role\":\"user\",\"content\":\"Only one question\"}],\"nextCursor\":null}"
        HistoryProtocol.respond("/v1/conversations/a/messages", json: recovered)
        await store.resync(id: "a", api: app.api!)
        let accepted = await sending.value
        XCTAssertTrue(accepted)
        XCTAssertTrue(store.isRunning)
        XCTAssertEqual(store.messages.filter { $0.role == "user" }.map(\.id), ["canonical-user"])
        XCTAssertFalse(store.messages.contains { $0.id.hasPrefix("pending-") })
        // Let the fixture finish its delayed stream before the next test resets it.
        for _ in 0..<50 {
            if !store.isRunning { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        store.clearForConversationSwitch()
    }
    func testCachedTranscriptRevalidatesWithoutDownloadingMessagesAgain() async {
        let (store, app) = setup()
        app.selectedConversationID = "a"
        await store.open(id: "a", app: app)
        XCTAssertEqual(store.selectedModelID, "model-a")
        store.clearForConversationSwitch()
        app.selectedConversationID = "b"
        await store.open(id: "b", app: app)
        XCTAssertEqual(store.selectedModelID, "model-b")
        store.clearForConversationSwitch()
        app.selectedConversationID = "a"
        await store.open(id: "a", app: app)
        XCTAssertEqual(store.messages.first?.id, "message-a")
        XCTAssertEqual(store.selectedModelID, "model-a")
        XCTAssertEqual(HistoryProtocol.paths().filter { $0.contains("/a/messages") }.count, 1)
        XCTAssertTrue(HistoryProtocol.paths().filter { $0.contains("messages") }.allSatisfy { $0.contains("limit=20") })
    }
    func testSlowOldConversationCannotReplaceNewConversationOrItsModel() async throws {
        let (store, app) = setup()
        app.selectedConversationID = "slow"
        let old = Task { await store.open(id: "slow", app: app) }
        try await Task.sleep(for: .milliseconds(30))
        store.clearForConversationSwitch()
        app.selectedConversationID = "b"
        await store.open(id: "b", app: app)
        await old.value
        XCTAssertEqual(store.selectedModelID, "model-b")
        XCTAssertEqual(store.messages.first?.id, "message-b")
    }
    func testConcurrentOlderLoadsDoNotDuplicateRows() async {
        let (store, app) = setup()
        app.selectedConversationID = "a"
        await store.open(id: "a", app: app)
        store.olderCursor = 1
        HistoryProtocol.respond("/v1/conversations/a/messages", json: "{\"items\":[{\"id\":\"older-a\",\"seq\":0,\"role\":\"user\",\"content\":\"Earlier\"},{\"id\":\"message-a\",\"seq\":1,\"role\":\"assistant\",\"content\":\"History\"}],\"nextCursor\":null}", delay: 0.1)
        async let first = store.loadOlder(id: "a", api: app.api!)
        async let duplicate = store.loadOlder(id: "a", api: app.api!)
        let outcomes = await [first, duplicate]
        XCTAssertEqual(outcomes.filter { $0 }.count, 1)
        XCTAssertEqual(store.messages.map(\.id), ["older-a", "message-a"])
        XCTAssertEqual(HistoryProtocol.paths().filter { $0.contains("before=1") }.count, 1)
    }

    func testForegroundRefreshKeepsLoadedHistoryButReplacesChangedBranch() async {
        let (store, app) = setup()
        app.selectedConversationID = "a"
        await store.open(id: "a", app: app)
        let earlier = ChatMessage(.object(["id": .string("earlier"), "seq": .integer(0), "role": .string("user"), "content": .string("Reading anchor")]))!
        store.messages.insert(earlier, at: 0)
        store.olderCursor = 0
        HistoryProtocol.respond("/v1/conversations/a", json: "{\"id\":\"a\",\"modelId\":\"model-a\",\"updatedAt\":2,\"activeRun\":null}")
        await store.resync(id: "a", api: app.api!)
        XCTAssertEqual(store.messages.map(\.id), ["earlier", "message-a"])
        XCTAssertEqual(store.olderCursor, 0)
        HistoryProtocol.respond("/v1/conversations/a", json: "{\"id\":\"a\",\"modelId\":\"model-a\",\"updatedAt\":3,\"activeRun\":null}")
        HistoryProtocol.respond("/v1/conversations/a/messages", json: "{\"items\":[{\"id\":\"branch-b\",\"seq\":0,\"role\":\"assistant\",\"content\":\"Another branch\"}],\"nextCursor\":null}")
        await store.resync(id: "a", api: app.api!)
        XCTAssertEqual(store.messages.map(\.id), ["branch-b"])
        XCTAssertNil(store.olderCursor)
    }

    func testOldRefreshFailureCannotPutErrorIntoNewConversation() async throws {
        let (store, app) = setup()
        app.selectedConversationID = "a"
        await store.open(id: "a", app: app)
        HistoryProtocol.respond("/v1/conversations/a", status: 500, json: "{\"error\":{\"message\":\"Old conversation failed\"}}", delay: 0.15)
        let old = Task { await store.resync(id: "a", api: app.api!) }
        try await Task.sleep(for: .milliseconds(30))
        store.clearForConversationSwitch()
        app.selectedConversationID = "b"
        await store.open(id: "b", app: app)
        await old.value
        XCTAssertNil(store.error)
        XCTAssertEqual(store.messages.first?.id, "message-b")
    }

    func testBackgroundGrowthLargerThanOnePagePreservesHistoryWithoutGaps() async throws {
        let (store, app) = setup()
        app.selectedConversationID = "a"
        await store.open(id: "a", app: app)
        store.messages.insert(ChatMessage(.object(["id": .string("reading-anchor"), "seq": .integer(0), "role": .string("user"), "content": .string("Keep me")]))!, at: 0)
        let tail: [JSONValue] = (1...40).map { seq in .object([
            "id": .string(seq == 1 ? "message-a" : "new-\(seq)"), "seq": .integer(seq),
            "role": .string("assistant"), "content": .string("More background work")
        ]) }
        let response = String(decoding: try JSONEncoder().encode(JSONValue.object(["items": .array(tail)])), as: UTF8.self)
        HistoryProtocol.respond("/v1/conversations/a/messages", json: response)
        HistoryProtocol.respond("/v1/conversations/a", json: "{\"id\":\"a\",\"modelId\":\"model-a\",\"updatedAt\":2,\"activeRun\":null}")
        await store.resync(id: "a", api: app.api!)
        XCTAssertEqual(store.messages.map(\.seq), Array(0...40))
        XCTAssertEqual(store.messages.first?.id, "reading-anchor")
        XCTAssertEqual(HistoryProtocol.paths().filter { $0.contains("after=0") }.count, 1)
    }

    func testSuccessfulEditImmediatelyRemovesAbandonedAnswer() async throws {
        let (store, app) = setup()
        app.selectedConversationID = "a"
        await store.open(id: "a", app: app)
        store.messages = (0...5).map { seq in ChatMessage(.object([
            "id": .string("old-\(seq)"), "seq": .integer(seq), "role": .string(seq % 2 == 0 ? "user" : "assistant"),
            "content": .string("Old branch")
        ]))! }
        let canonical: [JSONValue] = (0...3).map { seq in .object([
            "id": .string("new-\(seq)"), "seq": .integer(seq), "role": .string(seq % 2 == 0 ? "user" : "assistant"),
            "content": .string("Current branch")
        ]) }
        HistoryProtocol.respond("/v1/conversations/a/messages?after=-1", json: String(decoding: try JSONEncoder().encode(JSONValue.object(["items": .array(canonical)])), as: UTF8.self))
        store.draft = "Edited question"
        let accepted = await store.send(app: app, fromSeq: 2)
        XCTAssertTrue(accepted)
        XCTAssertEqual(store.messages.filter { !$0.id.hasPrefix("pending-") }.map(\.seq), [0, 1])
        XCTAssertEqual(store.messages.last?.text, "Edited question")
        for _ in 0..<50 {
            if store.messages.last?.id == "new-3" { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertFalse(store.isRunning)
        XCTAssertEqual(store.messages.map(\.id), ["new-0", "new-1", "new-2", "new-3"], "完成编辑后必须替换整个已加载投影的 ID")
        store.clearForConversationSwitch()
    }

    func testFailedSendReportsFailureAndPreservesDraft() async {
        let (store, app) = setup()
        app.selectedConversationID = "a"
        await store.open(id: "a", app: app)
        store.draft = "Keep editing this"
        HistoryProtocol.respond("/v1/conversations/a/runs", status: 422, json: "{\"error\":{\"message\":\"Unavailable model\"}}")
        let accepted = await store.send(app: app)
        XCTAssertFalse(accepted)
        XCTAssertEqual(store.draft, "Keep editing this")
        XCTAssertFalse(store.isSending)
        XCTAssertEqual(store.error, "Unavailable model")
        XCTAssertFalse(store.messages.contains { $0.id.hasPrefix("pending-") })
    }

    func testSendAppearsBeforeAcknowledgementAndOldCompletionKeepsNewSendBusy() async throws {
        let (store, app) = setup()
        let oldResponse = HistoryResponseGate(), currentResponse = HistoryResponseGate()
        defer { oldResponse.release(); currentResponse.release() }
        app.selectedConversationID = "a"
        await store.open(id: "a", app: app)
        HistoryProtocol.respond("/v1/conversations/a/runs", status: 422, json: "{\"error\":{\"message\":\"A failed\"}}", gate: oldResponse)
        store.draft = "A is sending"
        let old = Task { await store.send(app: app) }
        let oldStarted = await oldResponse.waitUntilRequested()
        XCTAssertTrue(oldStarted, "The old POST must be in flight before navigating")
        guard oldStarted else { return }
        XCTAssertEqual(store.messages.last?.text, "A is sending")
        XCTAssertTrue(store.messages.last?.id.hasPrefix("pending-") == true)
        XCTAssertEqual(store.draft, "A is sending")
        store.clearForConversationSwitch()
        app.selectedConversationID = "b"
        await store.open(id: "b", app: app)
        HistoryProtocol.respond("/v1/conversations/b/runs", status: 422, json: "{\"error\":{\"message\":\"B failed\"}}", gate: currentResponse)
        store.draft = "B is sending"
        let current = Task { await store.send(app: app) }
        // Awaiting an already-finished old Task does not guarantee this new Task
        // has started. Synchronize on B's actual POST, not wall-clock delays.
        let currentStarted = await currentResponse.waitUntilRequested()
        XCTAssertTrue(currentStarted, "The new POST must be in flight before the old response is released")
        guard currentStarted else { return }
        oldResponse.release()
        _ = await old.value
        XCTAssertTrue(store.isSending, "旧请求不能结束新会话的发送忙态")
        XCTAssertNil(store.error)
        XCTAssertEqual(store.messages.last?.text, "B is sending")
        currentResponse.release()
        _ = await current.value
        XCTAssertFalse(store.isSending)
        XCTAssertEqual(store.draft, "B is sending")
        XCTAssertEqual(store.error, "B failed")
    }
}

/// Separates request arrival from response release without blocking a thread.
/// The timeout diagnoses a missing request; it never decides response ordering.
private final class HistoryResponseGate: @unchecked Sendable {
    private let lock = NSLock()
    private var requested = false
    private var released = false
    private var deliveries: [@Sendable () -> Void] = []

    func hold(_ delivery: @escaping @Sendable () -> Void) {
        let deliverNow = lock.withLock {
            requested = true
            if released { return true }
            deliveries.append(delivery)
            return false
        }
        if deliverNow { delivery() }
    }

    func release() {
        let pending = lock.withLock {
            released = true
            let pending = deliveries
            deliveries = []
            return pending
        }
        pending.forEach { $0() }
    }

    func waitUntilRequested() async -> Bool {
        let deadline = ContinuousClock.now + .seconds(5)
        while ContinuousClock.now < deadline {
            if lock.withLock({ requested }) { return true }
            do { try await Task.sleep(for: .milliseconds(10)) } catch { return false }
        }
        return lock.withLock { requested }
    }
}

private final class HistoryProtocol: URLProtocol, @unchecked Sendable {
    static let lock = NSLock()
    nonisolated(unsafe) static var requests: [String] = []
    nonisolated(unsafe) private static var responseAttempts: [String] = []
    private let deliveryLock = NSLock()
    private var stopped = false
    private struct Response: Sendable { let status: Int; let json: String; let delay: Double; let gate: HistoryResponseGate? }
    nonisolated(unsafe) private static var responses: [String: Response] = [:]
    static func reset() { lock.withLock { requests = []; responses = [:]; responseAttempts = [] } }
    static func respond(_ path: String, status: Int = 200, json: String, delay: Double = 0, gate: HistoryResponseGate? = nil) {
        lock.withLock { responses[path] = Response(status: status, json: json, delay: delay, gate: gate) }
    }
    static func paths() -> [String] { lock.withLock { requests } }
    static func completedResponseAttempts() -> [String] { lock.withLock { responseAttempts } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        Self.lock.withLock { Self.requests.append(url.absoluteString) }
        if let response = Self.lock.withLock({ Self.responses[url.path + (url.query.map { "?" + $0 } ?? "")] ?? Self.responses[url.path] }) {
            if let gate = response.gate {
                gate.hold { [self] in deliver(url: url, status: response.status, json: response.json, delay: response.delay) }
            } else {
                deliver(url: url, status: response.status, json: response.json, delay: response.delay)
            }
            return
        }
        let parts = url.pathComponents
        let id = parts.count > 3 ? parts[3] : "a"
        let json: String
        if url.path.hasSuffix("/events") {
            json = "event: run.completed\ndata: {\"seq\":1,\"data\":{}}\n\n"
        } else if url.path.hasSuffix("/runs") {
            json = "{\"runId\":\"test-run\",\"seq\":0}"
        } else if url.path.hasSuffix("/continue") {
            json = "{\"runId\":\"old-run\",\"seq\":0}"
        } else if url.path.hasSuffix("/messages") {
            json = "{\"items\":[{\"id\":\"message-\(id)\",\"seq\":1,\"role\":\"assistant\",\"content\":\"History\"}],\"nextCursor\":null}"
        } else if url.path.hasSuffix("/approvals") {
            json = "{\"items\":[]}"
        } else if url.path.hasSuffix("/conversations") {
            json = "{\"items\":[{\"id\":\"a\",\"title\":\"A\",\"modelId\":\"model-a\"}],\"nextCursor\":\"next\"}"
        } else {
            json = "{\"id\":\"\(id)\",\"modelId\":\"model-\(id)\",\"updatedAt\":1,\"activeRun\":null}"
        }
        deliver(url: url, status: 200, json: json, delay: id == "slow" ? 0.2 : 0)
    }
    private func deliver(url: URL, status: Int, json: String, delay: Double) {
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [self] in
            Self.lock.withLock { Self.responseAttempts.append(url.absoluteString) }
            guard !deliveryLock.withLock({ stopped }) else { return }
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(json.utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() { deliveryLock.withLock { stopped = true } }
}
