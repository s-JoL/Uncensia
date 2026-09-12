import SwiftUI

struct MCPSettingsView: View {
  let store: SettingsStore
  let appModel: AppModel
  @State private var editing: JSONValue?
  @State private var adding = false
  var body: some View {
    List {
      Section {
        HStack {
          Button(uncensiaText("添加 MCP 服务器"), image: "lucide-plus") { adding = true }
          Spacer()
          Button(uncensiaText("重连"), image: "lucide-refresh-cw") {
            withAPI(appModel, store: store) { api in
              _ = try await api.request("POST", "/mcp/reconnect")
              try await store.refreshMCP(api)
            }
          }
        }
      }
      ForEach(store.mcpServers, id: \.stableID) { server in
        let state = store.mcpStatus.first { $0["id"] == server["id"] }
        Button {
          editing = server
        } label: {
          VStack(alignment: .leading, spacing: 5) {
            HStack {
              Text(server["title"].displayString).font(.headline)
              Spacer()
              Text(
                server["enabled"].boolValue == false
                  ? uncensiaText("已停用")
                  : state?["connected"].boolValue == true
                    ? uncensiaText("%@ 个工具", String(describing: (state?["tools"].arrayValue ?? []).count)) : uncensiaText("未连接")
              ).font(.caption)
            }
            Text(
              server["url"].stringValue
                ?? "\(server["command"].displayString) \(server["args"].displayString)"
            ).font(.caption).foregroundStyle(.secondary)
            if let e = state?["error"].stringValue { Text(e).font(.caption).foregroundStyle(.red) }
          }
        }.buttonStyle(.plain)
      }
    }.sheet(isPresented: $adding) { MCPEditor(store: store, app: appModel, server: nil) }.sheet(
      item: $editing
    ) { MCPEditor(store: store, app: appModel, server: $0) }
  }
}

private struct MCPEditor: View {
  let store: SettingsStore
  let app: AppModel
  let server: JSONValue?
  @Environment(\.dismiss) var dismiss
  @State var id = ""
  @State var title = ""
  @State var enabled = true
  @State var remote = false
  @State var command = ""
  @State var url = ""
  @State var args = ""
  @State var env = ""
  @State var headers = ""
  var body: some View {
    NavigationStack {
      Form {
        Section(uncensiaText("服务器")) {
          TextField(uncensiaText("名称"), text: $title)
          TextField(uncensiaText("标识"), text: $id).disabled(server != nil)
          Toggle(uncensiaText("启用"), isOn: $enabled)
          Picker(uncensiaText("接入方式"), selection: $remote) {
            Text(uncensiaText("本地子进程")).tag(false)
            Text(uncensiaText("远程 HTTP")).tag(true)
          }
        }
        if remote {
          Section(uncensiaText("远程连接")) {
            TextField("Streamable HTTP URL", text: $url).textInputAutocapitalization(.never)
            TextField(uncensiaText("请求头，每行 KEY=VALUE"), text: $headers, axis: .vertical).lineLimit(4...8)
          }
        } else {
          Section(uncensiaText("本地进程")) {
            TextField(uncensiaText("命令"), text: $command)
            TextField(uncensiaText("参数，每行一个"), text: $args, axis: .vertical).lineLimit(4...8)
            TextField(uncensiaText("环境变量，每行 KEY=VALUE"), text: $env, axis: .vertical).lineLimit(4...8)
          }
        }
        if server != nil { Section { Button(uncensiaText("删除服务器"), role: .destructive) { remove() } } }
      }.navigationTitle(server == nil ? uncensiaText("添加 MCP") : uncensiaText("编辑 MCP")).toolbar {
        ToolbarItem(placement: .cancellationAction) { Button(uncensiaText("取消")) { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button(uncensiaText("保存")) { save() }.disabled(
            title.isEmpty || (remote ? url.isEmpty : command.isEmpty))
        }
      }
    }.onAppear {
      guard let s = server else { return }
      id = s["id"].displayString
      title = s["title"].displayString
      enabled = s["enabled"].boolValue ?? true
      remote = !s["url"].displayString.isEmpty
      url = s["url"].displayString
      command = s["command"].displayString
      args = (s["args"].arrayValue ?? []).compactMap(\.stringValue).joined(separator: "\n")
      env = kv(s["env"])
      headers = kv(s["headers"])
    }
  }
  func kv(_ value: JSONValue) -> String {
    (value.objectValue ?? [:]).sorted { $0.key < $1.key }.map {
      "\($0.key)=\($0.value.displayString)"
    }.joined(separator: "\n")
  }
  func parsed(_ text: String) -> JSONValue {
    .object(
      Dictionary(
        uniqueKeysWithValues: text.split(separator: "\n").compactMap { line in
          guard let i = line.firstIndex(of: "=") else { return nil }
          return (
            String(line[..<i]).trimmingCharacters(in: .whitespaces),
            .string(String(line[line.index(after: i)...]).trimmingCharacters(in: .whitespaces))
          )
        }))
  }
  func save() {
    withAPI(app, store: store) { api in
      var b: [String: JSONValue] = [
        "title": .string(title), "enabled": .bool(enabled),
        "command": .string(remote ? "" : command), "url": .string(remote ? url : ""),
        "args": remote ? .array([]) : .strings(args.split(separator: "\n").map(String.init)),
        "env": remote ? .object([:]) : parsed(env),
        "headers": remote ? parsed(headers) : .object([:]),
      ]
      if server == nil && !id.isEmpty { b["id"] = .string(id) }
      _ = try await api.request(
        server == nil ? "POST" : "PATCH",
        server == nil ? "/mcp/servers" : "/mcp/servers/\(encodedPath(id))", body: .object(b))
      try await store.refreshMCP(api)
      await app.refreshBootstrap()
      dismiss()
    }
  }
  func remove() {
    withAPI(app, store: store) { api in
      _ = try await api.request("DELETE", "/mcp/servers/\(encodedPath(id))")
      try await store.refreshMCP(api)
      dismiss()
    }
  }
}

struct SkillsSettingsView: View {
  let store: SettingsStore
  let appModel: AppModel
  @State var search = ""
  @State var editing: JSONValue?
  @State var adding = false
  var body: some View {
    List {
      Section {
        Button(uncensiaText("添加技能"), image: "lucide-plus") { adding = true }
        TextField(uncensiaText("查找技能"), text: $search)
      }
      if !store.skillDiagnostics.isEmpty {
        Section(uncensiaText("诊断")) {
          ForEach(store.skillDiagnostics, id: \.self) {
            Text($0).font(.caption).foregroundStyle(.orange)
          }
        }
      }
      ForEach(
        store.skills.filter {
          search.isEmpty
            || "\($0["name"].displayString) \($0["description"].displayString)"
              .localizedCaseInsensitiveContains(search)
        }, id: \.stableID
      ) { skill in
        VStack(alignment: .leading, spacing: 8) {
          Toggle(
            isOn: Binding(
              get: { skill["enabled"].boolValue ?? true },
              set: { enabled in
                withAPI(appModel, store: store) { api in
                  _ = try await api.request(
                    "PATCH", "/skills/\(encodedPath(skill["id"].displayString))",
                    body: .object(["enabled": .bool(enabled)]))
                  try await store.refreshSkills(api)
                }
              })
          ) { Text(skill["name"].displayString).font(.headline) }
          Text(skill["description"].displayString).font(.subheadline).foregroundStyle(.secondary)
          HStack {
            Text(skill["manualOnly"].boolValue == true ? uncensiaText("仅手动调用") : uncensiaText("按需自动加载"))
            Text("·")
            Text(skill["editable"].boolValue == true ? uncensiaText("本地可编辑") : uncensiaText("外部只读"))
            Spacer()
            Button(uncensiaText("查看")) { editing = skill }
          }.font(.caption)
        }
      }
    }.sheet(isPresented: $adding) { SkillEditor(store: store, app: appModel, skill: nil) }.sheet(
      item: $editing
    ) { SkillEditor(store: store, app: appModel, skill: $0) }
  }
}
private struct SkillEditor: View {
  let store: SettingsStore
  let app: AppModel
  let skill: JSONValue?
  @Environment(\.dismiss) var dismiss
  @State var content = uncensiaText("---\nname: my-skill\ndescription: 描述何时使用这项技能\n---\n\n在这里编写技能说明。\n")
  var body: some View {
    NavigationStack {
      TextEditor(text: $content).font(.system(.body, design: .monospaced)).padding().disabled(
        skill?["editable"].boolValue == false
      ).navigationTitle(skill?["name"].displayString ?? uncensiaText("添加技能")).toolbar {
        ToolbarItem(placement: .cancellationAction) { Button(uncensiaText("关闭")) { dismiss() } }
        if skill == nil || skill?["editable"].boolValue == true {
          ToolbarItem(placement: .confirmationAction) { Button(uncensiaText("保存")) { save() } }
        }
      }
    }.onAppear { if let skill { content = skill["content"].displayString } }
  }
  func save() {
    withAPI(app, store: store) { api in
      let body: JSONValue =
        skill == nil
        ? .object(["content": .string(content)])
        : .object(["content": .string(content), "revision": skill?["revision"] ?? .null])
      _ = try await api.request(
        skill == nil ? "POST" : "PATCH",
        skill == nil ? "/skills" : "/skills/\(encodedPath(skill?["id"].displayString ?? ""))",
        body: body)
      try await store.refreshSkills(api)
      dismiss()
    }
  }
}

struct TasksSettingsView: View {
  let store: SettingsStore
  let appModel: AppModel
  var body: some View {
    List {
      if store.tasks.isEmpty {
        ContentUnavailableView(uncensiaText("目前没有定时任务"), image: "lucide-clock")
      } else {
        ForEach(store.tasks, id: \.stableID) { task in
          BackgroundTaskCard(task: task, api: appModel.api, onChanged: refresh) {
            appModel.selectedConversationID = task["conversationId"].stringValue
            appModel.selectedTab = "chat"
          }
        }
      }
    }.refreshable {
      guard let api = appModel.api else { return }
      do { try await store.refreshTasks(api) } catch { store.fail(error) }
    }
  }

  private func refresh() async {
    guard let api = appModel.api else { return }
    do { try await store.refreshTasks(api) } catch { store.fail(error) }
  }
}
