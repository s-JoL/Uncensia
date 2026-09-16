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
      PiResourcesSections(store: store, appModel: appModel)
    }.sheet(isPresented: $adding) { MCPEditor(store: store, app: appModel, server: nil) }.sheet(
      item: $editing
    ) { MCPEditor(store: store, app: appModel, server: $0) }
  }
}

/// Pi packages and extensions. An extension is code the assistant runs at
/// start-up, so installing asks for confirmation and names the source.
private struct PiResourcesSections: View {
  let store: SettingsStore
  let appModel: AppModel
  @State private var source = ""
  @State private var confirmingInstall = false
  @State private var removing: JSONValue?
  @State private var editing: JSONValue?
  @State private var adding = false
  var body: some View {
    Section {
      Text(uncensiaText("扩展是随助手一起运行的代码，可以添加工具、命令和事件处理；包是从 npm、Git 或本地目录安装的一组扩展、技能和提示词。改动在下一次运行生效。")).font(.caption).foregroundStyle(.secondary)
      TextField(uncensiaText("npm:pi-skills 或 https://github.com/user/repo"), text: $source).textInputAutocapitalization(.never).autocorrectionDisabled()
      Button(uncensiaText("安装"), image: "lucide-plus") { confirmingInstall = true }.disabled(source.trimmingCharacters(in: .whitespaces).isEmpty)
      Text(uncensiaText("第三方包的代码会以助手的权限运行，只安装你信任的来源。")).font(.caption).foregroundStyle(.orange)
      ForEach((store.resources["diagnostics"].arrayValue ?? []).compactMap(\.stringValue), id: \.self) { Text($0).font(.caption).foregroundStyle(.orange) }
      if let status = store.resources["status"].objectValue {
        let errors = status["errors"]?.arrayValue ?? []
        Text(uncensiaText("上次加载：成功 %@ 个，失败 %@ 个", String((status["loaded"]?.arrayValue ?? []).count), String(errors.count))).font(.caption).foregroundStyle(.secondary)
        ForEach(errors, id: \.["path"].displayString) { Text("\($0["path"].displayString): \($0["error"].displayString)").font(.caption).foregroundStyle(.red) }
      }
    } header: { Text(uncensiaText("扩展与包")) }
    .confirmationDialog(uncensiaText("这个包里的代码会在助手启动时直接运行，权限与助手本身相同。确认你信任它的来源：%@", source.trimmingCharacters(in: .whitespaces)), isPresented: $confirmingInstall, titleVisibility: .visible) {
      Button(uncensiaText("安装")) { install() }
      Button(uncensiaText("取消"), role: .cancel) {}
    }
    let packages = store.resources["packages"].arrayValue ?? []
    if !packages.isEmpty {
      Section(uncensiaText("已安装的包")) {
        ForEach(packages, id: \.["source"].displayString) { package in
          VStack(alignment: .leading, spacing: 6) {
            Toggle(isOn: Binding(get: { package["enabled"].boolValue ?? true }, set: { enabled in
              withAPI(appModel, store: store) { api in
                _ = try await api.request("PATCH", "/extensions/packages", body: .object(["source": package["source"], "enabled": .bool(enabled)]))
                try await store.refreshResources(api)
              }
            })) { Text(package["source"].displayString).font(.headline).lineLimit(2) }
            let counts = package["resources"]
            Text(uncensiaText("%@ 个扩展 · %@ 个技能 · %@ 个提示词", counts["extensions"].displayString, counts["skills"].displayString, counts["prompts"].displayString)).font(.caption).foregroundStyle(.secondary)
            if package["installedPath"].stringValue == nil { Text(uncensiaText("尚未安装到本地")).font(.caption).foregroundStyle(.red) }
            HStack {
              Button(uncensiaText("更新")) {
                withAPI(appModel, store: store) { api in
                  _ = try await api.request("POST", "/extensions/packages/update", body: .object(["source": package["source"]]))
                  try await store.refreshResources(api)
                }
              }
              Spacer()
              Button(uncensiaText("移除"), role: .destructive) { removing = package }
            }.font(.caption).buttonStyle(.borderless)
          }
        }
      }
      .confirmationDialog(uncensiaText("移除这个包？它提供的扩展、技能和提示词将不再加载。"), isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
        Button(uncensiaText("移除"), role: .destructive) {
          guard let package = removing else { return }
          withAPI(appModel, store: store) { api in
            _ = try await api.request("DELETE", "/extensions/packages", body: .object(["source": package["source"]]))
            try await store.refreshResources(api)
          }
        }
        Button(uncensiaText("取消"), role: .cancel) {}
      }
    }
    Section {
      Button(uncensiaText("新建扩展"), image: "lucide-plus") { adding = true }
      let extensions = store.resources["extensions"].arrayValue ?? []
      if extensions.isEmpty { Text(uncensiaText("还没有扩展。可以新建一个本地扩展，或安装一个包。")).font(.caption).foregroundStyle(.secondary) }
      ForEach(extensions, id: \.stableID) { extensionItem in
        VStack(alignment: .leading, spacing: 6) {
          Toggle(isOn: Binding(get: { extensionItem["enabled"].boolValue ?? true }, set: { enabled in
            withAPI(appModel, store: store) { api in
              _ = try await api.request("PATCH", "/extensions/\(encodedPath(extensionItem["id"].displayString))", body: .object(["enabled": .bool(enabled)]))
              try await store.refreshResources(api)
            }
          })) { Text(extensionItem["name"].displayString).font(.headline) }
          Text(extensionItem["editable"].boolValue == true ? uncensiaText("本地扩展，可编辑") : uncensiaText("来自包 %@，正文只读", extensionItem["source"].displayString)).font(.caption).foregroundStyle(.secondary)
          HStack { Spacer(); Button(uncensiaText("查看")) { editing = extensionItem } }.font(.caption).buttonStyle(.borderless)
        }
      }
    } header: { Text(uncensiaText("扩展")) }
    .sheet(isPresented: $adding) { ExtensionEditor(store: store, app: appModel, extensionItem: nil) }
    .sheet(item: $editing) { ExtensionEditor(store: store, app: appModel, extensionItem: $0) }
  }
  private func install() {
    let trimmed = source.trimmingCharacters(in: .whitespaces)
    withAPI(appModel, store: store) { api in
      _ = try await api.request("POST", "/extensions/packages", body: .object(["source": .string(trimmed)]))
      try await store.refreshResources(api)
      source = ""
    }
  }
}

private struct ExtensionEditor: View {
  let store: SettingsStore
  let app: AppModel
  let extensionItem: JSONValue?
  @Environment(\.dismiss) var dismiss
  @State var name = "my-extension"
  @State var content = "export default function (pi) {\n  pi.registerTool({\n    name: \"hello\",\n    label: \"hello\",\n    description: \"Say hello.\",\n    parameters: { type: \"object\", properties: {} },\n    async execute() {\n      return { content: [{ type: \"text\", text: \"Hello from an Uncensia extension.\" }] };\n    },\n  });\n}\n"
  @State private var confirmingDelete = false
  private var editable: Bool { extensionItem == nil || extensionItem?["editable"].boolValue == true }
  var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: 8) {
        if extensionItem == nil { TextField(uncensiaText("扩展名称"), text: $name).textInputAutocapitalization(.never).autocorrectionDisabled().textFieldStyle(.roundedBorder) }
        TextEditor(text: $content).font(.system(.body, design: .monospaced)).disabled(!editable)
        if editable { Text(uncensiaText("保存后这段代码会在助手下一次启动时运行。")).font(.caption).foregroundStyle(.orange) }
        if let path = extensionItem?["filePath"].stringValue { Text(path).font(.caption2).foregroundStyle(.secondary) }
      }.padding()
      .navigationTitle(extensionItem?["name"].displayString ?? uncensiaText("新建扩展")).toolbar {
        ToolbarItem(placement: .cancellationAction) { Button(uncensiaText("关闭")) { dismiss() } }
        if editable {
          ToolbarItem(placement: .confirmationAction) { Button(uncensiaText("保存")) { save() } }
          if extensionItem != nil { ToolbarItem(placement: .destructiveAction) { Button(uncensiaText("删除"), role: .destructive) { confirmingDelete = true } } }
        }
      }
      .confirmationDialog(uncensiaText("删除这个扩展？文件会移到回收目录，不会立刻销毁。"), isPresented: $confirmingDelete, titleVisibility: .visible) {
        Button(uncensiaText("删除"), role: .destructive) { remove() }
        Button(uncensiaText("取消"), role: .cancel) {}
      }
    }.onAppear { if let extensionItem { content = extensionItem["content"].displayString } }
  }
  func save() {
    withAPI(app, store: store) { api in
      if let extensionItem {
        _ = try await api.request("PATCH", "/extensions/\(encodedPath(extensionItem["id"].displayString))", body: .object(["content": .string(content), "revision": extensionItem["revision"]]))
      } else {
        _ = try await api.request("POST", "/extensions", body: .object(["name": .string(name.trimmingCharacters(in: .whitespaces)), "content": .string(content)]))
      }
      try await store.refreshResources(api)
      dismiss()
    }
  }
  func remove() {
    guard let extensionItem else { return }
    withAPI(app, store: store) { api in
      _ = try await api.request("DELETE", "/extensions/\(encodedPath(extensionItem["id"].displayString))")
      try await store.refreshResources(api)
      dismiss()
    }
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
        text.split(separator: "\n").compactMap { line -> (String, JSONValue)? in
          guard let i = line.firstIndex(of: "=") else { return nil }
          let key = String(line[..<i]).trimmingCharacters(in: .whitespaces)
          guard !key.isEmpty else { return nil }
          return (
            key,
            .string(String(line[line.index(after: i)...]).trimmingCharacters(in: .whitespaces))
          )
        }, uniquingKeysWith: { _, last in last }))
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
      Section {
        Button(uncensiaText("刷新记录"), image: "lucide-refresh-cw") {
          withAPI(appModel, store: store) { api in try await store.refreshLearning(api) }
        }
        if store.learningHistory.isEmpty {
          Text(uncensiaText("尚无记录。在工具与权限中允许修改技能后，可以让助手把已验证的经验整理成技能。")).font(.caption).foregroundStyle(.secondary)
        }
        ForEach(store.learningHistory) { change in
          DisclosureGroup {
            VStack(alignment: .leading, spacing: 8) {
              Text(change["target"].displayString).font(.caption).foregroundStyle(.secondary)
              Text(uncensiaText("修改前")).font(.caption)
              Text(change["before"].stringValue ?? uncensiaText("新建")).font(.system(.caption, design: .monospaced)).lineLimit(12)
              Text(uncensiaText("修改后")).font(.caption)
              Text(change["after"].displayString).font(.system(.caption, design: .monospaced)).lineLimit(12)
            }
          } label: {
            VStack(alignment: .leading, spacing: 2) {
              Text(learningChangeTitle(change)).font(.subheadline).lineLimit(2)
              Text(change["reason"].displayString).font(.caption).foregroundStyle(.secondary).lineLimit(3)
            }
          }
        }
      } header: { Text(uncensiaText("助手改进记录")) } footer: { Text(uncensiaText("最近 50 次修改尝试，保留原因和修改前内容。可将旧内容复制回编辑器，或让助手恢复；是否生效以实际工具结果为准。")) }
    }.sheet(isPresented: $adding) { SkillEditor(store: store, app: appModel, skill: nil) }.sheet(
      item: $editing
    ) { SkillEditor(store: store, app: appModel, skill: $0) }
  }
  private func learningChangeTitle(_ change: JSONValue) -> String {
    let kind = change["kind"].stringValue == "prompt" ? uncensiaText("提示词") : uncensiaText("技能")
    guard let iso = change["at"].stringValue else { return kind }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let date = formatter.date(from: iso) ?? {
      formatter.formatOptions = [.withInternetDateTime]
      return formatter.date(from: iso)
    }()
    guard let date else { return "\(iso) · \(kind)" }
    return "\(date.formatted(date: .abbreviated, time: .shortened)) · \(kind)"
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
