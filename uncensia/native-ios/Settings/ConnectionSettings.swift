import SwiftUI

struct OverviewSettingsView: View {
  let store: SettingsStore
  var body: some View {
    Form {
      Section(uncensiaText("默认对话模型")) { DefaultModelPicker(store: store, kind: "chat") }
      Section(uncensiaText("创作默认模型")) {
        DefaultModelPicker(store: store, kind: "image")
        DefaultModelPicker(store: store, kind: "edit")
        DefaultModelPicker(store: store, kind: "video")
      }
      Section(uncensiaText("状态")) {
        LabeledContent(uncensiaText("连接服务"), value: "\(store.providers.count)")
        LabeledContent(uncensiaText("模型"), value: "\(store.models.count)")
        LabeledContent(uncensiaText("技能"), value: "\(store.skills.count)")
        LabeledContent(uncensiaText("定时任务"), value: "\(store.tasks.count)")
      }
    }
  }
}

private struct DefaultModelPicker: View {
  let store: SettingsStore
  let kind: String
  @Environment(AppModel.self) private var app
  var title: String { ["chat": uncensiaText("对话"), "image": uncensiaText("文生图"), "edit": uncensiaText("改图"), "video": uncensiaText("视频")][kind] ?? kind }
  var choices: [JSONValue] {
    store.models.filter { model in
      guard model["enabled"].boolValue != false else { return false }
      if kind == "chat" {
        return model["kind"].stringValue == "chat" || model["kind"].stringValue == "text"
      }
      if kind == "edit" {
        return model["kind"].stringValue == "image"
          && (model["ops"].arrayValue ?? []).contains(.string("image_to_image"))
      }
      return model["kind"].stringValue == kind
    }
  }
  var value: String {
    get {
      kind == "chat"
        ? store.defaultModelID
        : kind == "image"
          ? store.defaultImageModelID
          : kind == "edit" ? store.defaultEditModelID : store.defaultVideoModelID
    }
    nonmutating set {
      withAPI(app, store: store) { api in
        if kind == "chat" {
          _ = try await api.request(
            "PUT", "/models/default", body: .object(["modelId": .string(newValue)]))
        } else {
          let key =
            kind == "image" ? "imageModelId" : kind == "edit" ? "editModelId" : "videoModelId"
          _ = try await api.request(
            "PUT", "/models/generation-defaults", body: .object([key: .string(newValue)]))
        }
        try await store.refreshModels(api)
      }
    }
  }
  var body: some View {
    Picker(title, selection: Binding(get: { value }, set: { value = $0 })) {
      Text(uncensiaText("按可用后端选择")).tag("")
      ForEach(choices, id: \.stableID) { model in
        Text(model["name"].stringValue ?? model["id"].displayString).tag(model["id"].displayString)
      }
    }
  }
}

struct ProvidersSettingsView: View {
  let store: SettingsStore
  let appModel: AppModel
  @State private var editing: JSONValue?
  @State private var adding = false
  var body: some View {
    List {
      Section { Button(uncensiaText("添加连接服务"), image: "lucide-plus") { adding = true } }
      ForEach(store.providers, id: \.stableID) { provider in
        Button {
          editing = provider
        } label: {
          VStack(alignment: .leading, spacing: 5) {
            HStack {
              Text(provider["name"].displayString).font(.headline)
              Spacer()
              Image(provider["hasKey"].boolValue == true ? "lucide-key" : "lucide-key-round")
            }
            Text(provider["baseUrl"].displayString).font(.caption).foregroundStyle(.secondary)
          }
        }.buttonStyle(.plain)
      }
    }
    .sheet(isPresented: $adding) { ProviderEditor(store: store, app: appModel, provider: nil) }
    .sheet(item: $editing) { ProviderEditor(store: store, app: appModel, provider: $0) }
  }
}

private struct ProviderEditor: View {
  let store: SettingsStore
  let app: AppModel
  let provider: JSONValue?
  @Environment(\.dismiss) private var dismiss
  @State private var id = ""
  @State private var name = ""
  @State private var baseURL = ""
  @State private var apiKey = ""
  @State private var enabled = true
  @State private var authStyle = "bearer"
  @State private var authHeader = ""
  @State private var authPrefix = ""
  var body: some View {
    NavigationStack {
      Form {
        Section(uncensiaText("服务")) {
          TextField(uncensiaText("名称"), text: $name)
          TextField(uncensiaText("标识"), text: $id).disabled(provider != nil)
          TextField("Base URL", text: $baseURL).textInputAutocapitalization(.never)
          Toggle(uncensiaText("启用"), isOn: $enabled)
        }
        Section(uncensiaText("凭据")) {
          SecureField(provider?["hasKey"].boolValue == true ? uncensiaText("留空则保留密钥") : "API Key", text: $apiKey)
          Picker(uncensiaText("发送方式"), selection: $authStyle) {
            Text("Bearer").tag("bearer")
            Text(uncensiaText("自定义请求头")).tag("header")
            Text(uncensiaText("无凭据")).tag("none")
          }
          if authStyle == "header" {
            TextField(uncensiaText("请求头名称"), text: $authHeader)
            TextField(uncensiaText("密钥前缀"), text: $authPrefix)
          }
        }
        if provider?["hasKey"].boolValue == true {
          Button(uncensiaText("清除已存密钥"), role: .destructive) { clearKey() }
        }
        if provider != nil { Section { Button(uncensiaText("删除连接服务"), role: .destructive) { remove() } } }
      }.navigationTitle(provider == nil ? uncensiaText("添加连接服务") : uncensiaText("编辑连接服务")).toolbar {
        ToolbarItem(placement: .cancellationAction) { Button(uncensiaText("取消")) { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button(uncensiaText("保存")) { save() }.disabled(
            name.trimmingCharacters(in: .whitespaces).isEmpty || baseURL.isEmpty)
        }
      }
    }.onAppear {
      guard let p = provider else { return }
      id = p["id"].displayString
      name = p["name"].displayString
      baseURL = p["baseUrl"].displayString
      enabled = p["enabled"].boolValue ?? true
      authStyle = p["auth"]["style"].stringValue ?? "bearer"
      authHeader = p["auth"]["header"].displayString
      authPrefix = p["auth"]["prefix"].displayString
    }
  }
  func save() {
    withAPI(app, store: store) { api in
      var auth: [String: JSONValue] = ["style": .string(authStyle)]
      if !authHeader.isEmpty { auth["header"] = .string(authHeader) }
      if !authPrefix.isEmpty { auth["prefix"] = .string(authPrefix) }
      var body: [String: JSONValue] = [
        "name": .string(name), "baseUrl": .string(baseURL), "enabled": .bool(enabled),
        "auth": .object(auth),
      ]
      if provider == nil && !id.isEmpty { body["id"] = .string(id) }
      if provider == nil && !apiKey.isEmpty { body["apiKey"] = .string(apiKey) }
      let path = provider == nil ? "/providers" : "/providers/\(encodedPath(id))"
      _ = try await api.request(provider == nil ? "POST" : "PATCH", path, body: .object(body))
      if provider != nil && !apiKey.isEmpty {
        _ = try await api.request(
          "PUT", "/providers/\(encodedPath(id))/key", body: .object(["value": .string(apiKey)]))
      }
      try await store.refreshProviders(api)
      await app.refreshBootstrap()
      dismiss()
    }
  }
  func remove() {
    withAPI(app, store: store) { api in
      _ = try await api.request("DELETE", "/providers/\(encodedPath(id))")
      try await store.refreshProviders(api)
      dismiss()
    }
  }

  func clearKey() {
    withAPI(app, store: store) { api in
      _ = try await api.request("DELETE", "/providers/\(encodedPath(id))/key")
      try await store.refreshProviders(api)
    }
  }
}

struct ModelsSettingsView: View {
  let store: SettingsStore
  let appModel: AppModel
  @State private var editing: JSONValue?
  @State private var discoveryProvider: JSONValue?
  @State private var adding = false
  var body: some View {
    List {
      Section {
        Button(uncensiaText("手动添加模型"), image: "lucide-plus") { adding = true }
        Menu(uncensiaText("从服务发现模型")) {
          ForEach(store.providers, id: \.stableID) { p in
            Button(p["name"].displayString) { discoveryProvider = p }
          }
        }
      }
      ForEach(store.models, id: \.stableID) { model in
        Button {
          editing = model
        } label: {
          VStack(alignment: .leading) {
            HStack {
              Text(model["name"].displayString).font(.headline)
              if model["enabled"].boolValue == false { Text(uncensiaText("停用")).foregroundStyle(.secondary) }
              Spacer()
              Text(model["kind"].displayString).font(.caption)
            }
            Text("\(model["providerId"].displayString) · \(model["model"].displayString)").font(
              .caption
            ).foregroundStyle(.secondary)
          }
        }.buttonStyle(.plain)
      }
    }.sheet(isPresented: $adding) { ModelEditor(store: store, app: appModel, model: nil) }.sheet(
      item: $editing
    ) { ModelEditor(store: store, app: appModel, model: $0) }.sheet(item: $discoveryProvider) {
      ModelDiscovery(store: store, app: appModel, provider: $0)
    }
  }
}

private struct ModelEditor: View {
  let store: SettingsStore
  let app: AppModel
  let model: JSONValue?
  @Environment(\.dismiss) var dismiss
  @State var id = ""
  @State var name = ""
  @State var providerID = ""
  @State var remoteModel = ""
  @State var kind = "chat"
  @State var apiMode = "openai-completions"
  @State var enabled = true
  @State var pinned = true
  @State var agentTool = false
  @State var reasoning = false
  @State var imageInput = false
  @State var contextWindow = "128000"
  @State var maxTokens = "8192"
  @State var thinking = "off"
  @State var systemPrompt = ""
  @State var temperature = ""
  @State var topP = ""
  @State var pricingInput = ""
  @State var pricingOutput = ""
  @State var cacheRead = ""
  @State var cacheWrite = ""
  @State var paramsJSON = ""
  @State var compatJSON = ""
  @State var ops: Set<String> = []
  @State var reference: JSONValue = .null
  @State var formError: String?
  @State var saving = false
  var body: some View {
    NavigationStack {
      Form {
        if let visibleError = formError ?? validationError {
          Section { Text(visibleError).foregroundStyle(.red).font(.footnote) }
        }
        Section(uncensiaText("身份")) {
          TextField(uncensiaText("显示名称"), text: $name)
          TextField(uncensiaText("标识"), text: $id).disabled(model != nil)
          Picker(uncensiaText("服务"), selection: $providerID) {
            ForEach(store.providers, id: \.stableID) {
              Text($0["name"].displayString).tag($0["id"].displayString)
            }
          }
          TextField(uncensiaText("远端模型 ID"), text: $remoteModel).textInputAutocapitalization(.never)
          Picker(uncensiaText("类型"), selection: $kind) {
            Text(uncensiaText("对话")).tag("chat")
            Text(uncensiaText("图片")).tag("image")
            Text(uncensiaText("视频")).tag("video")
          }
          Picker(uncensiaText("API 模式"), selection: $apiMode) {
            ForEach(app.bootstrap["apiModes"].arrayValue ?? [], id: \.stableID) { mode in
              Text(mode["label"].stringValue ?? mode["id"].displayString).tag(
                mode["id"].displayString)
            }
          }
        }
        Section(uncensiaText("能力")) {
          Toggle(uncensiaText("启用"), isOn: $enabled)
          if kind == "chat" {
            Toggle(uncensiaText("常用模型"), isOn: $pinned)
            Toggle(uncensiaText("推理模型"), isOn: $reasoning)
            Toggle(uncensiaText("支持图片输入"), isOn: $imageInput)
            Picker(uncensiaText("思考等级"), selection: $thinking) {
              ForEach(["off", "minimal", "low", "medium", "high", "xhigh", "max"], id: \.self) {
                Text($0).tag($0)
              }
            }
          } else {
            Toggle(uncensiaText("作为 Agent 工具"), isOn: $agentTool)
            Toggle(uncensiaText("文生图"), isOn: opBinding("text_to_image"))
            Toggle(uncensiaText("改图"), isOn: opBinding("image_to_image"))
            if kind == "video" {
              Toggle(uncensiaText("文生视频"), isOn: opBinding("text_to_video"))
              Toggle(uncensiaText("图生视频"), isOn: opBinding("image_to_video"))
            }
          }
        }
        Section(uncensiaText("容量与采样")) {
          TextField(uncensiaText("上下文长度"), text: $contextWindow).keyboardType(.numberPad)
          TextField(uncensiaText("最大输出"), text: $maxTokens).keyboardType(.numberPad)
          TextField(uncensiaText("温度（留空跟随服务）"), text: $temperature).keyboardType(.decimalPad)
          TextField(uncensiaText("Top P（留空跟随服务）"), text: $topP).keyboardType(.decimalPad)
          TextField(uncensiaText("单模型系统提示"), text: $systemPrompt, axis: .vertical)
        }
        Section(uncensiaText("价格（每百万 token）")) {
          TextField(uncensiaText("输入"), text: $pricingInput).keyboardType(.decimalPad)
          TextField(uncensiaText("输出"), text: $pricingOutput).keyboardType(.decimalPad)
          TextField(uncensiaText("缓存读取"), text: $cacheRead).keyboardType(.decimalPad)
          TextField(uncensiaText("缓存写入"), text: $cacheWrite).keyboardType(.decimalPad)
        }
        Section(uncensiaText("高级适配")) {
          TextField(uncensiaText("生成参数 JSON"), text: $paramsJSON, axis: .vertical).font(
            .system(.caption, design: .monospaced))
          TextField(uncensiaText("兼容参数 JSON"), text: $compatJSON, axis: .vertical).font(
            .system(.caption, design: .monospaced))
          Text(uncensiaText("高级字段用于服务特有的工作流绑定和兼容开关；普通对话模型可以留空。"))
            .font(.caption).foregroundStyle(.secondary)
        }
        if let ref = reference.objectValue {
          Section(uncensiaText("模型参考")) {
            Text(
              uncensiaText("参考能力：%@ tokens 上下文 · %@ tokens 输出上限", String(describing: ref["contextWindow"]?.displayString ?? ""), String(describing: ref["maxTokens"]?.displayString ?? ""))
            )
            if let value = ref["sourceUrl"]?.stringValue, let url = URL(string: value) {
              Link(ref["source"]?.displayString ?? uncensiaText("打开来源"), destination: url)
            } else {
              Text(ref["source"]?.displayString ?? "")
            }
            Text(ref["note"]?.displayString ?? "").font(.caption).foregroundStyle(.secondary)
            Button(uncensiaText("采用参考能力")) { applyReference(.object(ref)) }
          }
        } else if !remoteModel.isEmpty {
          Section(uncensiaText("模型参考")) { Text(uncensiaText("没有此精确型号的参考资料，请按服务商文档填写。")) }
        }
        if model != nil { Section { Button(uncensiaText("删除模型"), role: .destructive) { remove() } } }
      }.navigationTitle(model == nil ? uncensiaText("添加模型") : uncensiaText("编辑模型")).toolbar {
        ToolbarItem(placement: .cancellationAction) { Button(uncensiaText("取消")) { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button(saving ? uncensiaText("正在保存…") : uncensiaText("保存")) { save() }.disabled(
            saving || providerID.isEmpty || remoteModel.isEmpty || validationError != nil)
        }
      }
    }.task(id: remoteModel) {
      guard let api = app.api, !remoteModel.isEmpty else { return }
      do {
        let r = try await api.request(
          "GET",
          "/model-reference?model=\(remoteModel.addingPercentEncoding(withAllowedCharacters:.urlQueryAllowed) ?? remoteModel)"
        )
        reference = r["reference"]
      } catch { reference = .null }
    }.onAppear { populate() }
  }
  func opBinding(_ op: String) -> Binding<Bool> {
    Binding(get: { ops.contains(op) }, set: { if $0 { ops.insert(op) } else { ops.remove(op) } })
  }
  func populate() {
    guard let m = model else {
      providerID = store.providers.first?["id"].displayString ?? ""
      return
    }
    id = m["id"].displayString
    name = m["name"].displayString
    providerID = m["providerId"].displayString
    remoteModel = m["model"].displayString
    kind = m["kind"].displayString
    apiMode = m["apiMode"].displayString
    enabled = m["enabled"].boolValue ?? true
    pinned = m["pinned"].boolValue ?? true
    agentTool = m["agentTool"].boolValue ?? false
    reasoning = m["reasoning"].boolValue ?? false
    imageInput = (m["input"].arrayValue ?? []).contains(.string("image"))
    contextWindow = m["contextWindow"].displayString
    maxTokens = m["maxTokens"].displayString
    thinking = m["thinkingLevel"].displayString
    systemPrompt = m["systemPrompt"].displayString
    temperature = m["temperature"].displayString
    topP = m["topP"].displayString
    pricingInput = m["pricing"]["input"].displayString
    pricingOutput = m["pricing"]["output"].displayString
    cacheRead = m["pricing"]["cacheRead"].displayString
    cacheWrite = m["pricing"]["cacheWrite"].displayString
    paramsJSON = jsonText(m["params"])
    compatJSON = jsonText(m["compat"])
    ops = Set((m["ops"].arrayValue ?? []).compactMap(\.stringValue))
  }
  func save() {
    guard let api = app.api else {
      formError = uncensiaText("尚未连接服务器")
      return
    }
    do {
      if let validationError { throw ModelFormError.message(validationError) }
      let params = try parseOptionalJSONObject(paramsJSON, field: uncensiaText("生成参数 JSON"))
      let compat = try parseOptionalJSONObject(compatJSON, field: uncensiaText("兼容参数 JSON"))
      guard let context = Int(contextWindow), context >= 1024 else {
        throw ModelFormError.message(uncensiaText("上下文长度必须是至少 1024 的整数"))
      }
      guard let maximum = Int(maxTokens), maximum > 0 else {
        throw ModelFormError.message(uncensiaText("最大输出必须是正整数"))
      }
      let temperatureValue = try optionalNumber(temperature, field: uncensiaText("温度"))
      let topPValue = try optionalNumber(topP, field: "Top P")
      let prices = try [pricingInput, pricingOutput, cacheRead, cacheWrite].enumerated().map {
        try optionalNumber($0.element, field: [uncensiaText("输入价格"), uncensiaText("输出价格"), uncensiaText("缓存读取价格"), uncensiaText("缓存写入价格")][$0.offset])
      }
      var body: [String: JSONValue] = [
        "name": .string(name.isEmpty ? remoteModel : name), "providerId": .string(providerID),
        "model": .string(remoteModel), "kind": .string(kind), "apiMode": .string(apiMode),
        "enabled": .bool(enabled), "pinned": .bool(pinned), "agentTool": .bool(agentTool),
        "reasoning": .bool(reasoning),
        "input": .strings(imageInput ? ["text", "image"] : ["text"]),
        "contextWindow": .integer(context),
        "maxTokens": .integer(maximum), "thinkingLevel": .string(thinking),
        "ops": .strings(Array(ops).sorted()),
        "systemPrompt": systemPrompt.isEmpty ? .null : .string(systemPrompt),
        "temperature": temperatureValue.map(JSONValue.number) ?? .null,
        "topP": topPValue.map(JSONValue.number) ?? .null,
        "pricing": .object([
          "input": prices[0].map(JSONValue.number) ?? .null,
          "output": prices[1].map(JSONValue.number) ?? .null,
          "cacheRead": prices[2].map(JSONValue.number) ?? .null,
          "cacheWrite": prices[3].map(JSONValue.number) ?? .null,
        ]),
        "params": params,
        "compat": compat,
      ]
      if model == nil && !id.isEmpty { body["id"] = .string(id) }
      saving = true
      formError = nil
      Task { @MainActor in
        do {
          _ = try await api.request(
            model == nil ? "POST" : "PATCH",
            model == nil ? "/models" : "/models/\(encodedPath(id))", body: .object(body))
          try await store.refreshModels(api)
          await app.refreshBootstrap()
          saving = false
          dismiss()
        } catch {
          saving = false
          formError = error.localizedDescription
        }
      }
    } catch { formError = error.localizedDescription }
  }
  func remove() {
    withAPI(app, store: store) { api in
      _ = try await api.request("DELETE", "/models/\(encodedPath(id))")
      try await store.refreshModels(api)
      dismiss()
    }
  }

  func jsonText(_ value: JSONValue) -> String {
    guard value != .null, let data = try? JSONEncoder().encode(value) else { return "" }
    return String(data: data, encoding: .utf8) ?? ""
  }
  var validationError: String? {
    do {
      _ = try parseOptionalJSONObject(paramsJSON, field: uncensiaText("生成参数 JSON"))
      _ = try parseOptionalJSONObject(compatJSON, field: uncensiaText("兼容参数 JSON"))
      _ = try optionalNumber(temperature, field: uncensiaText("温度"))
      _ = try optionalNumber(topP, field: "Top P")
      for (label, value) in [
        (uncensiaText("输入价格"), pricingInput), (uncensiaText("输出价格"), pricingOutput), (uncensiaText("缓存读取价格"), cacheRead),
        (uncensiaText("缓存写入价格"), cacheWrite),
      ] { _ = try optionalNumber(value, field: label) }
      guard let c = Int(contextWindow), c >= 1024 else { return uncensiaText("上下文长度必须是至少 1024 的整数") }
      guard let m = Int(maxTokens), m > 0 else { return uncensiaText("最大输出必须是正整数") }
      return nil
    } catch { return error.localizedDescription }
  }
  func applyReference(_ value: JSONValue) {
    contextWindow = value["contextWindow"].displayString
    maxTokens = value["maxTokens"].displayString
    imageInput = (value["input"].arrayValue ?? []).contains(.string("image"))
    reasoning = value["reasoning"].boolValue ?? false
  }
}

enum ModelFormError: LocalizedError {
  case message(String)
  var errorDescription: String? { if case .message(let value) = self { value } else { nil } }
}
func parseOptionalJSONObject(_ text: String, field: String) throws -> JSONValue {
  let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
  if trimmed.isEmpty { return .null }
  guard let data = trimmed.data(using: .utf8),
    let value = try? JSONDecoder().decode(JSONValue.self, from: data), value.objectValue != nil
  else { throw ModelFormError.message(uncensiaText("%@ 必须是有效的 JSON 对象", String(describing: field))) }
  return value
}
func optionalNumber(_ text: String, field: String) throws -> Double? {
  let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
  if trimmed.isEmpty { return nil }
  guard let value = Double(trimmed), value.isFinite else {
    throw ModelFormError.message(uncensiaText("%@ 必须是有效数字", String(describing: field)))
  }
  return value
}

private struct ModelDiscovery: View {
  let store: SettingsStore
  let app: AppModel
  let provider: JSONValue
  @Environment(\.dismiss) var dismiss
  @State var items: [JSONValue] = []
  @State var selected: Set<String> = []
  @State var loading = true
  var body: some View {
    NavigationStack {
      List(items, id: \.stableID) { item in
        let id = item["model"].displayString
        Toggle(
          isOn: Binding(
            get: { selected.contains(id) },
            set: { if $0 { selected.insert(id) } else { selected.remove(id) } })
        ) {
          VStack(alignment: .leading) {
            Text(id)
            Text(
              "\(item["suggestion"]["kind"].displayString) · \(item["suggestion"]["apiMode"].displayString)"
            ).font(.caption).foregroundStyle(.secondary)
          }
        }.disabled(item["added"].boolValue == true)
      }.overlay { if loading { ProgressView() } }.navigationTitle(uncensiaText("发现模型")).toolbar {
        ToolbarItem(placement: .cancellationAction) { Button(uncensiaText("取消")) { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button(uncensiaText("添加 %@ 个", String(describing: selected.count))) { add() }.disabled(selected.isEmpty)
        }
      }
    }.task {
      guard let api = app.api else { return }
      do {
        items =
          try await api.request(
            "GET", "/providers/\(encodedPath(provider["id"].displayString))/models")["items"]
          .arrayValue ?? []
      } catch { store.fail(error) }
      loading = false
    }
  }
  func add() {
    withAPI(app, store: store) { api in
      let bodies = items.filter { selected.contains($0["model"].displayString) }.map {
        item -> JSONValue in
        var s = item["suggestion"].objectValue ?? [:]
        s["model"] = item["model"]
        s["providerId"] = provider["id"]
        return .object(s)
      }
      _ = try await api.request(
        "POST", "/models/bulk",
        body: .object(["providerId": provider["id"], "models": .array(bodies)]))
      try await store.refreshModels(api)
      dismiss()
    }
  }
}
