import XCTest
import UIKit
@testable import Uncensia

final class TranscriptRenderingTests: XCTestCase {
    func testLongFenceKeepsShorterFenceAndMediaLiteral() {
        let blocks = MarkdownBlock.parse("````markdown\n```\n![example](image://img_code)\n```\n````\n![real](image://img_real)")
        guard case .code(let language, let code) = blocks.first?.kind else { return XCTFail("Expected fenced code") }
        XCTAssertEqual(language, "markdown")
        XCTAssertEqual(code, "```\n![example](image://img_code)\n```")
        XCTAssertEqual(blocks.filter { if case .image = $0.kind { return true }; return false }.count, 1)
    }
    func testEscapedAndCodePipesStayInsideTheirTableCells() {
        let blocks = MarkdownBlock.parse("| A | B | C |\n| --- | --- | --- |\n| a\\|b | `x|y` | |\n| short |\n\nAfter")
        guard case .table(let rows) = blocks.first?.kind else { return XCTFail("Expected table") }
        XCTAssertEqual(rows, [["A", "B", "C"], ["a\\|b", "`x|y`", ""], ["short", "", ""]])
    }
    func testTableSeparatorMustMatchHeaderColumnCount() {
        XCTAssertFalse(MarkdownBlock.parse("A | B\n---\nAfter").contains { if case .table = $0.kind { return true }; return false })
    }
    func testQuoteEmbeddingPreservesSurroundingTextAndCodeExamples() {
        let id = "quote_0123456789abcdef0123456789abcdef"
        let blocks = MarkdownBlock.parse("Before [原文](excerpt://\(id)) after\n\n``[原文](excerpt://\(id))``")
        XCTAssertEqual(blocks.filter { if case .quote = $0.kind { return true }; return false }.count, 1)
        let prose = blocks.compactMap { if case .prose(let value) = $0.kind { return value }; return nil }.joined()
        XCTAssertTrue(prose.hasPrefix("Before  after"))
        XCTAssertTrue(prose.contains("``[原文](excerpt://"))
    }
    func testIncrementalParsingMatchesEveryFullParseIncludingBlockTransitions() async throws {
        let samples = [
            "第一段。\n\n第二段 **加粗**。\n\n````md\n```\n![literal](image://img_code)\n```\n````\n结尾",
            "Intro\r\n\r\n```swift\r\nlet x = 1\r\n```\r\nAfter",
            "| A | B |\n| --- | --- |\n| `a|b` | a\\|b |\n\nLast",
            "Intro\n\\[\n\\frac{1}{2}\n\\]\nAfter\n\n$$x^2$$\nEnd"
        ]
        for sample in samples {
            let parser = StreamingMarkdownParser()
            var source = ""
            for character in sample {
                source.append(character)
                let parsed = try await parser.parse(source)
                XCTAssertEqual(parsed, MarkdownBlock.parse(source), "Prefix: \(source)")
            }
        }
    }
    func testIncrementalParsingSkipsCompletedLongHistoryAndHandlesCorrection() async throws {
        let parser = StreamingMarkdownParser()
        let completed = String(repeating: "一段已经完成的文字。\n\n", count: 5000)
        _ = try await parser.parse(completed)
        let grown = try await parser.parse(completed + "正在生成")
        let scanned = await parser.lastScannedBytes
        XCTAssertEqual(scanned, "正在生成".utf8.count)
        XCTAssertEqual(grown, MarkdownBlock.parse(completed + "正在生成"))
        let corrected = try await parser.parse("修正开头\n\n新的答案")
        XCTAssertEqual(corrected, MarkdownBlock.parse("修正开头\n\n新的答案"))
    }
    func testStreamingTailKeepsPartialDestinationsAndMarkupOffscreen() {
        XCTAssertEqual(MarkdownStreamingTail.prepare("See [the source](https://exam"), "See the source")
        XCTAssertEqual(MarkdownStreamingTail.prepare("Before ![a picture](image://img_a"), "Before ")
        XCTAssertEqual(MarkdownStreamingTail.prepare("Answer **strong"), "Answer **strong**")
        XCTAssertEqual(MarkdownStreamingTail.prepare("`[literal](unfinished`"), "`[literal](unfinished`")
        XCTAssertEqual(MarkdownStreamingTail.prepare("Formula \\(\\frac{"), "Formula ")
    }
    func testMathRecognizesLatexAndKeepsCurrencyAndCodeLiteral() {
        let spans = MarkdownMathSource.spans("Use $x^2$ and \\(\\frac{1}{2}\\); costs $5 to $10; `$literal$`.")
        XCTAssertEqual(spans.filter { if case .math = $0 { return true }; return false }.count, 2)
        XCTAssertTrue(spans.contains { if case .text(let value) = $0 { return value.contains("$5 to $10") && value.contains("`$literal$`") }; return false })
        XCTAssertEqual(MarkdownBlock.parse("$$\\frac{1}{2}$$").first?.kind, .math("\\frac{1}{2}", closed: true))
        XCTAssertEqual(MarkdownBlock.parse("\\[\\frac{").first?.kind, .math("\\frac{", closed: false))
        XCTAssertFalse(MarkdownBlock.parse("```tex\n$$x^2$$\n```").contains { if case .math = $0.kind { return true }; return false })
    }
    func testMathNeverRewritesLinkDestinationsOrAutolinks() {
        let examples = [
            "[source](https://example.org/$x$/page)",
            "![image](https://example.org/figure($x$).png)",
            "[source](../data/\\(original\\)/$x$/page)",
            "<https://example.org/$x$/page>",
            "https://example.org/$x$/page",
            "[source](https://example.org/$x$/unfinished"
        ]
        for source in examples { XCTAssertEqual(MarkdownMathSource.spans(source), [.text(source)]) }
        let mixed = MarkdownMathSource.spans("See $x^2$ at [source](https://example.org/$x$/page).")
        XCTAssertEqual(mixed.filter { if case .math = $0 { return true }; return false }.count, 1)
        XCTAssertTrue(mixed.contains { if case .text(let value) = $0 { return value.contains("https://example.org/$x$/page") }; return false })
    }
    @MainActor func testNativeMathTypesetsFractionsAndCachesByAppearance() {
        let first = NativeMathCache.render("\\frac{1}{2}", display: true, fontSize: 20, dark: false, scale: 2)
        XCTAssertNotNil(first)
        XCTAssertGreaterThan(first?.image.size.height ?? 0, 20)
        XCTAssertTrue(first === NativeMathCache.render("\\frac{1}{2}", display: true, fontSize: 20, dark: false, scale: 2))
        XCTAssertFalse(first === NativeMathCache.render("\\frac{1}{2}", display: true, fontSize: 24, dark: true, scale: 3))
        XCTAssertNil(NativeMathCache.render("\\definitelyUnsupportedCommand", display: true, fontSize: 20, dark: false, scale: 2))
        if let first { let attachment = XCTAttachment(image: first.image); attachment.name = "Native fraction rendering"; attachment.lifetime = .keepAlways; add(attachment) }
    }
    @MainActor func testNativeMathKeepsNumeratorAboveDenominator() throws {
        // An asymmetric fraction detects the vertically flipped bitmap that a
        // nonempty-image assertion misses. Its denominator has much more ink.
        let rendered = try XCTUnwrap(NativeMathCache.render("\\frac{1}{88888888}", display: true, fontSize: 24, dark: false, scale: 2))
        func inkHalves(_ image: UIImage) throws -> (first: Int, second: Int) {
            let source = try XCTUnwrap(image.cgImage)
            let width = source.width, height = source.height
            var pixels = [UInt8](repeating: 0, count: width * height * 4)
            try pixels.withUnsafeMutableBytes { bytes in
                let context = try XCTUnwrap(CGContext(data: bytes.baseAddress, width: width, height: height,
                    bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue))
                context.draw(source, in: CGRect(x: 0, y: 0, width: width, height: height))
            }
            var first = 0, second = 0
            for y in 0..<height {
                for x in 0..<width {
                    let ink = Int(pixels[(y * width + x) * 4 + 3])
                    if y < height / 2 { first += ink } else { second += ink }
                }
            }
            return (first, second)
        }
        // Calibrate bitmap row order independently with a UIKit bottom-half
        // rectangle, so this tests visual orientation rather than byte layout.
        let bottomReference = UIGraphicsImageRenderer(size: CGSize(width: 16, height: 16)).image { context in
            UIColor.black.setFill()
            context.fill(CGRect(x: 0, y: 8, width: 16, height: 8))
        }
        let reference = try inkHalves(bottomReference)
        let fraction = try inkHalves(rendered.image)
        let bottom = reference.second > reference.first ? fraction.second : fraction.first
        let top = reference.second > reference.first ? fraction.first : fraction.second
        XCTAssertGreaterThan(bottom, top * 2, "The denominator must stay below the fraction bar")
        let attachment = XCTAttachment(image: rendered.image)
        attachment.name = "Upright asymmetric native fraction"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
    func testResourceLinksUseOnlyThisServerForAuthenticatedFiles() {
        let id = "file_0123456789abcdef0123456789abcdef"
        let server = URL(string: "https://example.com/app/v1")!
        XCTAssertEqual(TranscriptResourceLink.resolve(URL(string: "file://\(id)")!, server: server)?.assetID, id)
        XCTAssertEqual(TranscriptResourceLink.resolve(URL(string: "/v1/files/\(id)/content?download=1")!, server: server)?.assetID, id)
        XCTAssertEqual(TranscriptResourceLink.resolve(URL(string: "https://example.com/app/v1/files/\(id)/content")!, server: server)?.assetID, id)
        XCTAssertNil(TranscriptResourceLink.resolve(URL(string: "https://unrelated.com/v1/files/\(id)/content")!, server: server))
        XCTAssertNil(TranscriptResourceLink.resolve(URL(string: "file:///etc/passwd")!, server: server))
    }
    @MainActor func testLaterSearchCannotRetargetEarlierAnswer() {
        func message(_ id: String, _ role: String, _ text: String) -> ChatMessage {
            ChatMessage(.object(["id": .string(id), "role": .string(role), "content": .string(text)]))!
        }
        let index = TranscriptCitationIndex()
        let first = message("tool1", "toolResult", "# Search 1: First\nAnchor: \\ue202turn0search0\nURL: https://first.example/page")
        let answer = message("answer1", "assistant", "First \\ue202turn0search0")
        let second = message("tool2", "toolResult", "# Search 1: Second\nAnchor: \\ue202turn0search0\nURL: https://second.example/page")
        index.replaceMessages([first, answer, second, message("answer2", "assistant", "Second")])
        XCTAssertTrue(index.scope(for: "answer1").render(answer.text).contains("first.example"))
        XCTAssertTrue(index.scope(for: "answer2").render(answer.text).contains("second.example"))
        let oldScope = index.scope(for: "answer1")
        index.replaceMessages([first, answer, second])
        XCTAssertTrue(oldScope === index.scope(for: "answer1"))
        index.replaceMessages([answer])
        XCTAssertFalse(index.scope(for: "answer1").render(answer.text).contains("first.example"))
    }
    func testPreviewFilesCancelBeforePublishingAndCleanUpAfterUse() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let files = TranscriptMediaFileStore(root: root)
        let cancelled = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await files.write(Data("Must not survive dismissal".utf8), name: "preview.txt")
        }
        do { _ = try await cancelled.value; XCTFail("Cancelled preview must not publish a file") }
        catch is CancellationError {} catch { XCTFail("Unexpected error: \(error)") }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), [])
        let payload = Data("Original source text".utf8)
        let preview = try await files.write(payload, name: "../original.txt")
        XCTAssertEqual(try Data(contentsOf: preview), payload)
        XCTAssertEqual(preview.lastPathComponent, "original.txt")
        await files.remove(preview)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), [])
    }
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
