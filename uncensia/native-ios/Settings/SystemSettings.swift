import SwiftUI

struct CapabilitiesSettingsView: View {
  let store: SettingsStore
  let appModel: AppModel
  @State private var tavilyKey = ""
  @State private var embeddingKey = ""
  @State private var reindexProgress = ""
  var body: some View {
    @Bindable var store = store
    Form {
      Section(uncensiaText("联网搜索")) {
        Toggle(uncensiaText("启用 web_search"), isOn: bool("web", "enabled"))
        Picker(uncensiaText("后端"), selection: string("web", "provider")) {
          Text("Tavily").tag("tavily")
          Text(uncensiaText("SearXNG（自托管）")).tag("searxng")
        }
        if store.capabilities["web"]["provider"].stringValue == "searxng" {
          TextField(uncensiaText("SearXNG 地址"), text: string("web", "baseUrl"))
        } else {
          SecureField(
            store.capabilities["web"]["hasTavilyKey"].boolValue == true
              ? uncensiaText("替换 Tavily 密钥") : "Tavily API Key", text: $tavilyKey)
          HStack {
            Button(uncensiaText("保存密钥")) { secret("tavily", tavilyKey) }.disabled(tavilyKey.isEmpty)
            Button(uncensiaText("清除"), role: .destructive) { clearSecret("tavily") }
          }
        }
      }
      Section(uncensiaText("文件检索")) {
        Toggle(uncensiaText("允许上传文件"), isOn: bool("files", "enabled"))
        Toggle(uncensiaText("启用 file_search"), isOn: bool("files", "searchEnabled"))
        Picker(uncensiaText("检索方式"), selection: string("files", "mode")) {
          Text(uncensiaText("混合")).tag("hybrid")
          Text(uncensiaText("仅语义")).tag("semantic")
          Text(uncensiaText("仅关键词")).tag("keyword")
        }
      }
      Section(uncensiaText("嵌入模型")) {
        Toggle(uncensiaText("启用嵌入"), isOn: bool("embedding", "enabled"))
        TextField("Base URL", text: string("embedding", "baseUrl"))
        TextField(uncensiaText("模型"), text: string("embedding", "model"))
        TextField(uncensiaText("向量维度（留空自动）"), text: nullableNumber("embedding", "dimensions"))
          .keyboardType(.numberPad)
        TextField(uncensiaText("切片大小"), text: number("embedding", "chunkSize")).keyboardType(.numberPad)
        TextField(uncensiaText("切片重叠"), text: number("embedding", "chunkOverlap")).keyboardType(.numberPad)
        SecureField(
          store.capabilities["embedding"]["hasKey"].boolValue == true ? uncensiaText("替换密钥") : "API Key",
          text: $embeddingKey)
        Button(uncensiaText("保存嵌入密钥")) { secret("embedding", embeddingKey) }.disabled(embeddingKey.isEmpty)
        if store.capabilities["embedding"]["hasKey"].boolValue == true {
          Button(uncensiaText("清除嵌入密钥"), role: .destructive) { clearSecret("embedding") }
        }
        Button(uncensiaText("重建全部文档"), image: "lucide-refresh-cw") { reindexAll() }
        if !reindexProgress.isEmpty { Text(reindexProgress).font(.caption) }
      }
      Section(uncensiaText("记忆预算")) {
        Toggle(uncensiaText("每次对话带上记忆"), isOn: bool("memory", "enabled"))
        Toggle(uncensiaText("允许助手保存记忆"), isOn: bool("memory", "writeEnabled"))
        TextField(uncensiaText("总 token 预算"), text: number("memory", "tokenLimit")).keyboardType(.numberPad)
        TextField(uncensiaText("单条字符上限"), text: number("memory", "charLimit")).keyboardType(.numberPad)
        TextField(uncensiaText("建议名称（逗号分隔）"), text: list("memory", "suggestedKeys"))
      }
      Section(uncensiaText("创作台")) { Toggle(uncensiaText("启用创作台"), isOn: bool("studio", "enabled")) }
      Section(uncensiaText("代码工具")) {
        Toggle(uncensiaText("读取"), isOn: bool("coding", "read"))
        Toggle(uncensiaText("写入"), isOn: bool("coding", "write"))
        Toggle(uncensiaText("执行命令"), isOn: bool("coding", "shell"))
        TextField(uncensiaText("工作目录"), text: string("coding", "workspace"))
      }
    }.toolbar { ToolbarItem(placement: .primaryAction) { Button(uncensiaText("保存")) { save() } } }
  }
  func object(_ group: String) -> [String: JSONValue] {
    store.capabilities[group].objectValue ?? [:]
  }
  func set(_ group: String, _ key: String, _ value: JSONValue) {
    var root = store.capabilities.objectValue ?? [:]
    var o = root[group]?.objectValue ?? [:]
    o[key] = value
    root[group] = .object(o)
    store.capabilities = .object(root)
  }
  func bool(_ g: String, _ k: String) -> Binding<Bool> {
    Binding(get: { store.capabilities[g][k].boolValue ?? false }, set: { set(g, k, .bool($0)) })
  }
  func string(_ g: String, _ k: String) -> Binding<String> {
    Binding(get: { store.capabilities[g][k].displayString }, set: { set(g, k, .string($0)) })
  }
  func number(_ g: String, _ k: String) -> Binding<String> {
    Binding(
      get: { store.capabilities[g][k].displayString }, set: { set(g, k, .number(Double($0) ?? 0)) })
  }
  func nullableNumber(_ g: String, _ k: String) -> Binding<String> {
    Binding(
      get: { store.capabilities[g][k] == .null ? "" : store.capabilities[g][k].displayString },
      set: { value in
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        set(
          g, k,
          trimmed.isEmpty
            ? .null : Double(trimmed).map(JSONValue.number) ?? store.capabilities[g][k])
      })
  }
  func list(_ g: String, _ k: String) -> Binding<String> {
    Binding(
      get: {
        (store.capabilities[g][k].arrayValue ?? []).compactMap(\.stringValue).joined(
          separator: ", ")
      },
      set: {
        set(
          g, k,
          .strings(
            $0.split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }.filter
            { !$0.isEmpty }))
      })
  }
  func save() {
    withAPI(appModel, store: store) { api in
      store.capabilities = try await api.request("PATCH", "/capabilities", body: store.capabilities)
      await appModel.refreshBootstrap()
    }
  }
  func secret(_ name: String, _ value: String) {
    withAPI(appModel, store: store) { api in
      store.capabilities = try await api.request(
        "PUT", "/capabilities/secrets/\(name)", body: .object(["value": .string(value)]))
      if name == "tavily" { tavilyKey = "" } else { embeddingKey = "" }
    }
  }
  func clearSecret(_ name: String) {
    withAPI(appModel, store: store) { api in
      store.capabilities = try await api.request("DELETE", "/capabilities/secrets/\(name)")
    }
  }
  func reindexAll() {
    withAPI(appModel, store: store) { api in
      var files: [JSONValue] = []
      var offset = 0
      while true {
        let page = try await api.request("GET", "/files?limit=200&offset=\(offset)")
        let batch = page["items"].arrayValue ?? []
        files.append(contentsOf: batch)
        offset += batch.count
        if batch.isEmpty || offset >= Int(page["total"].doubleValue ?? Double(offset)) { break }
      }
      let docs = files.filter {
        !$0["mime"].displayString.hasPrefix("image/")
          && !$0["mime"].displayString.hasPrefix("video/")
      }
      var failed = 0
      for (i, file) in docs.enumerated() {
        do {
          _ = try await api.request(
            "POST", "/files/\(encodedPath(file["id"].displayString))/reindex")
        } catch { failed += 1 }
        reindexProgress = uncensiaText("%@/%@，失败 %@", String(describing: i+1), String(describing: docs.count), String(describing: failed))
      }
    }
  }
}

struct PromptsSettingsView: View {
  let store: SettingsStore
  let appModel: AppModel
  var body: some View {
    @Bindable var store = store
    Form {
      Section(uncensiaText("系统提示")) {
        TextEditor(text: prompt("globalPrompt")).frame(minHeight: 180)
        Button(uncensiaText("恢复全局默认")) { setPrompt("globalPrompt", store.promptDefaults["globalPrompt"]) }
        TextEditor(text: prompt("toolPrompt")).frame(minHeight: 240)
        Button(uncensiaText("恢复工具默认")) { setPrompt("toolPrompt", store.promptDefaults["toolPrompt"]) }
      }
      Section(uncensiaText("标题生成")) {
        Toggle(uncensiaText("首轮后自动命名"), isOn: promptBool("titleEnabled"))
        Picker(uncensiaText("命名模型"), selection: prompt("titleModelId")) {
          Text(uncensiaText("跟随当前对话模型")).tag("")
          ForEach(
            store.models.filter {
              $0["kind"].stringValue == "chat" && $0["enabled"].boolValue != false
            }, id: \.stableID
          ) { Text($0["name"].displayString).tag($0["id"].displayString) }
        }
      }
    }.toolbar {
      ToolbarItem(placement: .primaryAction) {
        Button(uncensiaText("保存")) {
          withAPI(appModel, store: store) { api in
            store.prompts = try await api.request("PUT", "/prompts", body: store.prompts)
            await appModel.refreshBootstrap()
          }
        }
      }
    }
  }
  func setPrompt(_ key: String, _ value: JSONValue) {
    var o = store.prompts.objectValue ?? [:]
    o[key] = value
    store.prompts = .object(o)
  }
  func prompt(_ key: String) -> Binding<String> {
    Binding(get: { store.prompts[key].displayString }, set: { setPrompt(key, .string($0)) })
  }
  func promptBool(_ key: String) -> Binding<Bool> {
    Binding(get: { store.prompts[key].boolValue ?? false }, set: { setPrompt(key, .bool($0)) })
  }
}

struct MemorySettingsView: View {
  let store: SettingsStore
  let appModel: AppModel
  @State var key = ""
  @State var value = ""
  @State var editingKey: String?
  var body: some View {
    List {
      Section(uncensiaText("预算")) {
        LabeledContent(
          uncensiaText("已用"),
          value:
            "\(Int(store.memory["tokens"].doubleValue ?? 0)) / \(Int(store.memory["limit"].doubleValue ?? 0)) tokens"
        )
        LabeledContent(uncensiaText("单条上限"), value: uncensiaText("%@ 字符", String(describing: Int(store.memory["charLimit"].doubleValue ?? 0))))
      }
      Section(uncensiaText("记忆")) {
        ForEach(store.memory["items"].arrayValue ?? [], id: \.stableID) { item in
          Button {
            editingKey = item["key"].displayString
            key = editingKey ?? ""
            value = item["value"].displayString
          } label: {
            VStack(alignment: .leading) {
              Text(item["key"].displayString).font(.headline)
              Text(item["value"].displayString).lineLimit(3)
              if let source = item["sourceConversationId"].stringValue {
                Button(uncensiaText("打开来源对话")) { appModel.selectedConversationID = source }.font(.caption)
              }
            }
          }.buttonStyle(.plain)
        }
      }
      Section(uncensiaText("添加")) {
        TextField(uncensiaText("名称（字母、数字、_、-）"), text: $key)
        TextField(uncensiaText("内容"), text: $value, axis: .vertical).lineLimit(3...10)
        Button(editingKey == nil ? uncensiaText("添加") : uncensiaText("保存")) { save() }.disabled(
          key.isEmpty || value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        if editingKey != nil {
          Button(uncensiaText("删除"), role: .destructive) { remove() }
          Button(uncensiaText("取消编辑")) {
            editingKey = nil
            key = ""
            value = ""
          }
        }
      }
    }
  }
  func save() {
    withAPI(appModel, store: store) { api in
      _ = try await api.request(
        "PUT", "/memory/\(encodedPath(key))", body: .object(["value": .string(value)]))
      try await store.refreshMemory(api)
      editingKey = nil
      key = ""
      value = ""
    }
  }
  func remove() {
    guard let editingKey else { return }
    withAPI(appModel, store: store) { api in
      _ = try await api.request("DELETE", "/memory/\(encodedPath(editingKey))")
      try await store.refreshMemory(api)
      self.editingKey = nil
      key = ""
      value = ""
    }
  }
}
