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
}
