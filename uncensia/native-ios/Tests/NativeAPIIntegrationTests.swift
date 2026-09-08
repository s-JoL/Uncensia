import XCTest
@testable import Uncensia

final class NativeAPIIntegrationTests: XCTestCase {
    private func fixture() async throws -> APIClient {
        let environment = ProcessInfo.processInfo.environment
        guard environment["UNCENSIA_IOS_FIXTURE"] == "1" else { throw XCTSkip("Set UNCENSIA_IOS_FIXTURE=1 to run the real HTTP protocol test") }
        let server = URL(string: environment["UNCENSIA_SERVER_URL"] ?? "http://127.0.0.1:18093")!
        let anonymous = APIClient(server: server)
        let login = try await anonymous.request("POST", "/auth/token", body: .object([
            "accessCode": .string(environment["UNCENSIA_ACCESS_CODE"] ?? "IOS-CI-ACCEPTANCE"),
            "deviceName": .string("Swift integration tests")
        ]))
        guard let token = login["token"].stringValue else { throw XCTSkip("iOS fixture is unavailable") }
        return APIClient(server: server, token: { token })
    }

    func testRealStreamArrivesBeforeCompletionAndIdempotentRetryDoesNotDuplicate() async throws {
        executionTimeAllowance = 45
        let api: APIClient
        api = try await fixture()
        let created = try await api.request("POST", "/conversations", body: .object(["modelId": .string("ios-ci-stub-chat")]))
        let id = try XCTUnwrap(created["id"].stringValue)
        do {
            let key = "swift-retry-\(UUID().uuidString)"
            let payload: JSONValue = .object(["text": .string("写 2000 字分布式系统一致性测试"), "attachments": .array([])])
            let first = try await api.request("POST", "/conversations/\(id)/runs", body: payload, headers: ["Idempotency-Key": key])
            let retry = try await api.request("POST", "/conversations/\(id)/runs", body: payload, headers: ["Idempotency-Key": key])
            XCTAssertEqual(first["runId"].stringValue, retry["runId"].stringValue)

            let started = ContinuousClock.now
            var firstDelta: Duration?
            var terminal: Duration?
            var sequences = Set<Int>()
            for try await event in await RunFollower(api: api).follow(runID: try XCTUnwrap(first["runId"].stringValue), after: first["seq"].intValue ?? 0) {
                XCTAssertTrue(sequences.insert(event.sequence).inserted, "恢复流不得重复派发事件")
                if event.type == "message.delta", firstDelta == nil { firstDelta = started.duration(to: .now) }
                if ["run.completed", "run.failed", "run.cancelled"].contains(event.type) { terminal = started.duration(to: .now) }
            }
            XCTAssertNotNil(firstDelta)
            XCTAssertNotNil(terminal)
            if let firstDelta, let terminal { XCTAssertLessThan(firstDelta, terminal, "首个 SSE 增量必须在流结束前交付") }

            let log = try await api.request("GET", "/conversations/\(id)/messages?after=-1")
            let prompts = (log["items"].arrayValue ?? []).filter { $0["role"].stringValue == "user" && ChatMessage($0)?.text == "写 2000 字分布式系统一致性测试" }
            XCTAssertEqual(prompts.count, 1, "丢失 run ack 后使用同一幂等键不得重复创建用户轮次")

            let cursor = sequences.max() ?? (first["seq"].intValue ?? 0)
            let replay = try await api.request("GET", "/runs/\(first["runId"].stringValue!)/events?after=\(cursor)&mode=poll")
            XCTAssertTrue(replay["events"].arrayValue?.isEmpty ?? true, "游标后的 poll 不得重放已消费事件")
            XCTAssertEqual(replay["done"].boolValue, true)
        } catch {
            _ = try? await api.request("DELETE", "/conversations/\(id)")
            throw error
        }
        _ = try await api.request("DELETE", "/conversations/\(id)")
    }
}
