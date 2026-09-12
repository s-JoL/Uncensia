import ImageIO
import QuickLook
import SwiftUI

struct MessageRow: View {
  let message: ChatMessage
  let api: APIClient?
  private let parts: [TranscriptPart]
  init(message: ChatMessage, api: APIClient?) {
    self.message = message
    self.api = api
    parts = TranscriptPart.decode(message.content, prefix: message.id).filter { part in
      guard message.role == "toolResult" else { return true }
      switch part.kind { case .image, .video, .file: return true; default: return false }
    }
  }

  var body: some View {
    Group {
      if message.role == "user" {
        HStack(alignment: .top) {
          Spacer(minLength: 44)
          messageContent.padding(13)
            .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 18))
        }
      } else {
        // Let the answer report its complete height directly. A surrounding
        // HStack can retain a taller measurement after long Markdown reflows,
        // leaving an empty region below the actual final line.
        messageContent.fixedSize(horizontal: false, vertical: true)
      }
    }
    .frame(maxWidth: .infinity, alignment: message.role == "user" ? .trailing : .leading)

  }

  private var messageContent: some View {
    VStack(alignment: .leading, spacing: 10) {
      if message.role == "toolResult" {
        ToolTranscriptCard(name: message.content["toolName"].stringValue ?? message.raw["toolName"].stringValue ?? uncensiaText("工具结果"), arguments: .null, result: message.text)
      }
      ForEach(parts) { part in
        TranscriptPartView(part: part, api: api, user: message.role == "user")
      }
    }
  }
}

struct StreamingRow: View {
  let text: String
  let status: String
  let api: APIClient?
  let thinking: String
  let tools: [JSONValue]
  init(
    text: String, status: String, api: APIClient?, thinking: String = "", tools: [JSONValue] = []
  ) {
    self.text = text
    self.status = status
    self.api = api
    self.thinking = thinking
    self.tools = tools
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if !thinking.isEmpty {
        DisclosureGroup(uncensiaText("思考过程")) {
          Text(thinking).foregroundStyle(.secondary).textSelection(.enabled).padding(.top, 6)
        }
        .padding(10).background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
      }
      ForEach(Array(tools.enumerated()), id: \.offset) { _, tool in
        ToolTranscriptCard(
          name: tool["toolName"].stringValue ?? "tool",
          arguments: tool["args"],
          result: tool["result"].pretty.isEmpty
            ? tool["partialResult"].pretty : tool["result"].pretty)
      }
      if !text.isEmpty { RichMarkdown(text: text, api: api, streaming: true).accessibilityElement(children: .contain).accessibilityLabel(uncensiaText("正在回复")).accessibilityIdentifier("chat.live.text") }
      if !status.isEmpty {
        Label(localizedStreamingStatus(status), image: "lucide-sparkles").font(.caption)
          .foregroundStyle(.secondary)
      }
      if text.isEmpty { ProgressView().controlSize(.small) }
    }.frame(maxWidth: .infinity, alignment: .leading)
  }
}

private func localizedStreamingStatus(_ status: String) -> String {
  let labels = [
    "thinking": uncensiaText("正在思考"), "streaming": uncensiaText("正在回复"), "tool": uncensiaText("正在使用工具"), "done": uncensiaText("已完成"),
  ]
  return labels[status] ?? status
}

private struct TranscriptPart: Identifiable {
  enum Kind {
    case text(String)
    case thinking(String)
    case image(String, String?)
    case video(String, String?)
    case file(String, String, String)
    case tool(String, JSONValue)
    case unknown(String)
  }
  let id: String
  let kind: Kind
  static func decode(_ value: JSONValue, prefix: String) -> [Self] {
    if let text = value.stringValue { return [.init(id: "\(prefix)-0", kind: .text(text))] }
    let values =
      value["content"].arrayValue ?? value.arrayValue
      ?? (value["content"].stringValue.map { [.string($0)] } ?? [])
    return values.enumerated().flatMap { index, part -> [Self] in
      let id = "\(prefix)-\(index)"
      if let text = part.stringValue { return [.init(id: id, kind: .text(text))] }
      switch part["type"].stringValue ?? "" {
      case "text": return [.init(id: id, kind: .text(part["text"].stringValue ?? ""))]
      case "thinking":
        let raw = part["thinking"].stringValue ?? part["text"].stringValue ?? ""
        let clean = raw.components(separatedBy: "__ENCRYPTED_REASONING__").first ?? raw
        return clean.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
          ? [] : [.init(id: id, kind: .thinking(clean))]
      case "image_ref":
        return part["image_id"].stringValue.map {
          [.init(id: id, kind: .image($0, part["reference_role"].stringValue))]
        } ?? []
      case "video_ref":
        return part["video_id"].stringValue.map {
          [.init(id: id, kind: .video($0, part["poster_image_id"].stringValue))]
        } ?? []
      case "file_ref":
        return part["file_id"].stringValue.map {
          [
            .init(
              id: id,
              kind: .file(
                $0, part["name"].stringValue ?? $0,
                part["mime_type"].stringValue ?? "application/octet-stream"))
          ]
        } ?? []
      case "toolCall":
        return [.init(id: id, kind: .tool(part["name"].stringValue ?? "tool", part["arguments"]))]
      default:
        if let nested = part["content"].arrayValue { return decode(.array(nested), prefix: id) }
        return [.init(id: id, kind: .unknown(part.pretty))]
      }
    }
  }
}

private struct TranscriptPartView: View {
  let part: TranscriptPart
  let api: APIClient?
  let user: Bool
  @State private var preview: TranscriptPreview?
  var body: some View {
    Group {
      switch part.kind {
      case .text(let text): RichMarkdown(text: text, api: api)
      case .thinking(let text):
        DisclosureGroup(uncensiaText("思考过程")) {
          Text(text).textSelection(.enabled).foregroundStyle(.secondary).padding(.top, 6)
        }.padding(10).background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
      case .image(let id, let role):
        VStack {
          AuthenticatedTranscriptImage(path: "/images/\(id)?w=1280", api: api).frame(
            maxWidth: user ? 220 : 620, maxHeight: 600
          ).clipShape(RoundedRectangle(cornerRadius: 12)).onTapGesture {
            preview = .init(id: id, name: "\(id).png", kind: .image)
          }.accessibilityLabel(uncensiaText("打开图片")).accessibilityAddTraits(.isButton).accessibilityIdentifier("media.image.\(id)")
          if let role { Text(referenceLabel(role)).font(.caption).foregroundStyle(.secondary) }
        }
      case .video(let id, let poster):
        Button {
          preview = .init(id: id, name: "\(id).mp4", kind: .video)
        } label: {
          ZStack {
            if let poster {
              AuthenticatedTranscriptImage(path: "/images/\(poster)?w=640", api: api)
            } else {
              Rectangle().fill(.black)
            }
            Image("lucide-circle-play").font(.system(size: 54)).foregroundStyle(.white)
              .shadow(radius: 4)
          }.frame(maxWidth: 520).aspectRatio(16 / 9, contentMode: .fit).clipShape(
            RoundedRectangle(cornerRadius: 12))
        }
        .accessibilityLabel(uncensiaText("播放视频")).accessibilityIdentifier("media.video.\(id)")
      case .file(let id, let name, let mime):
        Button {
          preview = .init(id: id, name: name, kind: mime == "application/pdf" ? .document : .file)
        } label: {
          Label(name, image: mime == "application/pdf" ? "lucide-file-text" : "lucide-file").lineLimit(1)
        }.buttonStyle(.bordered)
      case .tool(let name, let arguments):
        ToolTranscriptCard(name: name, arguments: arguments, result: nil)
      case .unknown(let raw):
        if !raw.isEmpty {
          DisclosureGroup(uncensiaText("详细内容")) { Text(raw).font(.caption.monospaced()).textSelection(.enabled) }
        }
      }
    }.sheet(item: $preview) { TranscriptMediaViewer(item: $0, api: api) }
  }
  private func referenceLabel(_ role: String) -> String {
    [
      "context": uncensiaText("上下文"), "base": uncensiaText("待编辑原图"), "subject": uncensiaText("人物参考"), "scene": uncensiaText("场景参考"), "style": uncensiaText("风格参考"),
      "source": uncensiaText("来源图"),
    ][role] ?? role
  }
}

private struct ToolTranscriptCard: View {
  let name: String
  let arguments: JSONValue
  let result: String?
  private var label: String {
    [
      "read": uncensiaText("读取资料"), "write": uncensiaText("写入文件"), "edit": uncensiaText("修改文件"), "grep": uncensiaText("搜索内容"), "find": uncensiaText("查找文件"), "ls": uncensiaText("查看目录"),
      "bash": uncensiaText("执行命令"), "web_search": uncensiaText("搜索网页"), "file_search": uncensiaText("查阅文件"), "view_image": uncensiaText("查看图片"),
      "generate_image": uncensiaText("生成图片"), "edit_image": uncensiaText("编辑图片"), "generate_video": uncensiaText("生成视频"),
    ][name] ?? name
  }
  var body: some View {
    DisclosureGroup {
      VStack(alignment: .leading, spacing: 8) {
        if arguments != .null {
          Text(arguments.pretty).font(.caption.monospaced()).textSelection(.enabled)
        }
        if let result, !result.isEmpty {
          Divider()
          Text(result).font(.caption.monospaced()).textSelection(.enabled)
        }
      }.padding(.top, 6)
    } label: {
      Label(label, image: "lucide-wrench").foregroundStyle(.secondary)
    }.padding(10).background(.quaternary, in: RoundedRectangle(cornerRadius: 11))
  }
}

@MainActor private enum SettledMarkdownCache {
  private final class Entry: NSObject {
    let blocks: [MarkdownBlock]
    init(_ blocks: [MarkdownBlock]) { self.blocks = blocks }
  }
  private static let cache: NSCache<NSString, Entry> = {
    let cache = NSCache<NSString, Entry>()
    cache.countLimit = 100; cache.totalCostLimit = 4 * 1024 * 1024
    return cache
  }()
  private static var latestStream: (String, [MarkdownBlock])?
  static func parse(_ text: String) -> [MarkdownBlock] {
    if latestStream?.0 == text { return latestStream!.1 }
    let key = text as NSString
    if let entry = cache.object(forKey: key) { return entry.blocks }
    let blocks = MarkdownBlock.parse(text)
    cache.setObject(Entry(blocks), forKey: key, cost: text.utf8.count * 3)
    return blocks
  }
  static func rememberStream(_ text: String, blocks: [MarkdownBlock]) {
    latestStream = (text, blocks)
  }
}

struct RichMarkdown: View {
  let text: String
  let api: APIClient?
  let streaming: Bool
  @State private var blocks: [MarkdownBlock]
  @State private var parsedText: String
  @State private var parser = StreamingMarkdownParser()
  @State private var resource: TranscriptResourceLink?
  init(text: String, api: APIClient? = nil, streaming: Bool = false) {
    self.text = text
    self.api = api
    self.streaming = streaming
    _blocks = State(initialValue: streaming ? [] : SettledMarkdownCache.parse(text))
    _parsedText = State(initialValue: streaming ? "" : text)
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach(blocks) { block in
        switch block.kind {
        case .prose(let value):
          MarkdownProse(value, streaming: streaming && block.id == blocks.last?.id).equatable()
        case .code(let language, let code):
          MarkdownCodeBlock(language: language, code: code).equatable()
        case .table(let rows): MarkdownTable(rows: rows).equatable()
        case .image(let id, let label):
          TranscriptPartView(part: .init(id: id, kind: id.hasPrefix("vid_") ? .video(id, nil) : .image(id, nil)), api: api, user: false)
          if !label.isEmpty { Text(label).font(.caption).foregroundStyle(.secondary) }
        case .quote(let id):
          ResourceQuoteCard(id: id, api: api).id("\(id)-\(api.map { String(describing: ObjectIdentifier($0)) } ?? "none")")
        case .math(let latex, let closed): MarkdownMathView(latex: latex, pending: streaming && !closed)
        }
      }
    }.frame(maxWidth: .infinity, alignment: .leading)
      .task(id: text) {
        guard parsedText != text else { return }
        let source = text
        guard let parsed = try? await parser.parse(source), !Task.isCancelled else { return }
        blocks = parsed; parsedText = source
        if streaming { SettledMarkdownCache.rememberStream(source, blocks: parsed) }
      }
      .environment(\.openURL, OpenURLAction { url in
        guard let link = TranscriptResourceLink.resolve(url, server: api?.server) else { return .systemAction }
        resource = link
        return .handled
      })
      .sheet(item: $resource) { TranscriptResourceViewer(resource: $0, api: api) }
  }
}

private struct MarkdownCodeBlock: View, Equatable {
  let language: String
  let code: String
  @State private var copied = false
  nonisolated static func == (lhs: Self, rhs: Self) -> Bool { lhs.language == rhs.language && lhs.code == rhs.code }
  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack {
        Text(language.isEmpty ? "Code" : language).font(.caption).foregroundStyle(.secondary)
        Spacer()
        Button {
          UIPasteboard.general.string = code
          copied = true
        } label: { Image(systemName: copied ? "checkmark" : "doc.on.doc") }
          .accessibilityLabel(copied ? uncensiaText("已复制") : uncensiaText("复制代码"))
      }.padding(.horizontal, 12).padding(.top, 10)
      ScrollView(.horizontal) {
        Text(code).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
          .fixedSize(horizontal: true, vertical: false).padding(12)
      }
    }.background(.quaternary.opacity(0.6), in: RoundedRectangle(cornerRadius: 12))
      .onChange(of: code) { _, _ in copied = false }
  }
}
private struct MarkdownProse: View, Equatable {
  nonisolated static func == (lhs: Self, rhs: Self) -> Bool { lhs.text == rhs.text && lhs.streaming == rhs.streaming }
  let text: String
  let streaming: Bool
  @Environment(TranscriptCitationIndex.self) private var index
  init(_ text: String, streaming: Bool = false) { self.text = text; self.streaming = streaming }
  var body: some View {
    let rendered = index.render(streaming ? MarkdownStreamingTail.prepare(text) : text)
    VStack(alignment: .leading, spacing: 5) {
      ForEach(Array(rendered.components(separatedBy: .newlines).enumerated()), id: \.offset) {
        _, line in
        MarkdownProseLine(line: line).equatable()
      }
    }.textSelection(.enabled).tint(.accentColor).lineSpacing(3)
  }
}

private struct MarkdownProseLine: View, Equatable {
  let line: String
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.displayScale) private var scale
  @ScaledMetric(relativeTo: .body) private var fontSize: CGFloat = 17
  nonisolated static func == (lhs: Self, rhs: Self) -> Bool { lhs.line == rhs.line }
  var body: some View {
    if let heading = line.range(of: #"^#{1,6}\s+"#, options: .regularExpression) {
      let level = line[..<heading.upperBound].prefix(while: { $0 == "#" }).count
      inline(String(line[heading.upperBound...])).font(level == 1 ? .title2.bold() : level == 2 ? .title3.bold() : .headline)
    } else if line.hasPrefix("> ") {
      HStack(spacing: 9) {
        Rectangle().fill(.secondary.opacity(0.45)).frame(width: 3)
        inline(String(line.dropFirst(2))).foregroundStyle(.secondary)
      }.padding(.vertical, 2)
    } else if line.trimmingCharacters(in: .whitespaces).range(of: #"^(?:-{3,}|\*{3,}|_{3,})$"#, options: .regularExpression) != nil {
      Divider().padding(.vertical, 5)
    } else if let match = line.range(of: #"^\s*[-*+]\s+\[[ xX]\]\s+"#, options: .regularExpression) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Image(systemName: line[..<match.upperBound].lowercased().contains("[x]") ? "checkmark.square.fill" : "square")
          .foregroundStyle(.secondary)
        inline(String(line[match.upperBound...]))
      }.padding(.leading, indentation)
    } else if let match = line.range(of: #"^\s*[-*+]\s+"#, options: .regularExpression) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text("•")
        inline(String(line[match.upperBound...]))
      }.padding(.leading, indentation)
    } else if let match = line.range(of: #"^\s*\d+[.)]\s+"#, options: .regularExpression) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(String(line[..<match.upperBound]).trimmingCharacters(in: .whitespaces))
          .foregroundStyle(.secondary)
        inline(String(line[match.upperBound...]))
      }.padding(.leading, indentation)
    } else if line.isEmpty {
      Color.clear.frame(height: 3)
    } else {
      inline(line).frame(maxWidth: .infinity, alignment: .leading)
    }
  }
  private var indentation: CGFloat { 8 + CGFloat(min(6, line.prefix(while: { $0 == " " || $0 == "\t" }).count / 2)) * 12 }
  private func inline(_ value: String) -> Text {
    InlineMarkdownCache.text(value, fontSize: fontSize, dark: colorScheme == .dark, scale: scale)
  }
}

@MainActor private enum InlineMarkdownCache {
  private final class Entry: NSObject {
    let value: AttributedString
    init(_ value: AttributedString) { self.value = value }
  }
  private static let cache: NSCache<NSString, Entry> = {
    let value = NSCache<NSString, Entry>(); value.totalCostLimit = 4 * 1024 * 1024; value.countLimit = 1500; return value
  }()
  static func parse(_ value: String) -> AttributedString {
    if let cached = cache.object(forKey: value as NSString) { return cached.value }
    let rendered = (try? AttributedString(markdown: value, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(value)
    cache.setObject(Entry(rendered), forKey: value as NSString, cost: max(64, value.utf8.count * 3))
    return rendered
  }
  static func text(_ value: String, fontSize: CGFloat, dark: Bool, scale: CGFloat) -> Text {
    let spans = MarkdownMathSource.spans(value)
    var source = "", substitutions: [(marker: String, latex: String, original: String)] = []
    for span in spans {
      switch span {
      case .text(let text): source += text
      case .math(let latex, let original):
        let marker = "\u{F0000}\(substitutions.count)\u{F0001}"
        substitutions.append((marker, latex, original)); source += marker
      }
    }
    let attributed = parse(source)
    guard !substitutions.isEmpty else { return Text(attributed) }
    var cursor = attributed.startIndex, result = Text("")
    for substitution in substitutions {
      guard let range = attributed.range(of: substitution.marker) else { continue }
      result = result + Text(AttributedString(attributed[cursor..<range.lowerBound]))
      if attributed[range].link == nil,
        let rendered = NativeMathCache.render(substitution.latex, display: false, fontSize: fontSize, dark: dark, scale: scale) {
        result = result + Text(Image(uiImage: rendered.image)).baselineOffset(-rendered.descent).accessibilityLabel(substitution.latex)
      } else {
        var literal = AttributedString(substitution.original)
        if let attributes = attributed[range].runs.first?.attributes { literal.setAttributes(attributes) }
        result = result + Text(literal)
      }
      cursor = range.upperBound
    }
    return result + Text(AttributedString(attributed[cursor...]))
  }
}

@MainActor @Observable final class TranscriptCitationIndex {
  private struct Source: Equatable { let label: String; let url: String? }
  @ObservationIgnored private var indexed: [String: JSONValue] = [:]
  @ObservationIgnored private var sourceCache: [String: [String: Source]] = [:]
  private var scopes: [String: TranscriptCitationIndex] = [:]
  func reset() { links = [:]; indexed = [:]; sourceCache = [:]; scopes = [:] }
  private var links: [String: Source] = [:]
  func scope(for messageID: String) -> TranscriptCitationIndex { scopes[messageID] ?? self }
  /// A tool can reuse turn0search0 in a later run. Freeze each answer's sources
  /// at its transcript position, including when older pages are prepended.
  func replaceMessages(_ messages: [ChatMessage]) {
    var accumulated: [String: Source] = [:]
    var next: [String: TranscriptCitationIndex] = [:]
    var current: TranscriptCitationIndex?
    for message in messages {
      accumulated.merge(sources(in: message)) { _, newer in newer }
      if let existing = scopes[message.id], existing.links == accumulated { current = existing }
      else if current?.links != accumulated { current = nil }
      if current == nil { let value = TranscriptCitationIndex(); value.links = accumulated; current = value }
      next[message.id] = current
    }
    if links != accumulated { links = accumulated }
    scopes = next
    let ids = Set(messages.map(\.id))
    indexed = indexed.filter { ids.contains($0.key) }
    sourceCache = sourceCache.filter { ids.contains($0.key) }
  }
  func ingest(_ message: ChatMessage) {
    let additions = sources(in: message)
    for (key, source) in additions where links[key] != source { links[key] = source }
  }
  private func sources(in message: ChatMessage) -> [String: Source] {
    guard message.role == "toolResult" else { return [:] }
    if indexed[message.id] == message.content { return sourceCache[message.id] ?? [:] }
    indexed[message.id] = message.content
    var found: [String: Source] = [:]
    for block in message.text.replacingOccurrences(of: "\nFile:", with: "\n#File:").components(separatedBy: "\n#") {
      let lines = block.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }
      guard let anchor = lines.first(where: { $0.lowercased().hasPrefix("anchor:") }),
        let match = anchor.range(of: #"(?:\\ue202|\uE202)turn\d+(?:file|search|news|image|video)\d+"#, options: [.regularExpression, .caseInsensitive]),
        let keyRange = String(anchor[match]).range(of: #"turn\d+(?:file|search|news|image|video)\d+"#, options: [.regularExpression, .caseInsensitive]) else { continue }
      let marked = String(anchor[match])
      let key = String(marked[keyRange]).lowercased()
      let fileID = lines.first(where: { $0.hasPrefix("file_id: ") }).map { String($0.dropFirst(9)) }
      let url = lines.first(where: { $0.hasPrefix("URL: ") }).map { String($0.dropFirst(5)) }
        ?? fileID.map { "file://\($0)" }
      let file = anchor.range(of: #"\([^)]+\)"#, options: .regularExpression).map { String(anchor[$0].dropFirst().dropLast()) }
      let label = file ?? url.flatMap { URL(string: $0)?.host() } ?? uncensiaText("来源")
      found[key] = Source(label: label, url: url)
    }
    sourceCache[message.id] = found
    return found
  }
  func render(_ text: String) -> String {
    var output = text
    guard
      let regex = try? NSRegularExpression(
        pattern: #"(?:\\ue202|\uE202)(turn\d+(?:file|search|news|image|video)\d+)"#,
        options: [.caseInsensitive])
    else { return text }
    for match in regex.matches(in: output, range: NSRange(output.startIndex..., in: output))
      .reversed()
    {
      guard let range = Range(match.range(at: 0), in: output),
        let body = Range(match.range(at: 1), in: output)
      else { continue }
      let key = String(output[body]).lowercased()
      let source = links[key]
      guard let source else { output.replaceSubrange(range, with: ""); continue }
      let label = source.label.replacingOccurrences(of: "[", with: "").replacingOccurrences(of: "]", with: "")
      output.replaceSubrange(
        range, with: source.url.map { uncensiaText("[来源·%@](%@)", String(describing: label), String(describing: $0)) } ?? uncensiaText("[来源·%@]", String(describing: label)))
    }
    return output.replacingOccurrences(
      of: #"\\ue20[0134]|[\uE200\uE201\uE203\uE204]"#, with: "", options: .regularExpression
    )
  }
}
private struct MarkdownTable: View, Equatable {
  let rows: [[String]]
  @Environment(TranscriptCitationIndex.self) private var index
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.displayScale) private var scale
  @ScaledMetric(relativeTo: .callout) private var fontSize: CGFloat = 16
  nonisolated static func == (lhs: Self, rhs: Self) -> Bool { lhs.rows == rhs.rows }
  var body: some View {
    ScrollView(.horizontal) {
      MarkdownTableGrid(columns: rows.first?.count ?? 0) {
        ForEach(Array(rows.enumerated()), id: \.offset) { row, cells in
          ForEach(0..<(rows.first?.count ?? 0), id: \.self) { column in
            let cell = column < cells.count ? cells[column] : ""
            ZStack(alignment: .leading) {
              Rectangle().fill(row == 0 ? Color.secondary.opacity(0.10) : .clear)
                .overlay { Rectangle().stroke(.secondary.opacity(0.20), lineWidth: 0.5) }
              InlineMarkdownCache.text(index.render(cell), fontSize: fontSize, dark: colorScheme == .dark, scale: scale)
                .font(row == 0 ? .callout.bold() : .callout).textSelection(.enabled)
                .frame(minWidth: 90, maxWidth: 260, alignment: .leading).padding(10)
                .fixedSize(horizontal: false, vertical: true)
            }
          }
        }
      }.padding(.vertical, 2)
    }
  }
}

/// Each row gets the height of its tallest cell, including typeset formulas.
/// Measuring with an unspecified height and placing with finite cell rectangles
/// keeps table borders continuous without introducing a flexible vertical tail.
private struct MarkdownTableGrid: Layout {
  let columns: Int
  struct Cache {
    var widths: [CGFloat]
    var heights: [CGFloat]
  }
  func makeCache(subviews: Subviews) -> Cache { measurements(subviews) }
  func updateCache(_ cache: inout Cache, subviews: Subviews) { cache = measurements(subviews) }
  private func measurements(_ subviews: Subviews) -> Cache {
    guard columns > 0 else { return Cache(widths: [], heights: []) }
    var widths = [CGFloat](repeating: 110, count: columns)
    for (index, cell) in subviews.enumerated() {
      let width = cell.sizeThatFits(.unspecified).width
      widths[index % columns] = max(widths[index % columns], min(280, width))
    }
    var heights = [CGFloat](repeating: 0, count: (subviews.count + columns - 1) / columns)
    for (index, cell) in subviews.enumerated() {
      let size = cell.sizeThatFits(ProposedViewSize(width: widths[index % columns], height: nil))
      heights[index / columns] = max(heights[index / columns], size.height)
    }
    return Cache(widths: widths, heights: heights)
  }
  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) -> CGSize {
    CGSize(width: cache.widths.reduce(0, +), height: cache.heights.reduce(0, +))
  }
  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) {
    guard columns > 0 else { return }
    var x = bounds.minX, y = bounds.minY
    for (index, cell) in subviews.enumerated() {
      let column = index % columns, row = index / columns
      if column == 0 { x = bounds.minX }
      cell.place(at: CGPoint(x: x, y: y), anchor: .topLeading,
        proposal: ProposedViewSize(width: cache.widths[column], height: cache.heights[row]))
      x += cache.widths[column]
      if column == columns - 1 { y += cache.heights[row] }
    }
  }
}

private actor TranscriptImageCache {
  static let shared = TranscriptImageCache()
  private var inFlight: [NSString: Task<UIImage, Error>] = [:]
  private let cache: NSCache<NSString, UIImage> = {
    let cache = NSCache<NSString, UIImage>(); cache.totalCostLimit = 48 * 1024 * 1024; return cache
  }()
  func image(path: String, api: APIClient) async throws -> UIImage {
    let key = "\(ObjectIdentifier(api))-\(path)" as NSString
    if let image = cache.object(forKey: key) { return image }
    let request: Task<UIImage, Error>
    if let running = inFlight[key] { request = running }
    else {
      request = Task.detached(priority: .userInitiated) {
        let data = try await api.download(path)
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
          let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: 1280
          ] as CFDictionary) else { throw URLError(.cannotDecodeContentData) }
        return UIImage(cgImage: cg)
      }
      inFlight[key] = request
    }
    defer { inFlight[key] = nil }
    let image = try await request.value
    cache.setObject(image, forKey: key, cost: (image.cgImage?.bytesPerRow ?? 0) * (image.cgImage?.height ?? 0))
    return image
  }
}

private struct AuthenticatedTranscriptImage: View {
  let path: String
  let api: APIClient?
  @State private var image: Image?
  @State private var failed = false
  @State private var attempt = 0
  var body: some View {
    // The media canvas owns layout; decoding never changes the row's height.
    // Fit the complete image inside it, including portrait and panoramic images.
    Rectangle().fill(.quaternary).aspectRatio(4.0 / 3.0, contentMode: .fit)
      .overlay {
        if let image {
          GeometryReader { geometry in
            image.resizable().scaledToFit()
              .frame(width: geometry.size.width, height: geometry.size.height)
          }
        } else if failed {
          Button { failed = false; attempt += 1 } label: { Label(uncensiaText("重试"), image: "lucide-refresh-cw") }
        } else { ProgressView() }
      }
      .clipped()
    .task(id: "\(api.map { String(describing: ObjectIdentifier($0)) } ?? "none")-\(path)-\(attempt)") {
      image = nil; failed = false
      guard let api, let ui = try? await TranscriptImageCache.shared.image(path: path, api: api) else { if !Task.isCancelled { failed = true }; return }
      guard !Task.isCancelled else { return }
      image = Image(uiImage: ui)
    }
  }
}
struct TranscriptPreview: Identifiable {
  enum Kind: Equatable { case image, video, document, file }
  let id: String
  let name: String
  let kind: Kind
}
struct TranscriptMediaViewer: View {
  let item: TranscriptPreview
  let api: APIClient?
  @Environment(\.dismiss) var dismiss
  @State private var url: URL?
  @State private var error: String?
  @State private var attempt = 0
  @State private var files = TranscriptMediaFileStore()
  var body: some View {
    NavigationStack {
      Group {
        if let url {
          TranscriptQuickLook(url: url).accessibilityIdentifier("media.preview")
        } else if let error {
          ContentUnavailableView {
            Label(uncensiaText("无法打开"), image: "lucide-triangle-alert")
          } description: {
            Text(error)
          } actions: {
            Button(uncensiaText("重试")) { attempt += 1 }.accessibilityIdentifier("media.retry")
          }
        } else {
          ProgressView(uncensiaText("正在读取…"))
        }
      }.navigationTitle(item.kind == .image ? uncensiaText("图片") : item.kind == .video ? uncensiaText("视频") : item.name).navigationBarTitleDisplayMode(.inline).toolbar {
        ToolbarItem(placement: .cancellationAction) { Button(uncensiaText("完成")) { dismiss() }.accessibilityIdentifier("media.close") }
        if let url {
          ToolbarItemGroup(placement: .primaryAction) {
            if item.kind == .image || item.kind == .video {
              NavigationLink {
                TranscriptProvenance(assetID: item.id, kind: item.kind, api: api)
              } label: {
                Image("lucide-info")
              }.accessibilityLabel(uncensiaText("来源")).accessibilityIdentifier("media.provenance")
            }
            ShareLink(item: url) { Image("lucide-share") }
          }
        }
      }
    }
      .task(id: "\(api.map { String(describing: ObjectIdentifier($0)) } ?? "none")-\(item.id)-\(attempt)") {
        if let old = url { url = nil; await files.remove(old) }
        error = nil
        guard let api else { error = uncensiaText("无法打开"); return }
        do {
          let path =
            item.kind == .image
            ? "/images/\(item.id)"
            : item.kind == .video ? "/videos/\(item.id)" : "/files/\(item.id)/content"
          let data = try await api.download(path)
          try Task.checkCancellation()
          let target = try await files.write(data, name: item.name)
          guard !Task.isCancelled else { await files.remove(target); return }
          url = target
        } catch let caught { if !Task.isCancelled { error = caught.localizedDescription } }
      }.onDisappear {
        // This belongs to the modal, not its first navigation destination.
        // Opening provenance must leave the preview/share file alive.
        if let old = url { url = nil; Task { await files.remove(old) } }
      }
  }
}

actor TranscriptMediaFileStore {
  private let root: URL
  init(root: URL = FileManager.default.temporaryDirectory) { self.root = root }
  func write(_ data: Data, name: String) throws -> URL {
    try Task.checkCancellation()
    let directory = root.appendingPathComponent("uncensia-transcript-\(UUID().uuidString)", isDirectory: true)
    var published = false
    defer { if !published { try? FileManager.default.removeItem(at: directory) } }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let component = (name as NSString).lastPathComponent
    let filename = component.isEmpty || component == "." || component == ".." ? "download" : component
    let target = directory.appendingPathComponent(filename)
    try data.write(to: target, options: .atomic)
    try Task.checkCancellation()
    published = true
    return target
  }
  func remove(_ url: URL) { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
}
private struct TranscriptProvenance: View {
  let assetID: String
  let kind: TranscriptPreview.Kind
  let api: APIClient?
  @State private var record: JSONValue = .null
  var body: some View {
    List {
      if record == .null {
        ProgressView()
      } else {
        LabeledContent(
          uncensiaText("模型"),
          value: record["job"]["modelName"].stringValue ?? record["model"].stringValue ?? uncensiaText("未记录"))
        LabeledContent(uncensiaText("后端"), value: record["provider"].stringValue ?? uncensiaText("未记录"))
        if let prompt = record["job"]["params"]["prompt"].stringValue {
          Section(uncensiaText("提示词")) { Text(prompt).textSelection(.enabled) }
        }
        if let params = record["job"]["params"].objectValue, !params.isEmpty {
          Section(uncensiaText("参数")) {
            Text(JSONValue.object(params).pretty).font(.caption.monospaced()).textSelection(
              .enabled)
          }
        }
      }
    }.navigationTitle(uncensiaText("来源")).task {
      guard let api else { return }
      record =
        (try? await api.request(
          "GET", "/\(kind == .video ? "videos" : "images")/\(assetID)/provenance")) ?? .null
    }
  }
}
private struct TranscriptQuickLook: UIViewControllerRepresentable {
  let url: URL
  func makeCoordinator() -> Coordinator { Coordinator(url) }
  func makeUIViewController(context: Context) -> QLPreviewController {
    let controller = QLPreviewController()
    controller.dataSource = context.coordinator
    return controller
  }
  func updateUIViewController(_ uiViewController: QLPreviewController, context: Context) {
    guard context.coordinator.url != url else { return }
    context.coordinator.url = url
    uiViewController.reloadData()
  }
  final class Coordinator: NSObject, QLPreviewControllerDataSource {
    var url: URL
    init(_ url: URL) { self.url = url }
    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
    func previewController(_ controller: QLPreviewController, previewItemAt index: Int)
      -> QLPreviewItem
    { url as NSURL }
  }
}
extension JSONValue {
  fileprivate var pretty: String {
    guard let data = try? JSONEncoder().encode(self) else { return "" }
    return (try? JSONSerialization.jsonObject(with: data)).flatMap {
      try? JSONSerialization.data(withJSONObject: $0, options: [.prettyPrinted, .sortedKeys])
    }.flatMap { String(data: $0, encoding: .utf8) } ?? ""
  }
}
