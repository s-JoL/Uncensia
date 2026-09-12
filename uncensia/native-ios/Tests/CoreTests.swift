import XCTest
@testable import Uncensia

final class CoreTests: XCTestCase {
    func testJSONValueRoundTripAndMissingSubscript() throws {
        let value: JSONValue = .object(["name": .string("Uncensia"), "items": .array([.number(2), .bool(true), .null])])
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value)), value)
        XCTAssertEqual(value["missing"], .null)
    }
    func testSSEParserRetainsSplitUTF8AndFrames() throws {
        let wire = "event: message.delta\ndata: {\"seq\":7,\"data\":{\"text\":\"你\"}}\n\n"
        let data = Data(wire.utf8), split = data.count - 4
        var parser = SSEParser()
        XCTAssertTrue(try parser.append(data[..<split]).isEmpty)
        let events = try parser.append(data[split...])
        XCTAssertEqual(events, [ServerEvent(type: "message.delta", data: .object(["text": .string("你")]), sequence: 7)])
    }
    func testSSEParserUsesEarliestMixedDelimiterAndPreservesEmptyDataLine() throws {
        var parser = SSEParser()
        let wire = "event: first\r\ndata: {\"seq\":1,\"data\":{}}\r\n\r\nevent: second\ndata:\ndata: {\"seq\":2,\"data\":{\"ok\":true}}\n\n"
        let events = try parser.append(Data(wire.utf8))
        XCTAssertEqual(events.map(\.type), ["first", "second"])
        XCTAssertEqual(events.map(\.sequence), [1, 2])
    }
    func testLargeSSEFramesKeepSplitDelimitersAndFollowingEvents() throws {
        let body = String(repeating: "长工具结果", count: 8_000)
        let wire = Data(("event: tool.execution.end\r\ndata: {\"seq\":1,\"data\":{\"text\":\"\(body)\"}}\r\n\r\n" +
            "event: run.completed\ndata: {\"seq\":2,\"data\":{}}\n\n").utf8)
        for chunkSize in [127, 4096] {
            var parser = SSEParser(), events: [ServerEvent] = []
            for start in stride(from: 0, to: wire.count, by: chunkSize) {
                events += try parser.append(wire[start..<min(wire.count, start + chunkSize)])
            }
            XCTAssertEqual(events.map(\.sequence), [1, 2])
            XCTAssertEqual(events.first?.data["text"].stringValue, body)
        }
    }

    func testStreamBatchingKeepsEveryDeltaBeforeControlEvents() async throws {
        let stream = AsyncThrowingStream<[ServerEvent], Error>.makeStream()
        let batcher = RunEventBatcher(continuation: stream.continuation)
        let events = (1...130).map { sequence in
            ServerEvent(type: "message.delta", data: .object(["assistantMessageEvent": .object([
                "type": .string(sequence % 2 == 0 ? "thinking_delta" : "text_delta"), "delta": .string("\(sequence)")
            ])]), sequence: sequence)
        }
        let started = ServerEvent(type: "run.started", data: .null, sequence: 0)
        await batcher.append(started)
        for event in events { await batcher.append(event) }
        let terminal = ServerEvent(type: "run.cancelled", data: .null, sequence: 131)
        await batcher.append(terminal)
        await batcher.finish()
        var batches: [[ServerEvent]] = []
        for try await batch in stream.stream { batches.append(batch) }
        XCTAssertEqual(batches.flatMap { $0 }, [started] + events + [terminal], "停止不能丢失合批中的正文或思考")
        XCTAssertEqual(batches.dropFirst().first, [events[0]], "首个增量无需等待合批周期")
        XCTAssertTrue(batches.allSatisfy { $0.count <= 64 })
        XCTAssertLessThan(batches.count, events.count)
    }

    func testStreamBatchingFlushesWhenNoNextTokenArrives() async throws {
        let stream = AsyncThrowingStream<[ServerEvent], Error>.makeStream()
        let batcher = RunEventBatcher(continuation: stream.continuation)
        var iterator = stream.stream.makeAsyncIterator()
        let first = ServerEvent(type: "message.delta", data: .object(["assistantMessageEvent": .object([
            "type": .string("text_delta"), "delta": .string("first")
        ])]), sequence: 1)
        let last = ServerEvent(type: first.type, data: first.data, sequence: 2)
        await batcher.append(first)
        let immediate = try await iterator.next()
        XCTAssertEqual(immediate, [first])
        await batcher.append(last)
        let timeout = Task {
            do { try await Task.sleep(for: .seconds(2)) } catch { return }
            stream.continuation.finish(throwing: APIError(status: 0, code: "missing_flush", message: "No trailing delta"))
        }
        defer { timeout.cancel() }
        let trailing = try await iterator.next()
        timeout.cancel()
        XCTAssertEqual(trailing, [last])
        await batcher.finish(throwing: APIError(status: 0, code: "test_failure", message: "Interrupted"))
        do { _ = try await iterator.next(); XCTFail("The stream error must reach its consumer") }
        catch let error as APIError { XCTAssertEqual(error.code, "test_failure") }
    }

    @MainActor func testReplayedMessageEndClearsLiveTailWithoutLosingCanonicalMetadata() {
        let store = ChatStore()
        let canonical = ChatMessage(.object([
            "id": .string("persisted"), "seq": .integer(42), "role": .string("assistant"),
            "content": .object(["role": .string("assistant"), "content": .array([
                .object(["type": .string("text"), "text": .string("answer")])
            ]), "stopReason": .string("stop")]), "createdAt": .integer(900)
        ]))!
        store.messages = [canonical]
        store.liveText = "answer"; store.liveThinking = "reasoning"; store.liveStatus = "old status"
        store.apply(ServerEvent(type: "message.end", data: .object([
            "messageId": .string("persisted"), "message": .object(["role": .string("assistant"), "content": .string("answer")])
        ]), sequence: 90))
        XCTAssertEqual(store.messages, [canonical])
        XCTAssertEqual(store.liveText, "")
        XCTAssertEqual(store.liveThinking, "")
        XCTAssertEqual(store.liveStatus, "")
    }
    func testAPIURLNormalizesV1AndKeepsEncodedQuery() throws {
        let cases: [(String, String, String)] = [
            ("https://example.test", "/files/search?q=%E4%BD%A0%20%E5%A5%BD", "https://example.test/v1/files/search?q=%E4%BD%A0%20%E5%A5%BD"),
            ("https://example.test/v1/", "/v1/health", "https://example.test/v1/health"),
            ("https://example.test/prefix/v1", "conversations?after=-1", "https://example.test/prefix/v1/conversations?after=-1")
        ]
        for (base, path, expected) in cases {
            let request = try APIClient(server: URL(string: base)!).urlRequest("GET", path)
            XCTAssertEqual(request.url?.absoluteString, expected)
        }
    }
    func testDraftsAreIsolatedByServerAndConversation() async {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let store = DraftStore(defaults: suite), one = URL(string: "https://one.example")!, two = URL(string: "https://two.example")!
        await store.save(Draft(text: "private"), server: one, conversationID: "a")
        let matching = await store.load(server: one, conversationID: "a")
        let otherServer = await store.load(server: two, conversationID: "a")
        let otherConversation = await store.load(server: one, conversationID: "b")
        XCTAssertEqual(matching.text, "private")
        XCTAssertEqual(otherServer.text, "")
        XCTAssertEqual(otherConversation.text, "")
    }
    func testNewAndExistingConversationDraftsKeepIndependentAttachments() async {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let store = DraftStore(defaults: suite), server = URL(string: "https://drafts.example/v1")!
        let newAttachment: JSONValue = .object(["file": .object(["id": .string("img_new")]), "role": .string("base")])
        let oldAttachment: JSONValue = .object(["file": .object(["id": .string("img_old")]), "role": .string("style")])
        await store.save(Draft(text: "新对话草稿", attachments: [newAttachment]), server: server, conversationID: nil)
        await store.save(Draft(text: "已有对话草稿", attachments: [oldAttachment]), server: server, conversationID: "conversation-a")
        let restoredNew = await store.load(server: server, conversationID: nil)
        let restoredOld = await store.load(server: server, conversationID: "conversation-a")
        XCTAssertEqual(restoredNew.attachments, [newAttachment])
        XCTAssertEqual(restoredOld.attachments, [oldAttachment])
        await store.clear(server: server, conversationID: "conversation-a")
        let newAfterClear = await store.load(server: server, conversationID: nil)
        XCTAssertEqual(newAfterClear.attachments, [newAttachment], "清理已发送会话不得覆盖新对话附件")
    }
    func testConcurrentTokenRotationNeverDeletesTheCurrentCredential() async throws {
        let vault = CredentialVault(), server = URL(string: "https://rotation-\(UUID().uuidString).test")!
        try vault.setToken("initial", for: server)
        defer { try? vault.removeToken(for: server) }
        try await withThrowingTaskGroup(of: Void.self) { group in
            for index in 0..<24 {
                group.addTask {
                    try vault.setToken("token-\(index)", for: server)
                    XCTAssertNotNil(vault.token(for: server))
                }
            }
            try await group.waitForAll()
        }
        XCTAssertTrue(vault.token(for: server)?.hasPrefix("token-") == true)
    }
    func testOnlySafeRequestsRetryTransientFailures() {
        let outage = APIError(status: 502, code: "gateway", message: "Bad gateway")
        XCTAssertTrue(APIClient.canRetry(method: "GET", headers: [:], error: outage))
        XCTAssertTrue(APIClient.canRetry(method: "POST", headers: ["Idempotency-Key": "same-run"], error: outage))
        XCTAssertFalse(APIClient.canRetry(method: "POST", headers: [:], error: outage))
        XCTAssertFalse(APIClient.canRetry(method: "GET", headers: [:], error: APIError(status: 401, code: "auth", message: "Unauthorized")))
        XCTAssertFalse(APIClient.canRetry(method: "GET", headers: [:], error: URLError(.cancelled)))
    }

    func testGatewayRetryReusesTheSameIdempotencyKey() async throws {
        RetryURLProtocol.reset()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RetryURLProtocol.self]
        let api = APIClient(server: URL(string: "https://retry.test")!, session: URLSession(configuration: config))
        let result = try await api.request("POST", "/conversations/test/runs", body: .object(["text": .string("once")]), headers: ["Idempotency-Key": "original-key"])
        XCTAssertEqual(result["runId"].stringValue, "one-run")
        let requests = RetryURLProtocol.recorded()
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests.map { $0.value(forHTTPHeaderField: "Idempotency-Key") }, ["original-key", "original-key"])
        RetryURLProtocol.reset()
        do {
            _ = try await api.request("POST", "/conversations", body: .object([:]))
            XCTFail("An ordinary mutation must not retry a 502")
        } catch let error as APIError { XCTAssertEqual(error.status, 502) }
        XCTAssertEqual(RetryURLProtocol.recorded().count, 1)
    }

}

private final class RetryURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var requests: [URLRequest] = []
    static func reset() { lock.withLock { requests = [] } }
    static func recorded() -> [URLRequest] { lock.withLock { requests } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let count = Self.lock.withLock { Self.requests.append(request); return Self.requests.count }
        let status = count == 1 ? 502 : 200
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data((status == 200 ? "{\"runId\":\"one-run\"}" : "{}").utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
