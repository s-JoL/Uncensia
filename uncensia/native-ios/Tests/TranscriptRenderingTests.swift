import XCTest
@testable import Uncensia

final class TranscriptRenderingTests: XCTestCase {
    func testInlineMediaKeepsSurroundingProseAndVideo() {
        let blocks = MarkdownBlock.parse("Before ![one](image://img_abc) middle [image image_id=img_def] after\n![clip](video://vid_123)")
        let ids = blocks.compactMap { block -> String? in if case .image(let id, _) = block.kind { return id }; return nil }
        XCTAssertEqual(ids, ["img_abc", "img_def", "vid_123"])
        let prose = blocks.compactMap { block -> String? in if case .prose(let text) = block.kind { return text }; return nil }.joined()
        XCTAssertEqual(prose, "Before  middle  after\n")
    }
    func testCodeExamplesAreNeverRenderedAsMedia() {
        let blocks = MarkdownBlock.parse("`[image image_id=img_test]`\n```md\n![example](image://img_code)\n```\n![real](/v1/images/img_real)")
        XCTAssertEqual(blocks.filter { if case .image = $0.kind { return true }; return false }.count, 1)
        XCTAssertTrue(blocks.contains { if case .code(_, let value) = $0.kind { return value.contains("img_code") }; return false })
    }
    func testTableAfterParagraphPreservesEmptyCellsAndFollowingText() {
        let blocks = MarkdownBlock.parse("Intro\n| A | B | C |\n| --- | :---: | ---: |\n| one | | three |\nAfter")
        XCTAssertEqual(blocks.count, 3)
        guard case .table(let rows) = blocks[1].kind else { return XCTFail("Expected table") }
        XCTAssertEqual(rows, [["A", "B", "C"], ["one", "", "three"]])
    }
    @MainActor func testCitationsStayWithinTheirConversation() {
        let first = TranscriptCitationIndex(), second = TranscriptCitationIndex()
        first.ingest(ChatMessage(.object(["id": .string("tool"), "role": .string("toolResult"), "content": .string("# Search 1: Source\nAnchor: \\ue202turn0search0\nURL: https://example.com/page")]))!)
        XCTAssertTrue(first.render("Answer \u{e202}turn0search0").contains("https://example.com/page"))
        XCTAssertFalse(second.render("Answer \\ue202turn0search0").contains("turn0search0"))
        first.reset()
        first.ingest(ChatMessage(.object(["id": .string("file"), "role": .string("toolResult"), "content": .string("File: Notes (draft)\nAnchor: \\ue202turn0file0 (report.pdf p.2)")]))!)
        XCTAssertTrue(first.render("See \\ue202turn0file0").contains("report.pdf p.2"))
        XCTAssertFalse(first.render("Answer \u{e202}turn0search0").contains("example.com"))
    }
    @MainActor func testSettledMessagesReplacePendingAndDeduplicateEvents() {
        let store = ChatStore()
        store.messages = [ChatMessage(.object(["id": .string("pending-test"), "role": .string("user"), "content": .string("hello")]))!]
        let event = ServerEvent(type: "message.end", data: .object(["messageId": .string("actual"), "message": .object(["role": .string("user"), "content": .string("hello")])]), sequence: 1)
        store.apply(event); store.apply(event)
        XCTAssertEqual(store.messages.map(\.id), ["actual"])
    }
    @MainActor func testSwitchingConversationCancelsPendingDeltas() async throws {
        let store = ChatStore()
        store.apply(ServerEvent(type: "message.delta", data: .object(["assistantMessageEvent": .object(["type": .string("text_delta"), "delta": .string("old conversation")])]), sequence: 1))
        store.clearForConversationSwitch()
        try await Task.sleep(for: .milliseconds(120))
        XCTAssertEqual(store.liveText, "")
        XCTAssertFalse(store.isRunning)
        XCTAssertTrue(store.messages.isEmpty)
    }

}
