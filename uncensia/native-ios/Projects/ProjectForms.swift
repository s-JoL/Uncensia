import SwiftUI

struct ProjectEditor: View {
  @Environment(\.dismiss) private var dismiss
  @State var draft: ProjectDraft
  let api: APIClient?
  let onSaved: @MainActor () async -> Void
  @State private var saving = false
  @State private var error: String?

  var body: some View {
    NavigationStack {
      Form {
        TextField(uncensiaText("项目名称"), text: $draft.title)
          .accessibilityIdentifier("project.title")
        Section {
          TextEditor(text: $draft.instructions).frame(minHeight: 220)
            .accessibilityIdentifier("project.instructions")
        } header: {
          Text(uncensiaText("项目说明"))
        } footer: {
          Text(uncensiaText("填写长期目标、背景和工作约定。修改后在下一次模型请求生效。"))
        }
        if let error { Text(error).foregroundStyle(.red) }
      }
      .navigationTitle(draft.project == nil ? uncensiaText("新建项目") : uncensiaText("编辑项目"))
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button(uncensiaText("取消")) { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button(uncensiaText("保存")) { Task { await save() } }
            .disabled(saving || draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityIdentifier("project.save")
        }
      }
    }
  }

  private func save() async {
    guard let api else { error = uncensiaText("请先连接服务器。"); return }
    saving = true
    defer { saving = false }
    var body: [String: JSONValue] = [
      "title": .string(draft.title.trimmingCharacters(in: .whitespacesAndNewlines)),
      "instructions": .string(draft.instructions),
    ]
    if let project = draft.project { body["revision"] = .integer(project.revision) }
    let method = draft.project == nil ? "POST" : "PATCH"
    let path = draft.project.map { "/projects/\(urlPart($0.id))" } ?? "/projects"
    do {
      _ = try await api.request(method, path, body: .object(body))
      await onSaved()
      dismiss()
    } catch { self.error = error.localizedDescription }
  }
}

struct ProjectFilePicker: View {
  @Environment(\.dismiss) private var dismiss
  let projectID: String
  let api: APIClient?
  let onLinked: @MainActor () async -> Void
  @State private var files: [LibraryFile] = []
  @State private var query = ""
  @State private var total = 0
  @State private var loading = true
  @State private var error: String?
  @State private var loadRevision = UUID()

  var body: some View {
    NavigationStack {
      List {
        if let error { Text(error).foregroundStyle(.red) }
        ForEach(files) { file in
          Button { Task { await link(file) } } label: {
            VStack(alignment: .leading) {
              Text(file.name)
              Text("\(file.byteLabel) · \(file.source)").font(.caption).foregroundStyle(.secondary)
            }
          }.disabled(loading)
        }
        if files.count < total {
          Button(uncensiaText("加载更多")) { Task { await load(reset: false) } }.disabled(loading)
        }
      }
      .overlay { if loading && files.isEmpty { ProgressView() } }
      .searchable(text: $query, prompt: uncensiaText("按文件名筛选"))
      .navigationTitle(uncensiaText("从资料库引用"))
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button(uncensiaText("取消")) { dismiss() } } }
      .task(id: query) {
        do { try await Task.sleep(for: .milliseconds(150)) } catch { return }
        await load(reset: true)
      }
    }
  }

  private func load(reset: Bool) async {
    guard let api else { error = uncensiaText("请先连接服务器。"); loading = false; return }
    if reset { loadRevision = UUID() }
    let revision = loadRevision
    let requestedQuery = query
    loading = true
    defer { if loadRevision == revision { loading = false } }
    do {
      let offset = reset ? 0 : files.count
      let result = try await api.request("GET", "/files?limit=48&offset=\(offset)&q=\(urlPart(requestedQuery))")
      guard !Task.isCancelled, loadRevision == revision, query == requestedQuery else { return }
      let incoming = result["items"].arrayValue?.map { LibraryFile(raw: $0) } ?? []
      if reset { files = incoming } else {
        let known = Set(files.map(\.id)); files += incoming.filter { !known.contains($0.id) }
      }
      total = result["total"].intValue ?? files.count
      error = nil
    } catch { self.error = error.localizedDescription }
  }

  private func link(_ file: LibraryFile) async {
    guard let api else { return }
    loading = true
    defer { loading = false }
    do {
      _ = try await api.request("PUT", "/projects/\(urlPart(projectID))/files/\(urlPart(file.id))")
      await onLinked()
      dismiss()
    } catch { self.error = error.localizedDescription }
  }
}
