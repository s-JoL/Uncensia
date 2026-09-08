import QuickLook
import SwiftUI

struct MessageRow: View {
  let message: ChatMessage
  let api: APIClient?
  private let parts: [TranscriptPart]
  init(message: ChatMessage, api: APIClient?) {
    self.message = message
    self.api = api
    parts = TranscriptPart.decode(message.content, prefix: message.id)
  }

  var body: some View {
    HStack(alignment: .top) {
      if message.role == "user" { Spacer(minLength: 44) }
      VStack(alignment: .leading, spacing: 10) {
        Text(message.role == "user" ? uncensiaText("你") : message.role == "toolResult" ? uncensiaText("工具结果") : "Uncensia")
          .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
        ForEach(parts) { part in
          TranscriptPartView(part: part, api: api, user: message.role == "user")
        }
      }
      .padding(message.role == "user" ? 13 : 0)
      .background(
        message.role == "user" ? Color.secondary.opacity(0.12) : .clear,
        in: RoundedRectangle(cornerRadius: 18))
      if message.role != "user" { Spacer(minLength: 16) }
    }
    .frame(maxWidth: .infinity, alignment: message.role == "user" ? .trailing : .leading)
    .task { TranscriptCitationIndex.shared.ingest(message) }
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
      Text("Uncensia").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
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
      if !text.isEmpty { RichMarkdown(text: text, api: api) }
      if !status.isEmpty {
        Label(localizedStreamingStatus(status), systemImage: "sparkles").font(.caption)
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
    case result(String)
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
          }
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
            Image(systemName: "play.circle.fill").font(.system(size: 54)).foregroundStyle(.white)
              .shadow(radius: 4)
          }.frame(maxWidth: 520).aspectRatio(16 / 9, contentMode: .fit).clipShape(
            RoundedRectangle(cornerRadius: 12))
        }
      case .file(let id, let name, let mime):
        Button {
          preview = .init(id: id, name: name, kind: mime == "application/pdf" ? .document : .file)
        } label: {
          Label(name, systemImage: mime == "application/pdf" ? "doc.richtext" : "doc").lineLimit(1)
        }.buttonStyle(.bordered)
      case .tool(let name, let arguments):
        ToolTranscriptCard(name: name, arguments: arguments, result: nil)
      case .result(let result): ToolTranscriptCard(name: uncensiaText("工具结果"), arguments: .null, result: result)
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
      Label(label, systemImage: "wrench.and.screwdriver").foregroundStyle(.secondary)
    }.padding(10).background(.quaternary, in: RoundedRectangle(cornerRadius: 11))
  }
}

struct RichMarkdown: View {
  let text: String
  let api: APIClient?
  @State private var blocks: [MarkdownBlock]
  init(text: String, api: APIClient? = nil) {
    self.text = text
    self.api = api
    _blocks = State(initialValue: MarkdownBlock.parse(text))
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach(blocks) { block in
        switch block.kind {
        case .prose(let value): MarkdownProse(value)
        case .code(let language, let code):
          VStack(alignment: .leading, spacing: 4) {
            if !language.isEmpty { Text(language).font(.caption2).foregroundStyle(.secondary) }
            ScrollView(.horizontal) {
              Text(code).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
                .padding(10)
            }
          }.background(.black.opacity(0.07), in: RoundedRectangle(cornerRadius: 9))
        case .table(let rows): MarkdownTable(rows: rows)
        case .image(let id, let label):
          VStack(alignment: .leading, spacing: 4) {
            AuthenticatedTranscriptImage(path: "/images/\(id)?w=1280", api: api)
              .frame(maxWidth: 620, maxHeight: 600)
              .clipShape(RoundedRectangle(cornerRadius: 12))
            if !label.isEmpty { Text(label).font(.caption).foregroundStyle(.secondary) }
          }
        }
      }
    }.frame(maxWidth: .infinity, alignment: .leading)
      .onChange(of: text) { _, newValue in blocks = MarkdownBlock.parse(newValue) }
  }
}
private struct MarkdownProse: View {
  let text: String
  @State private var index = TranscriptCitationIndex.shared
  init(_ text: String) { self.text = text }
  var body: some View {
    let rendered = index.render(text)
    VStack(alignment: .leading, spacing: 5) {
      ForEach(Array(rendered.components(separatedBy: .newlines).enumerated()), id: \.offset) {
        _, line in
        proseLine(line)
      }
    }.textSelection(.enabled).tint(.accentColor)
  }
  @ViewBuilder private func proseLine(_ line: String) -> some View {
    if line.hasPrefix("### ") {
      inline(String(line.dropFirst(4))).font(.headline)
    } else if line.hasPrefix("## ") {
      inline(String(line.dropFirst(3))).font(.title3.bold())
    } else if line.hasPrefix("# ") {
      inline(String(line.dropFirst(2))).font(.title2.bold())
    } else if line.hasPrefix("> ") {
      HStack(spacing: 9) {
        Capsule().fill(.secondary.opacity(0.45)).frame(width: 3)
        inline(String(line.dropFirst(2))).foregroundStyle(.secondary)
      }.padding(.vertical, 2)
    } else if let match = line.range(of: #"^\s*[-*+]\s+"#, options: .regularExpression) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text("•")
        inline(String(line[match.upperBound...]))
      }.padding(.leading, 8)
    } else if let match = line.range(of: #"^\s*\d+[.)]\s+"#, options: .regularExpression) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(String(line[..<match.upperBound]).trimmingCharacters(in: .whitespaces))
          .foregroundStyle(.secondary)
        inline(String(line[match.upperBound...]))
      }.padding(.leading, 8)
    } else if line.isEmpty {
      Color.clear.frame(height: 3)
    } else {
      inline(line)
    }
  }
  private func inline(_ value: String) -> Text {
    Text((try? AttributedString(markdown: value)) ?? AttributedString(value))
  }
}

@MainActor @Observable private final class TranscriptCitationIndex {
  static let shared = TranscriptCitationIndex()
  private var links: [String: (String, String?)] = [:]
  func ingest(_ message: ChatMessage) {
    guard message.role == "toolResult" else { return }
    for block in message.text.components(separatedBy: "\n#") {
      guard
        let match = block.range(
          of: #"(?:\\ue202|\u{e202})turn\d+(?:file|search|news|image|video)\d+"#,
          options: [.regularExpression, .caseInsensitive])
      else { continue }
      let anchor = String(block[match])
      let key = anchor.replacingOccurrences(of: "\\ue202", with: "").replacingOccurrences(
        of: "\u{e202}", with: ""
      ).lowercased()
      let url = block.components(separatedBy: .newlines).first(where: { $0.hasPrefix("URL: ") }).map
      { String($0.dropFirst(5)) }
      let label =
        url.flatMap { URL(string: $0)?.host() } ?? block.components(separatedBy: "(").dropFirst()
        .first?.components(separatedBy: ")").first ?? key
      links[key] = (label, url)
    }
  }
  func render(_ text: String) -> String {
    var output = text
    guard
      let regex = try? NSRegularExpression(
        pattern: #"(?:\\ue202|\u{e202})(turn\d+(?:file|search|news|image|video)\d+)"#,
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
      let label = source?.0 ?? key
      output.replaceSubrange(
        range, with: source?.1.map { uncensiaText("[来源·%@](%@)", String(describing: label), String(describing: $0)) } ?? uncensiaText("[来源·%@]", String(describing: label)))
    }
    return output.replacingOccurrences(
      of: #"\\ue20[0134]|[\u{e200}\u{e201}\u{e203}\u{e204}]"#, with: "", options: .regularExpression
    )
  }
}
private struct MarkdownTable: View {
  let rows: [[String]]
  var body: some View {
    ScrollView(.horizontal) {
      Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
        ForEach(Array(rows.enumerated()), id: \.offset) { row, cells in
          GridRow {
            ForEach(Array(cells.enumerated()), id: \.offset) { _, cell in
              Text(cell).font(row == 0 ? .caption.bold() : .caption).padding(7).frame(
                minWidth: 90, alignment: .leading
              ).overlay { Rectangle().stroke(.secondary.opacity(0.25)) }
            }
          }
        }
      }.padding(.vertical, 2)
    }
  }
}
private struct MarkdownBlock: Identifiable {
  enum Kind {
    case prose(String)
    case code(String, String)
    case table([[String]])
    case image(String, String)
  }
  let id: Int
  let kind: Kind
  static func parse(_ text: String) -> [Self] {
    var result: [Self] = []
    var prose: [String] = []
    var code: [String] = []
    var language = ""
    var inCode = false
    func flush() {
      guard !prose.isEmpty else { return }
      let joined = prose.joined(separator: "\n")
      if let match = joined.wholeMatch(
        of: /^!\[([^\]]*)\]\((?:image:\/\/|\/images\/)(img_[A-Za-z0-9_-]+)(?:\?[^)]*)?\)$/)
      {
        result.append(.init(id: result.count, kind: .image(String(match.2), String(match.1))))
        prose = []
        return
      }
      let lines = joined.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
      if lines.count >= 2, lines[0].contains("|"),
        lines[1].replacingOccurrences(of: "|", with: "").trimmingCharacters(
          in: CharacterSet(charactersIn: "-: ")
        ).isEmpty
      {
        result.append(
          .init(
            id: result.count,
            kind: .table(
              lines.filter { $0.contains("|") }.enumerated().compactMap { index, line in
                index == 1
                  ? nil
                  : line.split(separator: "|", omittingEmptySubsequences: true).map {
                    $0.trimmingCharacters(in: .whitespaces)
                  }
              })))
      } else {
        result.append(.init(id: result.count, kind: .prose(joined)))
      }
      prose = []
    }
    for line in text.components(separatedBy: .newlines) {
      if line.hasPrefix("```") {
        if inCode {
          result.append(
            .init(id: result.count, kind: .code(language, code.joined(separator: "\n"))))
          code = []
          language = ""
        } else {
          flush()
          language = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
        }
        inCode.toggle()
      } else if inCode {
        code.append(line)
      } else {
        prose.append(line)
      }
    }
    if inCode {
      result.append(.init(id: result.count, kind: .code(language, code.joined(separator: "\n"))))
    }
    flush()
    return result
  }
}

private struct AuthenticatedTranscriptImage: View {
  let path: String
  let api: APIClient?
  @State private var image: Image?
  var body: some View {
    Group {
      if let image {
        image.resizable().scaledToFit()
      } else {
        Rectangle().fill(.quaternary).overlay { ProgressView() }
      }
    }
    .task(id: path) {
      guard let data = try? await api?.download(path), let ui = UIImage(data: data) else { return }
      image = Image(uiImage: ui)
    }
  }
}
private struct TranscriptPreview: Identifiable {
  enum Kind: Equatable { case image, video, document, file }
  let id: String
  let name: String
  let kind: Kind
}
private struct TranscriptMediaViewer: View {
  let item: TranscriptPreview
  let api: APIClient?
  @Environment(\.dismiss) var dismiss
  @State private var url: URL?
  @State private var error: String?
  var body: some View {
    NavigationStack {
      Group {
        if let url {
          TranscriptQuickLook(url: url)
        } else if let error {
          ContentUnavailableView(
            uncensiaText("无法打开"), systemImage: "exclamationmark.triangle", description: Text(error))
        } else {
          ProgressView(uncensiaText("正在读取…"))
        }
      }.navigationTitle(item.name).toolbar {
        ToolbarItem(placement: .cancellationAction) { Button(uncensiaText("完成")) { dismiss() } }
        if let url {
          ToolbarItemGroup(placement: .primaryAction) {
            if item.kind == .image || item.kind == .video {
              NavigationLink {
                TranscriptProvenance(assetID: item.id, kind: item.kind, api: api)
              } label: {
                Image(systemName: "info.circle")
              }
            }
            ShareLink(item: url) { Image(systemName: "square.and.arrow.up") }
          }
        }
      }.task {
        guard let api else { return }
        do {
          let path =
            item.kind == .image
            ? "/images/\(item.id)"
            : item.kind == .video ? "/videos/\(item.id)" : "/files/\(item.id)/content"
          let data = try await api.download(path)
          let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            "uncensia-transcript-\(UUID().uuidString)", isDirectory: true)
          try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
          let target = directory.appendingPathComponent(item.name)
          try data.write(to: target, options: .atomic)
          url = target
        } catch let caught { error = caught.localizedDescription }
      }.onDisappear {
        if let url { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
      }
    }
  }
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
  func updateUIViewController(_ uiViewController: QLPreviewController, context: Context) {}
  final class Coordinator: NSObject, QLPreviewControllerDataSource {
    let url: URL
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
