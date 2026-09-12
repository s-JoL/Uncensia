import QuickLook
import SwiftUI
import UniformTypeIdentifiers

/// The native library uses the same records and filters as `/files`. It keeps the
/// server as the source of truth; only imported bytes and an open preview are local.
struct LibraryScreen: View {
  @Environment(AppModel.self) private var app
  @State private var store = LibraryWorkspace()
  @State private var importing = false
  @State private var importingURL = false
  @State private var note: LibraryNote?
  @State private var preview: LibraryFile?
  @State private var confirmDelete: LibraryFile?
  @State private var layout: LibraryLayout = .cards

  var body: some View {
    @Bindable var store = store
    NavigationStack {
      Group {
        if store.loading && store.files.isEmpty {
          ProgressView(uncensiaText("正在加载资料库…"))
        } else if let failure = store.failure, store.files.isEmpty {
          ContentUnavailableView(
            uncensiaText("资料库不可用"), image: "lucide-cloud-alert", description: Text(failure)
          )
          .overlay(alignment: .bottom) {
            Button(uncensiaText("重试")) { Task { await store.load(api: app.api, reset: true) } }.buttonStyle(
              .borderedProminent)
          }
        } else {
          libraryContent
        }
      }
      .navigationTitle(uncensiaText("资料库"))
      .toolbar {
        ToolbarItemGroup(placement: .primaryAction) {
          Button {
            note = .new
          } label: {
            Label(uncensiaText("新建笔记"), image: "lucide-square-pen")
          }
          Menu {
            Button(uncensiaText("选取文件"), systemImage: "folder") { importing = true }
            Button(uncensiaText("从链接导入"), systemImage: "link") { importingURL = true }
          } label: {
            Label(uncensiaText("上传"), image: "lucide-share")
          }.accessibilityIdentifier("library.import")
          Menu {
            Picker(uncensiaText("布局"), selection: $layout) {
              Label(uncensiaText("卡片"), image: "lucide-grid-2x2").tag(LibraryLayout.cards)
              Label(uncensiaText("列表"), image: "lucide-list").tag(LibraryLayout.list)
            }
          } label: {
            Image(layout == .cards ? "lucide-grid-2x2" : "lucide-list")
          }
        }
      }
      .searchable(text: $store.nameQuery, prompt: uncensiaText("按文件名筛选"))
      .onSubmit(of: .search) { Task { await store.load(api: app.api, reset: true) } }
      .refreshable { await store.load(api: app.api, reset: true) }
      .task { if store.files.isEmpty { await store.load(api: app.api, reset: true) } }
      .onChange(of: store.kind) { Task { await store.load(api: app.api, reset: true) } }
      .onChange(of: store.source) { Task { await store.load(api: app.api, reset: true) } }
      .fileImporter(
        isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true
      ) { result in
        Task { await store.importFiles(result, api: app.api) }
      }
      .sheet(item: $note) { value in
        NoteEditor(note: value) { edited in await store.save(edited, api: app.api) }
      }
      .sheet(isPresented: $importingURL) {
        ResourceImportSheet(api: app.api) { _ in await store.load(api: app.api, reset: true) }
      }
      .sheet(item: $preview) { file in LibraryPreview(file: file, api: app.api) }
      .alert(
        uncensiaText("删除 %@？", String(describing: confirmDelete?.name ?? "文件")),
        isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } })
      ) {
        Button(uncensiaText("删除"), role: .destructive) {
          if let file = confirmDelete {
            Task { await store.delete(file, api: app.api) }
            confirmDelete = nil
          }
        }
        Button(uncensiaText("取消"), role: .cancel) { confirmDelete = nil }
      } message: {
        Text(uncensiaText("这会删除原文件及其搜索索引。"))
      }
    }
  }

  private var libraryContent: some View {
    @Bindable var store = store
    return ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        DisclosureGroup(uncensiaText("搜索文档内容")) {
          HStack {
            TextField(uncensiaText("关键词或短语"), text: $store.contentQuery).textFieldStyle(.roundedBorder)
              .onSubmit { Task { await store.search(api: app.api) } }
            Button(uncensiaText("搜索")) { Task { await store.search(api: app.api) } }.buttonStyle(
              .borderedProminent)
          }
          Picker(uncensiaText("模式"), selection: $store.searchMode) {
            Text(uncensiaText("混合")).tag("hybrid")
            Text(uncensiaText("语义")).tag("semantic")
            Text(uncensiaText("关键词")).tag("keyword")
          }.pickerStyle(.segmented)
          ForEach(store.hits) { hit in
            VStack(alignment: .leading, spacing: 5) {
              HStack {
                Text(hit.name).font(.headline)
                Spacer()
                Text(hit.matchType).font(.caption).foregroundStyle(.secondary)
              }
              Text(hit.excerpt).lineLimit(5).font(.subheadline).foregroundStyle(.secondary)
              Text(
                [hit.page.map { uncensiaText("第 %@ 页", String(describing: $0)) }, hit.chunk.map { uncensiaText("片段 %@", String(describing: $0)) }].compactMap { $0 }
                  .joined(separator: " · ")
              ).font(.caption2)
            }.padding(12).background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
          }
        }.padding(14).background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))

        Picker(uncensiaText("类型"), selection: $store.kind) {
          Text(uncensiaText("全部")).tag("all")
          Text(uncensiaText("文档")).tag("docs")
          Text(uncensiaText("图片")).tag("images")
          Text(uncensiaText("视频")).tag("videos")
        }.pickerStyle(.segmented)
        if !store.sources.isEmpty {
          ScrollView(.horizontal) {
            HStack {
              sourceButton(uncensiaText("全部"), id: "all")
              ForEach(store.sources, id: \.id) { sourceButton("\($0.id)  \($0.count)", id: $0.id) }
            }
          }.scrollIndicators(.hidden)
        }
        Text(uncensiaText("共 %@ 项", String(describing: store.total))).font(.subheadline).foregroundStyle(.secondary)
        if layout == .cards {
          LazyVGrid(columns: [GridItem(.adaptive(minimum: 155), spacing: 12)], spacing: 12) {
            ForEach(store.files) { card($0) }
          }
        } else {
          LazyVStack(spacing: 8) { ForEach(store.files) { row($0) } }
        }
        if store.files.count < store.total {
          Button(uncensiaText("加载更多（%@/%@）", String(describing: store.files.count), String(describing: store.total))) {
            Task { await store.load(api: app.api, reset: false) }
          }.buttonStyle(.bordered).frame(maxWidth: .infinity)
        }
        if let failure = store.failure { Text(failure).font(.caption).foregroundStyle(.red) }
      }.padding()
    }
  }

  private func sourceButton(_ title: String, id: String) -> some View {
    Button(title) { store.source = id }.buttonStyle(.bordered).tint(
      store.source == id ? .accentColor : .secondary)
  }

  private func card(_ file: LibraryFile) -> some View {
    VStack(alignment: .leading, spacing: 9) {
      Button {
        open(file)
      } label: {
        LibraryThumbnail(file: file, api: app.api).frame(height: 120).frame(maxWidth: .infinity)
          .background(.quaternary).clipShape(RoundedRectangle(cornerRadius: 11))
      }.accessibilityIdentifier("library.open.\(file.id)")
      Text(file.name).font(.headline).lineLimit(1)
      Text("\(file.byteLabel) · \(file.source)").font(.caption).foregroundStyle(.secondary)
        .lineLimit(1)
      HStack {
        attachButton(file)
        Spacer()
        actions(file)
      }
    }.padding(10).background(.background, in: RoundedRectangle(cornerRadius: 15)).overlay {
      RoundedRectangle(cornerRadius: 15).stroke(.secondary.opacity(0.25))
    }
  }

  private func row(_ file: LibraryFile) -> some View {
    HStack(spacing: 11) {
      LibraryThumbnail(file: file, api: app.api).frame(width: 54, height: 54).clipShape(
        RoundedRectangle(cornerRadius: 9)
      ).onTapGesture { open(file) }
      VStack(alignment: .leading) {
        Text(file.name).lineLimit(1)
        Text("\(file.byteLabel) · \(file.source) · \(file.embeddingStatus)").font(.caption)
          .foregroundStyle(.secondary)
      }
      Spacer()
      attachButton(file)
      actions(file)
    }.padding(10).background(.background, in: RoundedRectangle(cornerRadius: 13))
  }

  private func attachButton(_ file: LibraryFile) -> some View {
    Menu {
      Button(uncensiaText("作为上下文添加")) { attach(file, role: "context") }
      if file.isImage { Button(uncensiaText("编辑这张图片")) { attach(file, role: "base") } }
    } label: {
      Image("lucide-message-square-plus")
    }.accessibilityIdentifier("library.attach.\(file.id)")
  }

  private func actions(_ file: LibraryFile) -> some View {
    Menu {
      Button(uncensiaText("打开")) { open(file) }
      if file.editable {
        Button(uncensiaText("编辑笔记")) { Task { note = await store.note(for: file, api: app.api) } }
      }
      if !file.visual { Button(uncensiaText("重新索引")) { Task { await store.reindex(file, api: app.api) } } }
      Button(uncensiaText("删除"), role: .destructive) { confirmDelete = file }
    } label: {
      Image("lucide-ellipsis")
    }
  }

  private func open(_ file: LibraryFile) { preview = file }
  private func attach(_ file: LibraryFile, role: String) {
    app.startNewChat(attachments: [.object(["file": file.raw, "role": .string(role)])])
  }
}

private enum LibraryLayout: String { case cards, list }

struct LibraryFile: Identifiable {
  let raw: JSONValue
  var id: String { raw["id"].stringValue ?? "" }
  var name: String { raw["name"].stringValue ?? id }
  var mime: String { raw["mime"].stringValue ?? "application/octet-stream" }
  var source: String { raw["source"].stringValue ?? uncensiaText("未知来源") }
  var bytes: Double { raw["bytes"].doubleValue ?? 0 }
  var embeddingStatus: String {
    switch raw["embeddingStatus"].stringValue ?? "none" {
    case "ready": return uncensiaText("已索引")
    case "pending": return uncensiaText("等待索引")
    case "failed": return uncensiaText("索引失败")
    default: return uncensiaText("未索引")
    }
  }
  var isImage: Bool { mime.hasPrefix("image/") }
  var isVideo: Bool { mime.hasPrefix("video/") }
  var visual: Bool { isImage || isVideo }
  var editable: Bool { mime.hasPrefix("text/") || mime == "application/json" }
  var byteLabel: String {
    ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
  }
}

private struct LibraryHit: Identifiable {
  let raw: JSONValue
  let fallbackID = UUID().uuidString
  var id: String { raw["chunkId"].stringValue ?? fallbackID }
  var name: String { raw["name"].stringValue ?? uncensiaText("文档") }
  var excerpt: String { raw["excerpt"].stringValue ?? "" }
  var matchType: String { raw["matchType"].stringValue ?? "" }
  var page: Int? { raw["page"].doubleValue.map(Int.init) }
  var chunk: Int? { raw["chunk"].doubleValue.map(Int.init) }
}
private struct LibrarySource {
  let id: String
  let count: Int
}

@MainActor @Observable private final class LibraryWorkspace {
  var files: [LibraryFile] = []
  var hits: [LibraryHit] = []
  var total = 0
  var loading = false
  var failure: String?
  var kind = "all"
  var source = "all"
  var nameQuery = ""
  var contentQuery = ""
  var searchMode = "hybrid"
  var sources: [LibrarySource] = []
  private let pageSize = 60
  private var loadRevision = UUID()
  private var searchRevision = UUID()
  func load(api: APIClient?, reset: Bool) async {
    guard let api else {
      failure = uncensiaText("请先连接服务器。")
      return
    }
    // A newer filter owns the list immediately, even if an older response is
    // still in flight. Repeated pagination taps share the one active request.
    guard reset || !loading else { return }
    let request = UUID()
    loadRevision = request
    let requestedKind = kind, requestedSource = source, requestedName = nameQuery
    func ownsRequest() -> Bool {
      loadRevision == request && kind == requestedKind && source == requestedSource && nameQuery == requestedName
    }
    loading = true
    defer { if loadRevision == request { loading = false } }
    let offset = reset ? 0 : files.count
    var components = URLComponents()
    components.queryItems = [
      URLQueryItem(name: "kind", value: requestedKind), URLQueryItem(name: "source", value: requestedSource),
      URLQueryItem(name: "q", value: requestedName),
      URLQueryItem(name: "limit", value: String(pageSize)),
      URLQueryItem(name: "offset", value: String(offset)),
    ]
    do {
      let response = try await api.request("GET", "/files?\(components.percentEncodedQuery ?? "")")
      guard !Task.isCancelled, ownsRequest() else { return }
      let page = response["items"].arrayValue?.map(LibraryFile.init) ?? []
      let existing = Set(files.map(\.id))
      files = reset ? page : files + page.filter { !existing.contains($0.id) }
      total = Int(response["total"].doubleValue ?? 0)
      sources =
        response["facets"]["sources"].arrayValue?.compactMap { value in
          guard let id = value["id"].stringValue else { return nil }
          return LibrarySource(id: id, count: Int(value["count"].doubleValue ?? 0))
        } ?? []
      failure = nil
    } catch {
      if !Task.isCancelled, ownsRequest() { failure = error.localizedDescription }
    }
  }
  func search(api: APIClient?) async {
    let request = UUID()
    searchRevision = request
    let requestedQuery = contentQuery, requestedMode = searchMode
    func ownsRequest() -> Bool {
      searchRevision == request && contentQuery == requestedQuery && searchMode == requestedMode
    }
    guard let api, !requestedQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      hits = []
      return
    }
    do {
      let value = try await api.request(
        "POST", "/files/search",
        body: .object([
          "query": .string(requestedQuery), "mode": .string(requestedMode), "limit": .number(20),
        ]))
      guard !Task.isCancelled, ownsRequest() else { return }
      hits = value["results"].arrayValue?.map(LibraryHit.init) ?? []
      failure = nil
    } catch {
      if !Task.isCancelled, ownsRequest() { failure = error.localizedDescription }
    }
  }
  func importFiles(_ result: Result<[URL], Error>, api: APIClient?) async {
    guard let api else {
      failure = uncensiaText("请先连接服务器。")
      return
    }
    do {
      for url in try result.get() {
        let data = try await Task.detached(priority: .userInitiated) {
          let scoped = url.startAccessingSecurityScopedResource()
          defer { if scoped { url.stopAccessingSecurityScopedResource() } }
          return try Data(contentsOf: url, options: .mappedIfSafe)
        }.value
        try Task.checkCancellation()
        _ = try await api.upload(
          data: data, filename: url.lastPathComponent,
          mimeType: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
            ?? "application/octet-stream")
      }
      await load(api: api, reset: true)
    } catch { failure = error.localizedDescription }
  }
  func delete(_ file: LibraryFile, api: APIClient?) async {
    guard let api else {
      failure = uncensiaText("请先连接服务器。")
      return
    }
    do {
      _ = try await api.request("DELETE", "/files/\(file.id)")
      await load(api: api, reset: true)
    } catch { failure = error.localizedDescription }
  }
  func reindex(_ file: LibraryFile, api: APIClient?) async {
    guard let api else {
      failure = uncensiaText("请先连接服务器。")
      return
    }
    do {
      _ = try await api.request("POST", "/files/\(file.id)/reindex")
      await load(api: api, reset: true)
    } catch { failure = error.localizedDescription }
  }
  func note(for file: LibraryFile, api: APIClient?) async -> LibraryNote? {
    do {
      guard let api else {
        failure = uncensiaText("请先连接服务器。")
        return nil
      }
      let value = try await api.request("GET", "/files/\(file.id)/text")
      return LibraryNote(
        id: file.id, name: value["name"].stringValue ?? file.name,
        text: value["text"].stringValue ?? "")
    } catch {
      failure = error.localizedDescription
      return nil
    }
  }
  func save(_ note: LibraryNote, api: APIClient?) async -> Bool {
    guard let api else {
      failure = uncensiaText("请先连接服务器。")
      return false
    }
    do {
      let body: JSONValue = .object(["name": .string(note.name), "text": .string(note.text)])
      _ = try await api.request(
        note.id.isEmpty ? "POST" : "PUT",
        note.id.isEmpty ? "/files/notes" : "/files/\(note.id)/text", body: body)
      await load(api: api, reset: true)
      return true
    } catch {
      failure = error.localizedDescription
      return false
    }
  }
}

private struct LibraryNote: Identifiable {
  var id: String
  var name: String
  var text: String
  static let new = LibraryNote(id: "", name: "", text: "")
}
private struct NoteEditor: View {
  @Environment(\.dismiss) var dismiss
  @State var note: LibraryNote
  let save: (LibraryNote) async -> Bool
  @State private var saving = false
  var body: some View {
    NavigationStack {
      Form {
        TextField(uncensiaText("文件名"), text: $note.name)
        TextEditor(text: $note.text).frame(minHeight: 320)
      }.navigationTitle(note.id.isEmpty ? uncensiaText("新建笔记") : uncensiaText("编辑笔记")).toolbar {
        ToolbarItem(placement: .cancellationAction) { Button(uncensiaText("取消")) { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button(uncensiaText("保存")) {
            saving = true
            Task {
              if await save(note) { dismiss() }
              saving = false
            }
          }.disabled(note.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || saving)
        }
      }
    }
  }
}

private struct LibraryThumbnail: View {
  let file: LibraryFile
  let api: APIClient?
  @State private var image: Image?
  var body: some View {
    Group {
      if let image {
        image.resizable().scaledToFill()
      } else {
        Image(file.isVideo ? "lucide-clapperboard" : file.isImage ? "lucide-image" : "lucide-file-text")
          .font(.title).foregroundStyle(.secondary)
      }
    }.task(id: file.id) {
      guard file.isImage, let data = try? await api?.download("/images/\(file.id)?w=320"),
        let ui = UIImage(data: data)
      else { return }
      image = Image(uiImage: ui)
    }
  }
}

struct LibraryPreview: View {
  let file: LibraryFile
  let api: APIClient?
  @Environment(\.dismiss) var dismiss
  @State private var localURL: URL?
  @State private var failure: String?
  @State private var showReader = false
  var body: some View {
    NavigationStack {
      Group {
        if let localURL {
          QuickLookView(url: localURL)
        } else if let failure {
          ContentUnavailableView(
            uncensiaText("无法打开"), image: "lucide-triangle-alert", description: Text(failure))
        } else {
          ProgressView(uncensiaText("正在下载…"))
        }
      }.navigationTitle(file.name).navigationBarTitleDisplayMode(.inline).toolbar {
        ToolbarItem(placement: .cancellationAction) { Button(uncensiaText("完成")) { dismiss() } }
        ToolbarItem(placement: .primaryAction) {
          Button { showReader = true } label: { Image(systemName: "text.book.closed") }
            .accessibilityLabel(uncensiaText("来源与正文"))
            .accessibilityIdentifier("library.resourceReader")
        }
        if let localURL {
          ToolbarItem(placement: .primaryAction) {
            ShareLink(item: localURL) { Image("lucide-share") }
          }
        }
      }.sheet(isPresented: $showReader) {
        ResourceReaderSheet(fileID: file.id, title: file.name, media: file.visual, api: api)
      }.task {
        guard let api else {
          failure = uncensiaText("请先连接服务器。")
          return
        }
        do {
          let path =
            file.visual
            ? (file.isVideo ? "/videos/\(file.id)" : "/images/\(file.id)")
            : "/files/\(file.id)/content"
          let data = try await api.download(path)
          let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            "uncensia-preview-\(UUID().uuidString)", isDirectory: true)
          try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
          let url = directory.appendingPathComponent(file.name.isEmpty ? file.id : file.name)
          try data.write(to: url, options: .atomic)
          localURL = url
        } catch { failure = error.localizedDescription }
      }.onDisappear {
        if let localURL {
          try? FileManager.default.removeItem(at: localURL.deletingLastPathComponent())
        }
      }
    }
  }
}
private struct QuickLookView: UIViewControllerRepresentable {
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
