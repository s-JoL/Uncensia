import QuickLook
import SwiftUI
import UniformTypeIdentifiers

struct StudioScreen: View {
  @Environment(AppModel.self) private var app
  @State private var store = StudioWorkspace()
  @State private var sourceSlot: SourceSlot?
  @State private var detail: StudioAsset?
  @State private var queuePresented = false
  @State private var galleryPresented = false

  var body: some View {
    @Bindable var store = store
    NavigationSplitView {
      Form {
        if !store.kinds.isEmpty {
          Picker(uncensiaText("创作方式"), selection: $store.kind) {
            ForEach(store.kinds, id: \.self) { Text(label(for: $0)).tag($0) }
          }.pickerStyle(.segmented)
        }
        Picker(uncensiaText("模型"), selection: $store.toolKey) {
          ForEach(store.toolsForKind) { tool in Text(tool.title).tag(tool.id) }
        }
        if let tool = store.selectedTool {
          Text(tool.summary).font(.caption).foregroundStyle(.secondary)
          if tool.schema["properties"]["source_image_id"] != .null {
            sourcePicker(
              title: tool.kind == "video" ? uncensiaText("首帧图片") : uncensiaText("原图"), key: "source_image_id", multiple: false)
          }
          if tool.schema["properties"]["additional_source_image_ids"] != .null {
            sourcePicker(title: uncensiaText("参考图片"), key: "additional_source_image_ids", multiple: true)
          }
          if tool.schema["properties"]["prompt"] != .null {
            SchemaControl(
              name: "prompt", schema: tool.schema["properties"]["prompt"],
              value: store.binding("prompt"), forcedTitle: uncensiaText("提示词"))
          }
          if tool.schema["properties"]["negative_prompt"] != .null {
            SchemaControl(
              name: "negative_prompt", schema: tool.schema["properties"]["negative_prompt"],
              value: store.binding("negative_prompt"), forcedTitle: uncensiaText("负面提示词"))
          }
          let ordinary = store.fields(audience: false)
          ForEach(ordinary, id: \.0) {
            SchemaControl(name: $0.0, schema: $0.1, value: store.binding($0.0))
          }
          let advanced = store.fields(audience: true)
          if !advanced.isEmpty {
            DisclosureGroup(uncensiaText("高级")) {
              ForEach(advanced, id: \.0) {
                SchemaControl(name: $0.0, schema: $0.1, value: store.binding($0.0))
              }
            }
          }
          Button {
            Task {
              await store.submit(api: app.api)
              queuePresented = true
            }
          } label: {
            Label(store.submitting ? uncensiaText("正在提交…") : uncensiaText("开始生成"), image: "lucide-sparkles")
          }.buttonStyle(.borderedProminent).disabled(!store.canSubmit || store.submitting)
        }
        if let error = store.failure { Text(error).foregroundStyle(.red).font(.caption) }
      }
      .navigationTitle(uncensiaText("创作台"))
      .toolbar {
        ToolbarItemGroup {
          Button {
            galleryPresented = true
          } label: {
            Label(uncensiaText("作品"), image: "lucide-images")
          }
          Button {
            queuePresented = true
          } label: {
            Label(
              uncensiaText("队列"), image: store.activeJobs.isEmpty ? "lucide-list-todo" : "lucide-clock")
          }
        }
      }
    } detail: {
      ScrollView {
        if store.loading && store.gallery.isEmpty {
          ProgressView(uncensiaText("正在读取创作台…")).padding(40)
        } else if !store.enabled {
          ContentUnavailableView(uncensiaText("创作台已关闭"), image: "lucide-paintbrush")
        } else if store.gallery.isEmpty {
          ContentUnavailableView(
            uncensiaText("还没有作品"), image: "lucide-images", description: Text(uncensiaText("选择模型，开始第一次创作。")))
        } else {
          LazyVGrid(columns: [GridItem(.adaptive(minimum: 155), spacing: 10)], spacing: 10) {
            ForEach(store.gallery) { asset in
              StudioTile(asset: asset, api: app.api).onTapGesture { detail = asset }
            }
          }.padding()
          if store.gallery.count < store.total {
            Button(uncensiaText("加载更多（%@/%@）", String(describing: store.gallery.count), String(describing: store.total))) {
              Task { await store.loadGallery(api: app.api, reset: false) }
            }.buttonStyle(.bordered).padding(.bottom)
          }
        }
      }.navigationTitle(uncensiaText("最近作品")).refreshable { await store.refresh(api: app.api) }
    }
    .task(id: app.api?.server) { await store.start(api: app.api) }
    .onChange(of: store.kind) {
      store.selectKind()
      store.persist(server: app.api?.server)
    }
    .onChange(of: store.toolKey) {
      store.selectTool()
      store.persist(server: app.api?.server)
    }
    .onChange(of: store.values) { store.persist(server: app.api?.server) }
    .sheet(item: $sourceSlot) { slot in
      SourceChooser(slot: slot, gallery: store.gallery.filter { $0.kind == "image" }, api: app.api)
      { ids in store.setSources(ids, key: slot.key, multiple: slot.multiple) }
    }
    .sheet(item: $detail) { asset in
      AssetDetail(
        asset: asset, api: app.api, repeatJob: { job in await store.repeatJob(job, api: app.api) },
        editJob: { job in store.open(job: job) })
    }
    .sheet(isPresented: $queuePresented) { JobQueue(store: store, api: app.api) }
    .sheet(isPresented: $galleryPresented) {
      CompactStudioGallery(store: store, api: app.api) {
        detail = $0
        galleryPresented = false
      }
    }
  }

  private func label(for kind: String) -> String {
    kind == "generate" ? uncensiaText("生成图片") : kind == "edit" ? uncensiaText("编辑图片") : uncensiaText("视频")
  }
  private func sourcePicker(title: String, key: String, multiple: Bool) -> some View {
    Section(title) {
      let ids = store.sourceIDs(key)
      if !ids.isEmpty {
        ScrollView(.horizontal) {
          HStack {
            ForEach(Array(ids.enumerated()), id: \.offset) { index, id in
              VStack {
                StudioRemoteImage(path: "/images/\(id)?w=160", api: app.api).frame(
                  width: 72, height: 72
                ).clipShape(RoundedRectangle(cornerRadius: 9))
                Text(uncensiaText("图片 %@", String(describing: index + 1))).font(.caption2)
              }
            }
          }
        }
      }
      HStack {
        Button(ids.isEmpty ? uncensiaText("选择或上传") : uncensiaText("更换")) {
          sourceSlot = SourceSlot(key: key, multiple: multiple)
        }
        if !ids.isEmpty {
          Button(uncensiaText("清除"), role: .destructive) { store.setSources([], key: key, multiple: multiple) }
        }
      }
    }
  }
}

private struct CompactStudioGallery: View {
  let store: StudioWorkspace
  let api: APIClient?
  let open: (StudioAsset) -> Void
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    NavigationStack {
      ScrollView {
        if store.gallery.isEmpty {
          ContentUnavailableView(uncensiaText("还没有作品"), image: "lucide-images")
        } else {
          LazyVGrid(columns: [GridItem(.adaptive(minimum: 145), spacing: 10)], spacing: 10) {
            ForEach(store.gallery) { asset in
              StudioTile(asset: asset, api: api).onTapGesture { open(asset) }
            }
          }.padding()
          if store.gallery.count < store.total {
            Button(uncensiaText("加载更多")) { Task { await store.loadGallery(api: api, reset: false) } }.buttonStyle(
              .bordered)
          }
        }
      }.navigationTitle(uncensiaText("最近作品")).toolbar { Button(uncensiaText("完成")) { dismiss() } }.refreshable {
        await store.loadGallery(api: api, reset: true)
      }
    }
  }
}

private struct StudioTool: Identifiable {
  let raw: JSONValue
  var id: String { "\(raw["serverId"].stringValue ?? "")/\(raw["name"].stringValue ?? "")" }
  var title: String { raw["serverTitle"].stringValue ?? id }
  var kind: String { raw["kind"].stringValue ?? "generate" }
  var modelID: String { raw["modelId"].stringValue ?? "" }
  var op: String { raw["op"].stringValue ?? raw["name"].stringValue ?? "" }
  var schema: JSONValue { raw["schema"] }
  var summary: String {
    [
      raw["local"].boolValue == true ? uncensiaText("本地") : uncensiaText("托管"),
      raw["configured"].boolValue == false ? uncensiaText("需要设置") : nil,
    ].compactMap { $0 }.joined(separator: " · ")
  }
}
private struct StudioAsset: Identifiable, Hashable {
  let raw: JSONValue
  var id: String { raw["assetId"].stringValue ?? raw["id"].stringValue ?? "" }
  var kind: String { raw["kind"].stringValue ?? (id.hasPrefix("vid_") ? "video" : "image") }
  var name: String { raw["name"].stringValue ?? id }
  var width: Int? { raw["width"].doubleValue.map(Int.init) }
  var height: Int? { raw["height"].doubleValue.map(Int.init) }
  var duration: Double? { raw["durationMs"].doubleValue }
  var posterID: String? { raw["posterAssetId"].stringValue ?? raw["poster_image_id"].stringValue }
}
private struct StudioJob: Identifiable {
  let raw: JSONValue
  var id: String { raw["id"].stringValue ?? "" }
  var status: String { raw["status"].stringValue ?? "" }
  var title: String { raw["modelName"].stringValue ?? raw["modelId"].stringValue ?? uncensiaText("任务") }
  var progress: Double? { raw["progress"].doubleValue }
  var error: String? { raw["error"].stringValue }
  var active: Bool { status == "queued" || status == "running" }
}

@MainActor @Observable private final class StudioWorkspace {
  var tools: [StudioTool] = []
  var gallery: [StudioAsset] = []
  var jobs: [StudioJob] = []
  var total = 0
  var enabled = true
  var loading = false
  var submitting = false
  var failure: String?
  var kind = "generate"
  var toolKey = ""
  var values: [String: JSONValue] = [:]
  private var polling: Task<Void, Never>?
  private var activeServer: URL?
  private var configuredToolKey = ""
  var kinds: [String] {
    ["generate", "edit", "video"].filter { k in tools.contains { $0.kind == k } }
  }
  var toolsForKind: [StudioTool] { tools.filter { $0.kind == kind } }
  var selectedTool: StudioTool? { tools.first { $0.id == toolKey } }
  var activeJobs: [StudioJob] { jobs.filter(\.active) }
  var canSubmit: Bool {
    guard let tool = selectedTool else { return false }
    return validateStudioValue(.object(values), against: tool.schema)
  }
  func start(api: APIClient?) async {
    loading = true
    defer { loading = false }
    guard let api else {
      failure = uncensiaText("请先连接服务器。")
      return
    }
    if activeServer != api.server {
      polling?.cancel()
      tools = []
      gallery = []
      jobs = []
      values = [:]
      toolKey = ""
      activeServer = api.server
    }
    do {
      let catalogue = try await api.request("GET", "/studio/tools")
      enabled = catalogue["enabled"].boolValue ?? true
      tools = catalogue["items"].arrayValue?.map(StudioTool.init) ?? []
      restore(server: api.server)
      if toolKey.isEmpty || selectedTool == nil {
        toolKey = tools.first?.id ?? ""
        kind = selectedTool?.kind ?? kinds.first ?? "generate"
        configuredToolKey = ""
        selectTool()
      } else {
        configuredToolKey = toolKey
      }
      async let galleryLoad: Void = loadGallery(api: api, reset: true)
      async let jobsLoad: Void = loadJobs(api: api)
      _ = await (galleryLoad, jobsLoad)
      beginPolling(api: api)
      failure = nil
    } catch { failure = error.localizedDescription }
  }
  func refresh(api: APIClient?) async { await start(api: api) }
  func loadGallery(api: APIClient?, reset: Bool) async {
    guard let api else { return }
    do {
      let offset = reset ? 0 : gallery.count
      let value = try await api.request("GET", "/studio/gallery?offset=\(offset)&limit=60")
      let page = value["items"].arrayValue?.map(StudioAsset.init) ?? []
      gallery = reset ? page : gallery + page
      total = Int(value["total"].doubleValue ?? 0)
    } catch { failure = error.localizedDescription }
  }
  func loadJobs(api: APIClient?) async {
    guard let api else { return }
    do {
      async let queued = api.request("GET", "/jobs?status=queued&limit=24")
      async let running = api.request("GET", "/jobs?status=running&limit=24")
      async let succeeded = api.request("GET", "/jobs?status=succeeded&limit=12")
      async let failed = api.request("GET", "/jobs?status=failed&limit=8")
      async let cancelled = api.request("GET", "/jobs?status=cancelled&limit=8")
      let values = try await (queued, running, succeeded, failed, cancelled)
      jobs = [values.0, values.1, values.2, values.3, values.4].flatMap {
        $0["items"].arrayValue ?? []
      }.map(StudioJob.init)
    } catch { failure = error.localizedDescription }
  }
  func selectTool() {
    guard toolKey != configuredToolKey, let tool = selectedTool else { return }
    configuredToolKey = toolKey
    kind = tool.kind
    values = defaults(schema: tool.schema)
  }
  func selectKind() {
    guard selectedTool?.kind != kind, let tool = tools.first(where: { $0.kind == kind }) else {
      return
    }
    toolKey = tool.id
  }
  func fields(audience advanced: Bool) -> [(String, JSONValue)] {
    guard let props = selectedTool?.schema["properties"].objectValue else { return [] }
    let hidden: Set<String> = [
      "prompt", "negative_prompt", "source_image_id", "additional_source_image_ids",
      "placement_key", "intent",
    ]
    return props.filter {
      !hidden.contains($0.key) && (($0.value["audience"].stringValue == "studio") == advanced)
    }.sorted { $0.key < $1.key }
  }
  func binding(_ key: String) -> Binding<JSONValue> {
    Binding(get: { self.values[key] ?? .null }, set: { self.values[key] = $0 })
  }
  func sourceIDs(_ key: String) -> [String] {
    if key == "source_image_id" { return values[key]?.stringValue.map { [$0] } ?? [] }
    return values[key]?.arrayValue?.compactMap(\.stringValue) ?? []
  }
  func setSources(_ ids: [String], key: String, multiple: Bool) {
    values[key] =
      multiple ? .array(ids.map(JSONValue.string)) : ids.first.map(JSONValue.string) ?? .null
  }
  func submit(api: APIClient?) async {
    guard let api, let tool = selectedTool else { return }
    submitting = true
    defer { submitting = false }
    var params = values
    let sources = sourceIDs("source_image_id") + sourceIDs("additional_source_image_ids")
    params.removeValue(forKey: "source_image_id")
    params.removeValue(forKey: "additional_source_image_ids")
    params = params.filter { $0.value != .null && $0.value.stringValue != "" }
    do {
      let job = try await api.request(
        "POST", "/jobs",
        body: .object([
          "modelId": .string(tool.modelID), "op": .string(tool.op), "params": .object(params),
          "sources": .array(sources.map(JSONValue.string)),
        ]))
      upsert(job)
      failure = nil
      beginPolling(api: api)
    } catch { failure = error.localizedDescription }
  }
  func cancel(_ job: StudioJob, api: APIClient?) async {
    guard let api else { return }
    do { upsert(try await api.request("POST", "/jobs/\(job.id)/cancel")) } catch {
      failure = error.localizedDescription
    }
  }
  func repeatJob(_ job: JSONValue, api: APIClient?) async {
    guard let api else { return }
    do {
      let value = try await api.request(
        "POST", "/jobs",
        body: .object([
          "modelId": job["modelId"], "op": job["op"], "params": job["params"],
          "sources": job["sources"],
        ]))
      upsert(value)
      beginPolling(api: api)
    } catch { failure = error.localizedDescription }
  }
  func open(job: JSONValue) {
    guard
      let tool = tools.first(where: {
        $0.modelID == job["modelId"].stringValue && $0.op == job["op"].stringValue
      })
    else {
      failure = uncensiaText("原模型已不可用。")
      return
    }
    configuredToolKey = tool.id
    toolKey = tool.id
    kind = tool.kind
    values = job["params"].objectValue ?? [:]
    let ids = job["sources"].arrayValue?.compactMap(\.stringValue) ?? []
    if let first = ids.first { values["source_image_id"] = .string(first) }
    if ids.count > 1 {
      values["additional_source_image_ids"] = .array(ids.dropFirst().map(JSONValue.string))
    }
  }
  private func upsert(_ raw: JSONValue) {
    let job = StudioJob(raw: raw)
    jobs.removeAll { $0.id == job.id }
    jobs.insert(job, at: 0)
    if job.status == "succeeded" {
      let assets = raw["assets"].arrayValue?.map(StudioAsset.init) ?? []
      gallery = assets + gallery.filter { old in !assets.contains { $0.id == old.id } }
      total = max(total, gallery.count)
    }
  }
  private func beginPolling(api: APIClient) {
    polling?.cancel()
    polling = Task {
      while !Task.isCancelled {
        let active = self.activeJobs
        if active.isEmpty { return }
        for job in active {
          if let raw = try? await api.request("GET", "/jobs/\(job.id)") { self.upsert(raw) }
        }
        try? await Task.sleep(for: .seconds(2))
      }
    }
  }
  private func defaults(schema: JSONValue) -> [String: JSONValue] {
    schema["properties"].objectValue?.reduce(into: [:]) { result, pair in
      if pair.value["default"] != .null {
        result[pair.key] = pair.value["default"]
      } else {
        result[pair.key] = blank(schema: pair.value)
      }
    } ?? [:]
  }
  private func blank(schema: JSONValue) -> JSONValue {
    switch schema["type"].stringValue {
    case "array": return .array([])
    case "object": return .object(defaults(schema: schema))
    case "boolean": return .bool(false)
    default: return .null
    }
  }
  func persist(server: URL?) {
    guard let server else { return }
    let envelope = JSONValue.object([
      "tool": .string(toolKey), "kind": .string(kind), "values": .object(values),
    ])
    if let data = try? JSONEncoder().encode(envelope) {
      UserDefaults.standard.set(data, forKey: draftKey(server))
    }
  }
  private func restore(server: URL) {
    guard let data = UserDefaults.standard.data(forKey: draftKey(server)),
      let draft = try? JSONDecoder().decode(JSONValue.self, from: data)
    else { return }
    toolKey = draft["tool"].stringValue ?? ""
    configuredToolKey = toolKey
    kind = draft["kind"].stringValue ?? "generate"
    values = draft["values"].objectValue ?? [:]
  }
  private func draftKey(_ server: URL) -> String {
    "uncensia.studio.draft." + Data(server.absoluteString.utf8).base64EncodedString()
  }
}

private struct SchemaControl: View {
  let name: String
  let schema: JSONValue
  @Binding var value: JSONValue
  var forcedTitle: String?
  init(name: String, schema: JSONValue, value: Binding<JSONValue>, forcedTitle: String? = nil) {
    self.name = name
    self.schema = schema
    _value = value
    self.forcedTitle = forcedTitle
  }
  var body: some View {
    let title =
      uncensiaText(forcedTitle ?? schema["title"].stringValue ?? name.replacingOccurrences(of: "_", with: " "))
    let concrete =
      schema["type"].stringValue == nil
      ? schema["anyOf"].arrayValue?.first(where: { $0["type"].stringValue != "null" }) ?? schema
      : schema
    Group {
      if let choices = concrete["enum"].arrayValue, !choices.isEmpty {
        Picker(
          title,
          selection: Binding(
            get: { value == .null ? "" : value.display },
            set: { next in value = choices.first(where: { $0.display == next }) ?? .null })
        ) {
          Text(uncensiaText("默认")).tag("")
          ForEach(Array(choices.enumerated()), id: \.offset) { _, choice in
            Text(choice.display).tag(choice.display)
          }
        }
      } else {
        switch concrete["type"].stringValue {
        case "boolean":
          Toggle(
            title, isOn: Binding(get: { value.boolValue ?? false }, set: { value = .bool($0) }))
        case "number", "integer": NumericField(title: title, schema: concrete, value: $value)
        case "array": ArrayControl(title: title, schema: concrete, value: $value)
        case "object": ObjectControl(title: title, schema: concrete, value: $value)
        default:
          if (concrete["maxLength"].doubleValue ?? 0) > 240 || name.contains("prompt") {
            VStack(alignment: .leading) {
              Text(title).font(.caption)
              TextEditor(text: stringBinding).frame(minHeight: name == "prompt" ? 130 : 80)
            }
          } else {
            TextField(title, text: stringBinding)
          }
        }
      }
    }
  }
  private var stringBinding: Binding<String> {
    Binding(get: { value.stringValue ?? "" }, set: { value = $0.isEmpty ? .null : .string($0) })
  }
}
private struct NumericField: View {
  let title: String
  let schema: JSONValue
  @Binding var value: JSONValue
  @State private var text = ""
  var body: some View {
    TextField(
      title,
      text: Binding(
        get: {
          value.doubleValue.map {
            schema["type"].stringValue == "integer" ? String(Int($0)) : String($0)
          } ?? text
        },
        set: {
          text = $0
          value = Double($0).map(JSONValue.number) ?? .null
        })
    ).keyboardType(.numbersAndPunctuation)
    if schema["minimum"] != .null || schema["maximum"] != .null {
      Text(uncensiaText("范围 %@–%@", String(describing: schema["minimum"].display), String(describing: schema["maximum"].display))).font(.caption2)
        .foregroundStyle(.secondary)
    }
  }
}
private struct ArrayControl: View {
  let title: String
  let schema: JSONValue
  @Binding var value: JSONValue
  var items: [JSONValue] { value.arrayValue ?? [] }
  var body: some View {
    Section(title) {
      if let choices = schema["items"]["enum"].arrayValue, !choices.isEmpty {
        ForEach(Array(choices.enumerated()), id: \.offset) { _, option in
          Toggle(
            option.display,
            isOn: Binding(
              get: { items.contains(option) },
              set: { on in value = .array(on ? items + [option] : items.filter { $0 != option }) }))
        }
      } else {
        ForEach(Array(items.enumerated()), id: \.offset) { index, _ in
          HStack {
            SchemaControl(
              name: "\(title) \(index + 1)", schema: schema["items"],
              value: Binding(
                get: { items.indices.contains(index) ? items[index] : .null },
                set: { next in
                  var copy = items
                  copy[index] = next
                  value = .array(copy)
                }))
            Button(role: .destructive) {
              var copy = items
              copy.remove(at: index)
              value = .array(copy)
            } label: {
              Image("lucide-circle-minus")
            }
          }
        }
        Button(uncensiaText("添加项目"), image: "lucide-plus") { value = .array(items + [.null]) }.disabled(
          schema["maxItems"].doubleValue.map { Int($0) <= items.count } ?? false)
      }
    }
  }
}
private struct ObjectControl: View {
  let title: String
  let schema: JSONValue
  @Binding var value: JSONValue
  var body: some View {
    Section(title) {
      if let properties = schema["properties"].objectValue, !properties.isEmpty {
        ForEach(properties.keys.sorted(), id: \.self) { key in
          SchemaControl(
            name: key, schema: properties[key]!,
            value: Binding(
              get: { value[key] },
              set: { next in
                var object = value.objectValue ?? [:]
                object[key] = next
                value = .object(object)
              }))
        }
      } else {
        Text(uncensiaText("无法用原生表单编辑未定义结构的对象参数。 ")).font(.caption)
          .foregroundStyle(.secondary)
      }
    }
  }
}

private struct SourceSlot: Identifiable {
  let key: String
  let multiple: Bool
  var id: String { key }
}
private struct SourceChooser: View {
  let slot: SourceSlot
  let gallery: [StudioAsset]
  let api: APIClient?
  let selected: ([String]) -> Void
  @Environment(\.dismiss) var dismiss
  @State private var chosen: [String] = []
  @State private var library: [StudioAsset] = []
  @State private var importing = false
  @State private var failure: String?
  private var choices: [StudioAsset] {
    var seen = Set<String>()
    return (gallery + library).filter { seen.insert($0.id).inserted }
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 110))]) {
          ForEach(choices) { asset in
            StudioTile(asset: asset, api: api).overlay(alignment: .topTrailing) {
              if let index = chosen.firstIndex(of: asset.id) {
                Text("\(index + 1)").padding(7).background(.tint, in: Circle()).foregroundStyle(
                  .white)
              }
            }.onTapGesture {
              if slot.multiple {
                if chosen.contains(asset.id) {
                  chosen.removeAll { $0 == asset.id }
                } else {
                  chosen.append(asset.id)
                }
              } else {
                selected([asset.id])
                dismiss()
              }
            }
          }
        }.padding()
      }.navigationTitle(uncensiaText("选择来源")).toolbar {
        ToolbarItem(placement: .primaryAction) { Button(uncensiaText("上传")) { importing = true } }
        if slot.multiple {
          ToolbarItem(placement: .confirmationAction) {
            Button(uncensiaText("使用 %@ 项", String(describing: chosen.count))) {
              selected(chosen)
              dismiss()
            }
          }
        }
      }.task {
        guard let api,
          let raw = try? await api.request(
            "GET", "/files?kind=images&source=all&limit=200&offset=0")
        else { return }
        library =
          raw["items"].arrayValue?.map {
            StudioAsset(
              raw: .object([
                "id": $0["id"], "assetId": $0["id"], "kind": .string("image"), "name": $0["name"],
                "width": $0["width"], "height": $0["height"],
              ]))
          } ?? []
      }.fileImporter(isPresented: $importing, allowedContentTypes: [.image]) { result in
        Task {
          do {
            let url = try result.get()
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let api else { return }
            let raw = try await api.upload(
              data: Data(contentsOf: url), filename: url.lastPathComponent,
              mimeType: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
                ?? "image/jpeg")
            let id = raw["id"].stringValue ?? ""
            if slot.multiple {
              chosen.append(id)
            } else {
              selected([id])
              dismiss()
            }
          } catch { failure = error.localizedDescription }
        }
      }
      if let failure { Text(failure).foregroundStyle(.red) }
    }
  }
}

private struct StudioTile: View {
  let asset: StudioAsset
  let api: APIClient?
  var body: some View {
    ZStack(alignment: .bottomLeading) {
      if asset.kind == "video" {
        if let poster = asset.posterID {
          StudioRemoteImage(path: "/images/\(poster)?w=320", api: api).overlay {
            Image("lucide-play").font(.largeTitle).foregroundStyle(.white).shadow(
              radius: 5)
          }
        } else {
          Color.black.overlay {
            Image("lucide-play").font(.largeTitle).foregroundStyle(.white)
          }
        }
      } else {
        StudioRemoteImage(path: "/images/\(asset.id)?w=320", api: api)
      }
      if asset.kind == "video" {
        Text(asset.duration.map { String(format: uncensiaText("%.1f 秒"), $0 / 1000) } ?? uncensiaText("视频")).font(.caption)
          .padding(5).background(.ultraThinMaterial, in: Capsule()).padding(6)
      }
    }.aspectRatio(
      asset.width.flatMap { w in asset.height.map { CGFloat(w) / CGFloat($0) } } ?? 1,
      contentMode: .fit
    ).clipShape(RoundedRectangle(cornerRadius: 12))
  }
}
private struct StudioRemoteImage: View {
  let path: String
  let api: APIClient?
  @State private var image: Image?
  var body: some View {
    Group {
      if let image {
        image.resizable().scaledToFill()
      } else {
        Rectangle().fill(.quaternary).overlay { ProgressView() }
      }
    }.clipped().task(id: path) {
      guard let data = try? await api?.download(path), let ui = UIImage(data: data) else { return }
      image = Image(uiImage: ui)
    }
  }
}

private struct JobQueue: View {
  let store: StudioWorkspace
  let api: APIClient?
  @Environment(\.dismiss) var dismiss
  var body: some View {
    NavigationStack {
      List(store.jobs) { job in
        VStack(alignment: .leading) {
          HStack {
            Text(job.title)
            Spacer()
            Text(localizedJobStatus(job.status)).font(.caption).foregroundStyle(.secondary)
          }
          if let progress = job.progress { ProgressView(value: progress) }
          if let error = job.error { Text(error).font(.caption).foregroundStyle(.red) }
          if job.active {
            Button(uncensiaText("取消"), role: .destructive) { Task { await store.cancel(job, api: api) } }
          }
        }
      }.navigationTitle(uncensiaText("生成队列")).toolbar { Button(uncensiaText("完成")) { dismiss() } }
    }
  }
}
private struct AssetDetail: View {
  let asset: StudioAsset
  let api: APIClient?
  let repeatJob: (JSONValue) async -> Void
  let editJob: (JSONValue) -> Void
  @Environment(\.dismiss) var dismiss
  @State private var provenance: JSONValue = .null
  @State private var localURL: URL?
  @State private var failure: String?
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 16) {
          if asset.kind == "image" {
            StudioRemoteImage(path: "/images/\(asset.id)?w=1280", api: api).scaledToFit().frame(
              maxHeight: 520
            ).clipShape(RoundedRectangle(cornerRadius: 13))
          } else if let localURL {
            QuickLookStudio(url: localURL).frame(height: 420)
          } else {
            ProgressView(uncensiaText("正在加载视频…"))
          }
          if provenance != .null {
            VStack(alignment: .leading, spacing: 8) {
              Text(provenance["job"]["params"]["prompt"].stringValue ?? uncensiaText("未记录提示词"))
                .textSelection(.enabled)
              Text(
                [provenance["job"]["modelName"].stringValue, provenance["provider"].stringValue]
                  .compactMap { $0 }.joined(separator: " · ")
              ).font(.caption).foregroundStyle(.secondary)
              if provenance["job"]["repeatable"].boolValue == true {
                HStack {
                  Button(uncensiaText("再次生成")) { Task { await repeatJob(provenance["job"]) } }.buttonStyle(
                    .borderedProminent)
                  Button(uncensiaText("调整参数")) {
                    editJob(provenance["job"])
                    dismiss()
                  }.buttonStyle(.bordered)
                }
              }
            }.frame(maxWidth: .infinity, alignment: .leading)
          }
          if let failure { Text(failure).foregroundStyle(.red) }
        }.padding()
      }.navigationTitle(asset.name).navigationBarTitleDisplayMode(.inline).toolbar {
        ToolbarItem(placement: .cancellationAction) { Button(uncensiaText("完成")) { dismiss() } }
        if let localURL {
          ToolbarItem(placement: .primaryAction) {
            ShareLink(item: localURL) { Image("lucide-share") }
          }
        }
      }.task {
        guard let api else { return }
        do {
          async let source = api.request(
            "GET", "/\(asset.kind == "video" ? "videos" : "images")/\(asset.id)/provenance")
          async let bytes = api.download(
            "/\(asset.kind == "video" ? "videos" : "images")/\(asset.id)")
          provenance = try await source
          let data = try await bytes
          let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            "uncensia-studio-\(UUID().uuidString)", isDirectory: true)
          try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
          let url = directory.appendingPathComponent(asset.name)
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

private func localizedJobStatus(_ status: String) -> String {
  let labels = [
    "queued": uncensiaText("排队中"), "running": uncensiaText("生成中"), "succeeded": uncensiaText("已完成"), "failed": uncensiaText("失败"), "cancelled": uncensiaText("已取消"),
  ]
  return labels[status] ?? status
}
private struct QuickLookStudio: UIViewControllerRepresentable {
  let url: URL
  func makeCoordinator() -> Coordinator { Coordinator(url) }
  func makeUIViewController(context: Context) -> QLPreviewController {
    let c = QLPreviewController()
    c.dataSource = context.coordinator
    return c
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
  fileprivate var display: String {
    switch self {
    case .string(let value): value
    case .number(let value): value.rounded() == value ? String(Int(value)) : String(value)
    case .bool(let value): value ? "Yes" : "No"
    case .null: "Default"
    case .array(let values): values.map(\.display).joined(separator: ", ")
    case .object: "Object"
    }
  }
}

/// Validates the subset of JSON Schema emitted by generation adapters. Keeping
/// this independent of SwiftUI makes the exact payload rules unit testable.
func validateStudioValue(_ value: JSONValue, against schema: JSONValue) -> Bool {
  if value == .null { return !(schema["required"].boolValue ?? false) }
  if let variants = schema["anyOf"].arrayValue, !variants.isEmpty {
    return variants.contains { validateStudioValue(value, against: $0) }
  }
  if let allowed = schema["enum"].arrayValue, !allowed.contains(value) { return false }
  switch schema["type"].stringValue {
  case "string":
    guard let text = value.stringValue else { return false }
    if let minimum = schema["minLength"].doubleValue, text.count < Int(minimum) { return false }
    if let maximum = schema["maxLength"].doubleValue, text.count > Int(maximum) { return false }
  case "number": guard let number = value.doubleValue, number.isFinite else { return false }
  case "integer":
    guard let number = value.doubleValue, number.isFinite, number.rounded() == number else {
      return false
    }
  case "boolean": guard value.boolValue != nil else { return false }
  case "array":
    guard let items = value.arrayValue else { return false }
    if let maximum = schema["maxItems"].doubleValue, items.count > Int(maximum) { return false }
    if schema["items"] != .null,
      !items.allSatisfy({ validateStudioValue($0, against: schema["items"]) })
    {
      return false
    }
  case "object":
    guard let object = value.objectValue else { return false }
    for required in schema["required"].arrayValue?.compactMap(\.stringValue) ?? [] {
      guard let child = object[required], child != .null, child.stringValue != "",
        child.arrayValue?.isEmpty != true
      else { return false }
    }
    for (key, childSchema) in schema["properties"].objectValue ?? [:] {
      if let child = object[key], child != .null, !validateStudioValue(child, against: childSchema)
      {
        return false
      }
    }
  default: break
  }
  if let number = value.doubleValue {
    if let minimum = schema["minimum"].doubleValue, number < minimum { return false }
    if let maximum = schema["maximum"].doubleValue, number > maximum { return false }
  }
  return true
}
