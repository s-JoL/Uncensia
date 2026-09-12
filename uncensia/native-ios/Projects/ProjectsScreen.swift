import SwiftUI

struct ProjectRecord: Identifiable, Equatable {
  let raw: JSONValue
  var id: String { raw["id"].stringValue ?? "" }
  var title: String { raw["title"].stringValue ?? uncensiaText("未命名项目") }
  var instructions: String { raw["instructions"].stringValue ?? "" }
  var revision: Int { raw["revision"].intValue ?? 0 }
}

struct ProjectDraft: Identifiable {
  let id = UUID()
  let project: ProjectRecord?
  var title: String
  var instructions: String

  init(_ project: ProjectRecord? = nil) {
    self.project = project
    title = project?.title ?? ""
    instructions = project?.instructions ?? ""
  }
}

struct ProjectsScreen: View {
  @Environment(AppModel.self) private var app
  @State private var projects: [ProjectRecord] = []
  @State private var loading = true
  @State private var error: String?
  @State private var editing: ProjectDraft?

  var body: some View {
    NavigationStack {
      Group {
        if loading && projects.isEmpty {
          ProgressView(uncensiaText("正在加载项目…"))
        } else if let error, projects.isEmpty {
          ContentUnavailableView(uncensiaText("项目不可用"), image: "lucide-cloud-alert", description: Text(error))
        } else if projects.isEmpty {
          ContentUnavailableView(uncensiaText("暂无项目"), image: "lucide-folder-closed",
            description: Text(uncensiaText("将说明、参考资料和相关对话保存在一起。")))
        } else {
          List(projects) { project in
            NavigationLink {
              ProjectDetailScreen(project: project) { await load() }
            } label: {
              VStack(alignment: .leading, spacing: 5) {
                Text(project.title).font(.headline)
                Text(project.instructions.isEmpty ? uncensiaText("尚未填写项目说明") : project.instructions)
                  .font(.subheadline).foregroundStyle(.secondary).lineLimit(3)
              }.padding(.vertical, 4)
            }.accessibilityIdentifier("project.open.\(project.id)")
          }.refreshable { await load() }
        }
      }
      .navigationTitle(uncensiaText("项目"))
      .toolbar {
        ToolbarItem(placement: .primaryAction) {
          Button { editing = ProjectDraft() } label: { Label(uncensiaText("新建项目"), image: "lucide-folder-closed") }
            .accessibilityIdentifier("project.create")
        }
      }
      .task { await load() }
      .sheet(item: $editing) { draft in
        ProjectEditor(draft: draft, api: app.api) { await load() }
      }
    }
  }

  private func load() async {
    guard let api = app.api else { error = uncensiaText("请先连接服务器。"); loading = false; return }
    loading = true
    defer { loading = false }
    do {
      projects = try await api.request("GET", "/projects").arrayValue?.map(ProjectRecord.init) ?? []
      error = nil
    } catch { self.error = error.localizedDescription }
  }
}

struct ProjectDetailScreen: View {
  @Environment(AppModel.self) private var app
  @State var project: ProjectRecord
  let onChanged: @MainActor () async -> Void
  @State private var files: [LibraryFile] = []
  @State private var conversations: [Conversation] = []
  @State private var cursor: String?
  @State private var loading = true
  @State private var busy = false
  @State private var error: String?
  @State private var editing: ProjectDraft?
  @State private var picking = false
  @State private var preview: LibraryFile?

  var body: some View {
    List {
      if let error { Text(error).foregroundStyle(.red) }
      Section(uncensiaText("项目说明")) {
        Text(project.instructions.isEmpty ? uncensiaText("尚未填写项目说明") : project.instructions)
          .textSelection(.enabled)
      }
      Section {
        Text(uncensiaText("对话中新导入和生成的文件会自动加入。移除只解除关联，原件仍在资料库。"))
          .font(.caption).foregroundStyle(.secondary)
        ForEach(files) { file in
          HStack {
            Button { preview = file } label: {
              VStack(alignment: .leading) {
                Text(file.name).lineLimit(1)
                Text("\(file.byteLabel) · \(file.source)").font(.caption).foregroundStyle(.secondary)
              }.frame(maxWidth: .infinity, alignment: .leading)
            }.buttonStyle(.plain)
            Button(uncensiaText("移除关联"), role: .destructive) { Task { await unlink(file) } }
              .disabled(busy)
          }.buttonStyle(.borderless)
        }
        if files.isEmpty && !loading { Text(uncensiaText("尚未添加资料")).foregroundStyle(.secondary) }
        if cursor != nil {
          Button(uncensiaText("加载更多")) { Task { await loadFiles(reset: false) } }.disabled(busy)
        }
        Button(uncensiaText("从资料库引用")) { picking = true }.disabled(busy)
          .accessibilityIdentifier("project.addFile")
      } header: { Text(uncensiaText("项目资料")) }

      Section {
        ForEach(conversations) { conversation in
          Button(conversation.title) { open(conversation.id) }
        }
        if conversations.isEmpty && !loading { Text(uncensiaText("暂无对话")).foregroundStyle(.secondary) }
        Button(uncensiaText("新对话")) { Task { await createConversation() } }.disabled(busy)
          .accessibilityIdentifier("project.newConversation")
      } header: { Text(uncensiaText("项目对话")) }
    }
    .navigationTitle(project.title)
    .toolbar {
      ToolbarItem(placement: .primaryAction) {
        Button(uncensiaText("编辑项目")) { editing = ProjectDraft(project) }
      }
    }
    .refreshable { await load() }
    .task { await load() }
    .sheet(item: $editing) { draft in
      ProjectEditor(draft: draft, api: app.api) {
        await load()
        await onChanged()
      }
    }
    .sheet(isPresented: $picking) { ProjectFilePicker(projectID: project.id, api: app.api) { await loadFiles(reset: true) } }
    .sheet(item: $preview) { LibraryPreview(file: $0, api: app.api) }
  }

  private func load() async {
    guard let api = app.api else { error = uncensiaText("请先连接服务器。"); loading = false; return }
    loading = true
    defer { loading = false }
    do {
      async let updated = api.request("GET", "/projects/\(urlPart(project.id))")
      async let chats = api.request("GET", "/projects/\(urlPart(project.id))/conversations")
      let (projectValue, chatValue) = try await (updated, chats)
      project = ProjectRecord(raw: projectValue)
      conversations = chatValue.arrayValue?.compactMap(Conversation.init) ?? []
      error = nil
      await loadFiles(reset: true)
    } catch { self.error = error.localizedDescription }
  }

  private func loadFiles(reset: Bool) async {
    guard let api = app.api, reset || cursor != nil else { return }
    busy = true
    defer { busy = false }
    do {
      let suffix = reset ? "" : "?cursor=\(urlPart(cursor ?? ""))"
      let page = try await api.request("GET", "/projects/\(urlPart(project.id))/files\(suffix)")
      let incoming = page["items"].arrayValue?.map { LibraryFile(raw: $0) } ?? []
      if reset { files = incoming } else {
        let known = Set(files.map(\.id)); files += incoming.filter { !known.contains($0.id) }
      }
      cursor = page["next_cursor"].stringValue
    } catch { self.error = error.localizedDescription }
  }

  private func unlink(_ file: LibraryFile) async {
    guard let api = app.api else { return }
    busy = true
    defer { busy = false }
    do {
      _ = try await api.request("DELETE", "/projects/\(urlPart(project.id))/files/\(urlPart(file.id))")
      files.removeAll { $0.id == file.id }
    } catch { self.error = error.localizedDescription }
  }

  private func createConversation() async {
    guard let api = app.api else { return }
    busy = true
    defer { busy = false }
    do {
      let model = app.bootstrap["defaultModelId"].stringValue ?? ""
      let created = try await api.request("POST", "/conversations", body: .object([
        "modelId": .string(model), "projectId": .string(project.id),
      ]))
      guard let id = created["id"].stringValue else { return }
      open(id)
    } catch { self.error = error.localizedDescription }
  }

  private func open(_ id: String) {
    app.selectedConversationID = id
    app.selectedTab = "chat"
  }
}
