import SwiftUI

struct TranscriptResourceLink: Identifiable, Equatable {
  enum Kind: String { case file, image, video, quote }
  let kind: Kind
  let assetID: String
  var id: String { "\(kind.rawValue)-\(assetID)" }

  static func resolve(_ url: URL, server: URL?) -> Self? {
    let scheme = url.scheme?.lowercased()
    if let scheme, ["excerpt", "file", "image", "video"].contains(scheme) {
      guard url.path.isEmpty, url.query == nil, url.fragment == nil, let id = url.host else { return nil }
      let prefix = scheme == "excerpt" ? "quote" : scheme == "image" ? "img" : scheme == "video" ? "vid" : "(?:file|img|vid)"
      guard id.range(of: "^\(prefix)_[0-9a-f]{32}$", options: [.regularExpression, .caseInsensitive]) != nil else { return nil }
      return .init(kind: scheme == "excerpt" ? .quote : Kind(rawValue: scheme)!, assetID: id)
    }
    if scheme != nil || url.host != nil {
      guard let server, scheme == server.scheme?.lowercased(), url.host?.lowercased() == server.host?.lowercased(),
        effectivePort(url) == effectivePort(server) else { return nil }
    }
    var path = url.path
    if let server {
      var base = server.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
      if base == "v1" { base = "" }
      else if base.hasSuffix("/v1") { base.removeLast(3) }
      if !base.isEmpty, path.hasPrefix("/\(base)/") { path.removeFirst(base.count + 1) }
      else if !base.isEmpty, scheme != nil { return nil }
    }
    guard let match = path.range(of: #"^/(?:v1/)?files/(?:file|img|vid)_[0-9a-f]{32}/content$"#, options: [.regularExpression, .caseInsensitive]) else { return nil }
    let parts = path[match].split(separator: "/")
    return .init(kind: .file, assetID: String(parts[parts.count - 2]))
  }
  private static func effectivePort(_ url: URL) -> Int? {
    url.port ?? (url.scheme?.lowercased() == "https" ? 443 : url.scheme?.lowercased() == "http" ? 80 : nil)
  }
}

struct ResourceQuoteCard: View {
  let id: String
  let api: APIClient?
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @State private var quote: JSONValue?
  @State private var error: String?
  @State private var attempt = 0
  @State private var copied = false
  @State private var resource: TranscriptResourceLink?

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      if let quote {
        HStack(alignment: .firstTextBaseline) {
          Text(quote["title"].stringValue ?? uncensiaText("来源")).font(.subheadline.weight(.medium)).lineLimit(2)
          Spacer(minLength: 4)
          Text("\(quote["start_line"].intValue ?? 1)–\(quote["end_line"].intValue ?? 1)")
            .font(.caption).foregroundStyle(.secondary).monospacedDigit()
        }.fixedSize(horizontal: false, vertical: true)
        ScrollView {
          Text(quote["text"].stringValue ?? "").textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading).lineSpacing(3)
        }.frame(maxHeight: .infinity)
        HStack(spacing: 18) {
          Button {
            UIPasteboard.general.string = quote["text"].stringValue ?? ""
            copied = true
          } label: { Label(copied ? uncensiaText("已复制") : uncensiaText("复制"), systemImage: copied ? "checkmark" : "doc.on.doc") }
          .accessibilityIdentifier("resource.quote.copy")
          if let fileID = quote["file_id"].stringValue {
            Button { resource = .init(kind: .file, assetID: fileID) } label: {
              Label(uncensiaText("下载"), systemImage: "arrow.down.document")
            }.accessibilityIdentifier("resource.quote.download")
          }
        }.font(.caption).buttonStyle(.borderless).fixedSize(horizontal: false, vertical: true)
      } else if let error {
        VStack(spacing: 12) {
          Text(error).font(.footnote).foregroundStyle(.secondary).lineLimit(5)
          Button(uncensiaText("重试")) { attempt += 1 }
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        ProgressView(uncensiaText("正在读取…")).frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .padding(12).frame(maxWidth: .infinity, alignment: .leading)
    // Loading, loaded and retry states share the same canvas. Only the inner
    // original-text viewport scrolls, so a delayed quote cannot move the reader.
    .frame(height: dynamicTypeSize.isAccessibilitySize ? 280 : 180)
    .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 12))
    .overlay { RoundedRectangle(cornerRadius: 12).stroke(.secondary.opacity(0.18), lineWidth: 0.5) }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("resource.quote.\(id)")
    .task(id: "\(api.map { String(describing: ObjectIdentifier($0)) } ?? "none")-\(id)-\(attempt)") {
      quote = nil; error = nil; copied = false
      guard let api else { error = uncensiaText("无法打开"); return }
      do {
        let result = try await api.request("GET", "/resources/quotes/\(id)")
        guard !Task.isCancelled else { return }
        quote = result
      } catch {
        guard !Task.isCancelled else { return }
        self.error = error.localizedDescription
      }
    }
    .sheet(item: $resource) { TranscriptResourceViewer(resource: $0, api: api) }
  }
}

struct TranscriptResourceViewer: View {
  let resource: TranscriptResourceLink
  let api: APIClient?
  @Environment(\.dismiss) private var dismiss
  @State private var preview: TranscriptPreview?
  @State private var error: String?
  @State private var attempt = 0

  var body: some View {
    Group {
      if resource.kind == .quote {
        NavigationStack {
          ScrollView { ResourceQuoteCard(id: resource.assetID, api: api).id(resource.id).padding() }
            .navigationTitle(uncensiaText("来源")).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(uncensiaText("完成")) { dismiss() } } }
        }
      } else if let preview {
        TranscriptMediaViewer(item: preview, api: api)
      } else {
        NavigationStack {
          VStack(spacing: 12) {
            if let error { Text(error).foregroundStyle(.secondary); Button(uncensiaText("重试")) { attempt += 1 } }
            else { ProgressView(uncensiaText("正在读取…")) }
          }.padding()
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(uncensiaText("完成")) { dismiss() } } }
        }
      }
    }.task(id: "\(resource.id)-\(attempt)") {
      guard resource.kind != .quote else { return }
      error = nil
      guard let api else { error = uncensiaText("无法打开"); return }
      do {
        if resource.kind == .image { preview = .init(id: resource.assetID, name: "\(resource.assetID).png", kind: .image); return }
        if resource.kind == .video { preview = .init(id: resource.assetID, name: "\(resource.assetID).mp4", kind: .video); return }
        let file = try await api.request("GET", "/files/\(resource.assetID)")
        guard !Task.isCancelled else { return }
        preview = .init(id: resource.assetID, name: file["name"].stringValue ?? resource.assetID,
          kind: file["mime"].stringValue == "application/pdf" ? .document : .file)
      } catch {
        guard !Task.isCancelled else { return }
        self.error = error.localizedDescription
      }
    }
  }
}
