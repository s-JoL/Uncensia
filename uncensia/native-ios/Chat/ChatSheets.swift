import SwiftUI
import UniformTypeIdentifiers

struct ConversationList: View {
  let store: ChatStore
  let app: AppModel
  var onClose: () -> Void
  private func dismiss() { onClose() }
  @State private var query = ""
  @State private var hits: [JSONValue] = []

  @State private var busy = false
  @State private var error: String?
  @State private var deleting: Conversation?
  var body: some View {
    NavigationStack {
      List {
        Button {
          app.selectedConversationID = nil
          dismiss()
        } label: {
          Label(uncensiaText("新对话"), image: "lucide-square-pen")
        }.tint(.primary).listRowSeparator(.hidden).accessibilityIdentifier("conversation.new")
        if let error { Text(error).foregroundStyle(.red) }
        if query.trimmingCharacters(in: .whitespaces).isEmpty {
          ForEach(historySections, id: \.title) { section in
            Section(section.title) {
          ForEach(section.items) { item in
            Button {
              open(item.id)
            } label: {
              HStack {
                Text(item.title).foregroundStyle(.primary).lineLimit(1)
                Spacer(minLength: 0)
                if item.id == app.selectedConversationID { Image("lucide-check").foregroundStyle(.secondary) }
              }.padding(.vertical, 6).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }.listRowSeparator(.hidden)
             .listRowBackground(item.id == app.selectedConversationID ? Color.primary.opacity(0.06) : Color.clear)
             .accessibilityIdentifier("conversation.row.\(item.id)")
             .swipeActions { Button(uncensiaText("删除"), role: .destructive) { deleting = item } }
          }
            }
          }
          if store.conversationCursor != nil {
            Button(busy ? uncensiaText("正在载入…") : uncensiaText("载入更多")) { Task { await more() } }.disabled(busy)
          }
        } else if hits.isEmpty && !busy {
          ContentUnavailableView.search(text: query)
        } else {
          ForEach(hits.map(SearchHitRow.init)) { row in
            let hit = row.value
            Button {
              open(hit["conversationId"].stringValue)
            } label: {
              VStack(alignment: .leading, spacing: 4) {
                Text(hit["title"].stringValue ?? uncensiaText("新对话")).foregroundStyle(.primary)
                Text(hit["snippet"].stringValue ?? "").lineLimit(3).foregroundStyle(.secondary)
                Text(roleLabel(hit["role"].stringValue)).font(.caption)
              }
            }
          }
        }
      }.listStyle(.plain).scrollContentBackground(.hidden)
       .searchable(text: $query, prompt: uncensiaText("搜索所有对话正文")).navigationTitle("Uncensia").navigationBarTitleDisplayMode(.inline).toolbar {
        Button(uncensiaText("关闭")) { dismiss() }
      }.task { if let api = app.api { await store.loadConversations(api: api) } }.task(id: query) {
        guard !query.trimmingCharacters(in: .whitespaces).isEmpty else {
          hits = []
          return
        }
        try? await Task.sleep(for: .milliseconds(250))
        if !Task.isCancelled { await search() }
      }.refreshable { await reload() }.confirmationDialog(
        uncensiaText("删除“%@”？", String(describing: deleting?.title ?? "这段对话")),
        isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
      ) {
        Button(uncensiaText("删除对话"), role: .destructive) { if let deleting { Task { await remove(deleting) } } }
        Button(uncensiaText("取消"), role: .cancel) {}
      } message: {
        Text(uncensiaText("消息、分支和相关历史将一并删除。"))
      }
    }
  }
  private func open(_ id: String?) {
    guard let id else { return }
    app.selectedConversationID = id
    dismiss()
  }
  private func reload() async {
    guard let api = app.api else {
      error = uncensiaText("请先连接 Uncensia 服务")
      return
    }
    await store.loadConversations(api: api, force: true)
  }
  private var historySections: [(title: String, items: [Conversation])] {
    let calendar = Calendar.current
    let today = calendar.startOfDay(for: Date())
    let yesterday = calendar.date(byAdding: .day, value: -1, to: today)!
    let week = calendar.date(byAdding: .day, value: -7, to: today)!
    let labels = [uncensiaText("今天"), uncensiaText("昨天"), uncensiaText("过去 7 天"), uncensiaText("更早")]
    var groups = Array(repeating: [Conversation](), count: 4)
    for item in store.conversations {
      let date = Date(timeIntervalSince1970: item.updatedAt / 1000)
      groups[date >= today ? 0 : date >= yesterday ? 1 : date >= week ? 2 : 3].append(item)
    }
    return groups.enumerated().filter { !$0.element.isEmpty }.map { (labels[$0.offset], $0.element) }
  }
  private func more() async {
    guard let api = app.api, let cursor = store.conversationCursor else { return }
    busy = true
    defer { busy = false }
    do {
      let page = try await api.request("GET", "/conversations?limit=30&cursor=\(urlPart(cursor))")
      let old = Set(store.conversations.map(\.id))
      store.conversations += (page["items"].arrayValue?.compactMap(Conversation.init) ?? []).filter
      { !old.contains($0.id) }
      store.conversationCursor = page["nextCursor"].stringValue
      error = nil
    } catch { self.error = error.localizedDescription }
  }
  private func search() async {
    guard let api = app.api else { return }
    busy = true
    defer { busy = false }
    do {
      let requestedQuery = query
      let results = try await api.request("GET", "/conversations/search?q=\(urlPart(requestedQuery))&limit=20")["items"].arrayValue ?? []
      guard !Task.isCancelled, query == requestedQuery else { return }
      hits = results
      error = nil
    } catch { self.error = error.localizedDescription }
  }
  private func remove(_ item: Conversation) async {
    guard let api = app.api else { return }
    do {
      _ = try await api.request("DELETE", "/conversations/\(urlPart(item.id))")
      store.conversations.removeAll { $0.id == item.id }
      if app.selectedConversationID == item.id { app.selectedConversationID = nil }
      deleting = nil
      error = nil
    } catch {
      self.error = error.localizedDescription
      deleting = nil
    }
  }
}

struct ConversationContextSheet: View {
  let details: JSONValue
  let id: String?
  let api: APIClient?
  let store: ChatStore
  @Environment(\.dismiss) private var dismiss
  @State private var role = RoleplayDraft()
  @State private var visual = VisualDraft()
  @State private var source = ""
  @State private var preview: CardPreview?
  @State private var importError: String?
  @State private var importing = false
  @State private var saving = false
  @State private var error: String?
  var body: some View {
    NavigationStack {
      Form {
        if let error { Text(error).foregroundStyle(.red) }
        Section {
          Toggle(uncensiaText("使用保存的故事资料"), isOn: $role.enabled)
        } footer: {
          Text(uncensiaText("需要复用人物、背景或文风时再填写。"))
        }
        if role.enabled {
          cardImport
          field(uncensiaText("角色"), $role.character)
          field(uncensiaText("你的身份"), $role.persona)
          field(uncensiaText("世界设定"), $role.world)
          field(uncensiaText("场景笔记"), $role.scene)
          field(uncensiaText("写作方式"), $role.style)
          field(uncensiaText("示例对白"), $role.examples)
        }
        Section {
          Toggle(uncensiaText("使用固定的图片参考"), isOn: $visual.enabled)
        } footer: {
          Text(uncensiaText("人物、场景和风格锚点最多三项。"))
        }
        if visual.enabled {
          field(uncensiaText("视觉圣经"), $visual.description)
          Section(uncensiaText("上一张成功图片")) {
            if let image = visual.lastImage {
              RemoteImage(id: image, api: api).frame(height: 160).clipShape(.rect(cornerRadius: 10))
              Text(visual.lastPrompt.isEmpty ? uncensiaText("提示词未记录") : visual.lastPrompt).font(.caption)
              if visual.references.count < 3 {
                HStack {
                  Button(uncensiaText("固定主体")) { visual.pin("subject") }
                  Button(uncensiaText("固定场景")) { visual.pin("scene") }
                  Button(uncensiaText("固定风格")) { visual.pin("style") }
                }.font(.caption)
              }
            } else {
              Text(uncensiaText("还没有成功图片"))
            }
          }
          if !visual.references.isEmpty {
            Section(uncensiaText("固定参考（%@/3）", String(describing: visual.references.count))) {
              ForEach(visual.references) { ref in
                HStack {
                  RemoteImage(id: ref.imageID, api: api).frame(width: 48, height: 48).clipShape(
                    .rect(cornerRadius: 5))
                  VStack(alignment: .leading) {
                    Text(ref.label)
                    Text(ref.roleName).font(.caption)
                  }
                  Spacer()
                  Button(uncensiaText("移除"), role: .destructive) {
                    visual.references.removeAll { $0.id == ref.id }
                  }
                }
              }
            }
          }
        }
      }.navigationTitle(uncensiaText("对话设定")).toolbar {
        ToolbarItem(placement: .cancellationAction) { Button(uncensiaText("取消")) { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button(saving ? uncensiaText("正在保存…") : uncensiaText("保存")) { Task { await save() } }.disabled(saving || id == nil)
        }
      }.onAppear {
        role = RoleplayDraft(details["roleplay"])
        visual = VisualDraft(details["visualContinuity"])
      }.fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
        if case .success(let url) = result {
          read(url)
        } else if case .failure(let cause) = result {
          importError = cause.localizedDescription
        }
      }
    }
  }
  private func field(_ title: String, _ text: Binding<String>) -> some View {
    Section(title) { TextField(title, text: text, axis: .vertical).lineLimit(2...12) }
  }
  private var cardImport: some View {
    Section {
      Button(uncensiaText("选择 Character Card V2 JSON")) { importing = true }
      TextField(uncensiaText("也可以粘贴 JSON…"), text: $source, axis: .vertical).lineLimit(4...10).onChange(
        of: source
      ) {
        preview = nil
        importError = nil
      }
      Button(uncensiaText("预览设定")) { parse() }.disabled(source.trimmingCharacters(in: .whitespaces).isEmpty)
      if let importError { Text(importError).foregroundStyle(.red) }
      if let preview {
        Text(preview.name).font(.headline)
        previewRow(uncensiaText("角色"), preview.character)
        previewRow(uncensiaText("场景"), preview.scene)
        previewRow(uncensiaText("示例对白"), preview.examples)
        if !preview.notes.isEmpty { DisclosureGroup(uncensiaText("作者说明（不用于生成）")) { Text(preview.notes) } }
        ForEach(preview.notices, id: \.self) {
          Label($0, image: "lucide-info").font(.caption)
        }
        Button(uncensiaText("替换角色、场景与示例草稿")) {
          role.character = preview.character
          role.scene = preview.scene
          role.examples = preview.examples
        }
      }
    } header: {
      Text(uncensiaText("从角色卡导入设定"))
    } footer: {
      Text(uncensiaText("PNG、自动开场、世界书、卡片专属提示和扩展字段不会应用。你的身份、世界设定和写作方式保持原值。"))
    }
  }
  private func previewRow(_ label: String, _ value: String) -> some View {
    VStack(alignment: .leading) {
      Text(label).font(.caption).foregroundStyle(.secondary)
      Text(value.isEmpty ? uncensiaText("（空）") : value).lineLimit(8)
    }
  }
  private func parse() {
    do {
      preview = try CardPreview.parse(source)
      importError = nil
    } catch {
      preview = nil
      importError = error.localizedDescription
    }
  }
  private func read(_ url: URL) {
    guard url.startAccessingSecurityScopedResource() else {
      importError = uncensiaText("无法读取文件")
      return
    }
    defer { url.stopAccessingSecurityScopedResource() }
    do {
      let data = try Data(contentsOf: url)
      guard data.count <= CardPreview.limit else { throw SheetError.message(uncensiaText("角色卡 JSON 最大支持 1 MB")) }
      source = String(decoding: data, as: UTF8.self)
      parse()
    } catch { importError = error.localizedDescription }
  }
  private func save() async {
    guard let id, let api else { return }
    saving = true
    defer { saving = false }
    do {
      let saved = try await api.request(
        "PATCH", "/conversations/\(urlPart(id))",
        body: .object(["roleplay": role.json, "visualContinuity": visual.json]))
      store.conversationDetails = saved
      error = nil
      dismiss()
    } catch { self.error = error.localizedDescription }
  }
}

struct BranchSheet: View {
  let id: String?
  let api: APIClient?
  let app: AppModel
  let store: ChatStore
  @Environment(\.dismiss) private var dismiss
  @State private var tree: JSONValue = .null
  @State private var active: Set<String> = []
  @State private var loading = true
  @State private var busy = false
  @State private var error: String?
  var body: some View {
    NavigationStack {
      List {
        if let error { Text(error).foregroundStyle(.red) }
        if loading { ProgressView() }
        ForEach(entries, id: \.self) { item in
          VStack(alignment: .leading, spacing: 8) {
            HStack {
              Text(label(item)).font(.caption).foregroundStyle(.secondary)
              Spacer()
              Button(uncensiaText("从这里继续")) { Task { await fork(item["id"].stringValue) } }.disabled(busy)
            }
            Text(
              item["preview"].stringValue?.isEmpty == false
                ? item["preview"].stringValue! : uncensiaText("图片、工具调用或空节点")
            ).lineLimit(6)
          }.padding(.vertical, 4)
        }
      }.navigationTitle(uncensiaText("对话版本")).toolbar {
        ToolbarItem(placement: .cancellationAction) { Button(uncensiaText("关闭")) { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button(uncensiaText("从当前版本继续")) { Task { await fork(nil) } }.disabled(busy || loading)
        }
      }.task { await load() }.refreshable { await load() }
    }
  }
  private var entries: [JSONValue] {
    tree["entries"].arrayValue?.filter { $0["role"].stringValue != "toolResult" } ?? []
  }
  private func label(_ item: JSONValue) -> String {
    let state = active.contains(item["id"].stringValue ?? "") ? uncensiaText("当前版本") : uncensiaText("历史版本")
    switch item["type"].stringValue {
    case "message": return "\(item["role"].stringValue == "user" ? "你" : "助手") · \(state)"
    case "compaction": return uncensiaText("上下文摘要 · %@", String(describing: state))
    case "branch_summary": return uncensiaText("分支摘要 · %@", String(describing: state))
    default: return uncensiaText("节点 · %@", String(describing: state))
    }
  }
  private func load() async {
    guard let id, let api else {
      loading = false
      error = uncensiaText("请先打开一段对话")
      return
    }
    loading = true
    defer { loading = false }
    do {
      tree = try await api.request("GET", "/conversations/\(urlPart(id))/tree")
      active = treeActiveIDs(tree)
      error = nil
    } catch { self.error = error.localizedDescription }
  }
  private func fork(_ entry: String?) async {
    guard let id, let api else { return }
    busy = true
    defer { busy = false }
    do {
      let body: JSONValue = entry.map { .object(["entryId": .string($0)]) } ?? .object([:])
      let result = try await api.request("POST", "/conversations/\(urlPart(id))/fork", body: body)
      guard let newID = result["id"].stringValue else { throw SheetError.message(uncensiaText("服务未返回新对话")) }
      await store.loadConversations(api: api)
      app.selectedConversationID = newID
      error = nil
      dismiss()
    } catch { self.error = error.localizedDescription }
  }
}

struct BackgroundTasksSheet: View {
  let id: String?
  let api: APIClient?
  let app: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var tasks: [JSONValue] = []
  @State private var models: [JSONValue] = []
  @State private var prompt = ""
  @State private var scheduled = false
  @State private var runAt = Date()
  @State private var model = ""
  @State private var busy = false
  @State private var cancelling: String?
  @State private var error: String?
  var body: some View {
    NavigationStack {
      List {
        Section(uncensiaText("新任务")) {
          TextField(uncensiaText("稍后要处理的事"), text: $prompt, axis: .vertical).lineLimit(3...8)
          Picker(uncensiaText("模型"), selection: $model) {
            Text(uncensiaText("沿用本对话模型")).tag("")
            ForEach(models, id: \.self) {
              Text($0["name"].stringValue ?? $0["id"].stringValue ?? uncensiaText("模型")).tag(
                $0["id"].stringValue ?? "")
            }
          }
          Toggle(uncensiaText("指定执行时间"), isOn: $scheduled)
          if scheduled {
            DatePicker(
              uncensiaText("执行时间"), selection: $runAt,
              in: Date()...Calendar.current.date(byAdding: .year, value: 1, to: Date())!)
          }
          Button(uncensiaText("创建后台任务")) { Task { await create() } }.disabled(
            busy || prompt.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        if let error { Text(error).foregroundStyle(.red) }
        Section(uncensiaText("这段对话的任务")) {
          if busy { ProgressView() }
          if tasks.isEmpty && !busy { Text(uncensiaText("暂无后台任务")).foregroundStyle(.secondary) }
          ForEach(tasks, id: \.self) { task in
            VStack(alignment: .leading, spacing: 5) {
              Text(task["prompt"].stringValue ?? "")
              Text(
                "\(taskStatus(task["status"].stringValue)) · \(task["modelId"].stringValue ?? "")"
              ).font(.caption)
              if let stamp = task["runAt"].doubleValue {
                Text(
                  Date(timeIntervalSince1970: stamp / 1000),
                  format: .dateTime.year().month().day().hour().minute()
                ).font(.caption)
              }
              if let failure = task["error"].stringValue { Text(failure).foregroundStyle(.red) }
              if task["status"].stringValue == "pending", let taskID = task["id"].stringValue {
                Button(cancelling == taskID ? uncensiaText("正在取消…") : uncensiaText("取消任务"), role: .destructive) {
                  Task { await cancel(taskID) }
                }.disabled(cancelling != nil)
              }
            }.padding(.vertical, 3)
          }
        }
      }.navigationTitle(uncensiaText("后台任务")).toolbar {
        ToolbarItem(placement: .cancellationAction) { Button(uncensiaText("关闭")) { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button(uncensiaText("刷新")) { Task { await load() } }.disabled(busy)
        }
      }.task { await load() }.refreshable { await load() }
    }
  }
  private func load() async {
    guard let id, let api else {
      error = uncensiaText("请先打开一段对话")
      return
    }
    busy = true
    defer { busy = false }
    do {
      async let a = api.request("GET", "/conversations/\(urlPart(id))/background-tasks")
      async let b = api.request("GET", "/models")
      let (x, y) = try await (a, b)
      tasks = x["items"].arrayValue ?? []
      models = (y["items"].arrayValue ?? []).filter {
        $0["kind"].stringValue == "chat" && $0["enabled"].boolValue != false
          && $0["configured"].boolValue != false
      }
      error = nil
    } catch { self.error = error.localizedDescription }
  }
  private func create() async {
    guard let id, let api else { return }
    busy = true
    defer { busy = false }
    var payload: [String: JSONValue] = [
      "prompt": .string(prompt.trimmingCharacters(in: .whitespacesAndNewlines)),
      "runAt": .integer(Int((scheduled ? runAt : Date()).timeIntervalSince1970 * 1000)),
    ]
    if !model.isEmpty { payload["modelId"] = .string(model) }
    do {
      _ = try await api.request(
        "POST", "/conversations/\(urlPart(id))/background-tasks", body: .object(payload))
      prompt = ""
      error = nil
      await load()
    } catch { self.error = error.localizedDescription }
  }
  private func cancel(_ taskID: String) async {
    guard let api else { return }
    cancelling = taskID
    defer { cancelling = nil }
    do {
      _ = try await api.request("DELETE", "/background-tasks/\(urlPart(taskID))")
      error = nil
      await load()
    } catch { self.error = error.localizedDescription }
  }
}

struct RoleplayDraft: Equatable {
  var enabled = false, character = "", persona = "", world = "", scene = "", style = "",
    examples = ""
  init() {}
  init(_ x: JSONValue) {
    enabled = x["enabled"].boolValue ?? false
    character = x["character"].stringValue ?? ""
    persona = x["persona"].stringValue ?? ""
    world = x["world"].stringValue ?? ""
    scene = x["scene"].stringValue ?? ""
    style = x["style"].stringValue ?? ""
    examples = x["examples"].stringValue ?? ""
  }
  var json: JSONValue {
    .object([
      "enabled": .bool(enabled), "character": .string(character), "persona": .string(persona),
      "world": .string(world), "scene": .string(scene), "style": .string(style),
      "examples": .string(examples),
    ])
  }
}

private struct SearchHitRow: Identifiable {
  let value: JSONValue
  var id: String {
    "\(value["conversationId"].stringValue ?? ""):\(value["seq"].intValue ?? -1)"
  }
}
struct VisualRef: Identifiable, Equatable {
  let imageID: String, role: String, label: String
  var id: String { "\(role):\(imageID)" }
  var roleName: String { ["subject": uncensiaText("主体"), "scene": uncensiaText("场景"), "style": uncensiaText("风格")][role] ?? role }
  var json: JSONValue {
    .object(["imageId": .string(imageID), "role": .string(role), "label": .string(label)])
  }
}
struct VisualDraft: Equatable {
  var enabled = false, description = "", lastPrompt = ""
  var references: [VisualRef] = []
  var lastImage: String?
  init() {}
  init(_ x: JSONValue) {
    enabled = x["enabled"].boolValue ?? false
    description = x["description"].stringValue ?? ""
    lastPrompt = x["lastPrompt"].stringValue ?? ""
    lastImage = x["lastImageId"].stringValue
    references = (x["references"].arrayValue ?? []).compactMap {
      guard let i = $0["imageId"].stringValue, let r = $0["role"].stringValue else { return nil }
      return VisualRef(imageID: i, role: r, label: $0["label"].stringValue ?? i)
    }
  }
  mutating func pin(_ r: String) {
    guard let i = lastImage, references.count < 3,
      !references.contains(where: { $0.imageID == i && $0.role == r })
    else { return }
    references.append(
      .init(
        imageID: i, role: r, label: lastPrompt.isEmpty ? uncensiaText("上一张成功图片") : String(lastPrompt.prefix(80))))
  }
  var json: JSONValue {
    .object([
      "enabled": .bool(enabled), "description": .string(description),
      "references": .array(references.map(\.json)),
      "lastImageId": lastImage.map(JSONValue.string) ?? .null, "lastPrompt": .string(lastPrompt),
    ])
  }
}

struct CardPreview: Equatable {
  static let limit = 1_000_000
  let name, character, scene, examples, notes: String
  let notices: [String]
  static func parse(_ source: String) throws -> Self {
    let data = Data(source.replacingOccurrences(of: "\u{FEFF}", with: "").utf8)
    guard data.count <= limit else { throw SheetError.message(uncensiaText("角色卡 JSON 最大支持 1 MB")) }
    guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw SheetError.message(uncensiaText("无法读取 JSON，请检查文件或粘贴完整内容"))
    }
    guard root["spec"] as? String == "chara_card_v2", root["spec_version"] as? String == "2.0"
    else { throw SheetError.message(uncensiaText("目前支持 Character Card V2（chara_card_v2 / 2.0）JSON 的设定提取")) }
    guard let x = root["data"] as? [String: Any] else { throw SheetError.message(uncensiaText("角色卡缺少 data 对象")) }
    for k in [
      "name", "description", "personality", "scenario", "first_mes", "mes_example", "creator_notes",
      "system_prompt", "post_history_instructions", "creator", "character_version",
    ] where !(x[k] is String) { throw SheetError.message(uncensiaText("角色卡 %@ 必须是文字", String(describing: k))) }
    for k in ["alternate_greetings", "tags"] {
      guard let a = x[k] as? [Any], a.allSatisfy({ $0 is String }) else {
        throw SheetError.message(uncensiaText("角色卡 %@ 必须是文字数组", String(describing: k)))
      }
    }
    guard let ext = x["extensions"] as? [String: Any] else {
      throw SheetError.message(uncensiaText("角色卡 extensions 必须是对象"))
    }
    let name = (x["name"] as! String).trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty else { throw SheetError.message(uncensiaText("角色卡名称不能为空")) }
    func prose(_ k: String) -> String {
      (x[k] as! String).replacingOccurrences(of: "{{char}}", with: name).trimmingCharacters(
        in: .whitespacesAndNewlines)
    }
    let character = [name, prose("description"), prose("personality")].filter { !$0.isEmpty }
      .joined(separator: "\n\n")
    var notices: [String] = []
    if !(x["first_mes"] as! String).isEmpty || !(x["alternate_greetings"] as! [Any]).isEmpty {
      notices.append(uncensiaText("开场白未加入对话，已有剧情会保留。"))
    }
    if !(x["system_prompt"] as! String).isEmpty
      || !(x["post_history_instructions"] as! String).isEmpty
    {
      notices.append(uncensiaText("额外提示指令未应用；通用指令和写作方式保持原值。"))
    }
    if x["character_book"] != nil { notices.append(uncensiaText("这张卡含世界书，尚未导入或启用。")) }
    if !ext.isEmpty { notices.append(uncensiaText("扩展功能未启用，原始数据仍在原文件中。")) }
    let scene = prose("scenario")
    let examples = prose("mes_example")
    if [character, scene, examples].contains(where: {
      $0.range(of: #"\{\{[^}]+\}\}"#, options: .regularExpression) != nil
    }) {
      notices.append(uncensiaText("除角色名外的模板标记保留为文本，请在草稿中按需填写。"))
    }
    return .init(
      name: name, character: character, scene: scene, examples: examples,
      notes: x["creator_notes"] as! String, notices: notices)
  }
}
enum SheetError: LocalizedError {
  case message(String)
  var errorDescription: String? { if case .message(let x) = self { x } else { nil } }
}
func treeActiveIDs(_ tree: JSONValue) -> Set<String> {
  let items = tree["entries"].arrayValue ?? []
  let parent = Dictionary(
    uniqueKeysWithValues: items.compactMap { x -> (String, String?)? in
      guard let id = x["id"].stringValue else { return nil }
      return (id, x["parentId"].stringValue)
    })
  var out = Set<String>()
  var next = tree["leafId"].stringValue
  while let id = next, !out.contains(id) {
    out.insert(id)
    next = parent[id] ?? nil
  }
  return out
}
func urlPart(_ x: String) -> String {
  x.addingPercentEncoding(
    withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=?+#"))) ?? x
}
func roleLabel(_ x: String?) -> String { x == "user" ? uncensiaText("你") : x == "assistant" ? uncensiaText("助手") : x ?? "" }
func taskStatus(_ x: String?) -> String {
  ["pending": uncensiaText("等待中"), "running": uncensiaText("运行中"), "completed": uncensiaText("已完成"), "failed": uncensiaText("失败"), "cancelled": uncensiaText("已取消")][
    x ?? ""] ?? x ?? uncensiaText("未知")
}
private struct RemoteImage: View {
  let id: String
  let api: APIClient?
  @State private var image: UIImage?
  var body: some View {
    Group {
      if let image {
        Image(uiImage: image).resizable().scaledToFill()
      } else {
        ZStack {
          Color.secondary.opacity(0.1)
          ProgressView()
        }
      }
    }.task(id: id) {
      guard let api, let data = try? await api.download("/images/\(urlPart(id))?w=480") else {
        return
      }
      image = UIImage(data: data)
    }
  }
}
