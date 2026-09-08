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
    func testRecentListIsReusedAndForcedRefreshStillWorks() async {
        let (store, app) = setup()
        await store.loadConversations(api: app.api!)
        await store.loadConversations(api: app.api!)
        XCTAssertEqual(HistoryProtocol.paths().count, 1)
        XCTAssertEqual(store.conversationCursor, "next")
        await store.loadConversations(api: app.api!, force: true)
        XCTAssertEqual(HistoryProtocol.paths().count, 2)
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
}

private final class HistoryProtocol: URLProtocol, @unchecked Sendable {
    static let lock = NSLock()
    nonisolated(unsafe) static var requests: [String] = []
    static func reset() { lock.withLock { requests = [] } }
    static func paths() -> [String] { lock.withLock { requests } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        Self.lock.withLock { Self.requests.append(url.absoluteString) }
        let parts = url.pathComponents
        let id = parts.count > 3 ? parts[3] : "a"
        let json: String
        if url.path.hasSuffix("/messages") {
            json = "{\"items\":[{\"id\":\"message-\(id)\",\"seq\":1,\"role\":\"assistant\",\"content\":\"History\"}],\"nextCursor\":null}"
        } else if url.path.hasSuffix("/approvals") {
            json = "{\"items\":[]}"
        } else if url.path.hasSuffix("/conversations") {
            json = "{\"items\":[{\"id\":\"a\",\"title\":\"A\",\"modelId\":\"model-a\"}],\"nextCursor\":\"next\"}"
        } else {
            json = "{\"id\":\"\(id)\",\"modelId\":\"model-\(id)\",\"updatedAt\":1,\"activeRun\":null}"
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + (id == "slow" ? 0.2 : 0)) { [self] in
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(json.utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() {}
}
