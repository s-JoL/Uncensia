import SwiftUI

struct BackgroundTaskDraft: Equatable {
  var prompt = ""
  var modelID = ""
  var mode = "once"
  var scheduled = false
  var runAt = Date().addingTimeInterval(300)
  var intervalMinutes = 60
  var maxRuns = 10
  var unlimited = false

  var isValid: Bool {
    !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && (mode != "interval" || (1...(366 * 24 * 60)).contains(intervalMinutes))
      && (mode == "once" || unlimited || (1...10_000).contains(maxRuns))
  }

  func payload(now: Date = Date()) -> JSONValue {
    var value: [String: JSONValue] = [
      "prompt": .string(prompt.trimmingCharacters(in: .whitespacesAndNewlines)),
      "runAt": .integer(Int((scheduled ? runAt : now).timeIntervalSince1970 * 1000)),
      "mode": .string(mode),
      "intervalMs": mode == "interval" ? .integer(intervalMinutes * 60_000) : .null,
      "maxRuns": mode == "once" ? .integer(1) : unlimited ? .null : .integer(maxRuns),
    ]
    if !modelID.isEmpty { value["modelId"] = .string(modelID) }
    return .object(value)
  }
}

struct BackgroundTasksSheet: View {
  @Environment(\.dismiss) private var dismiss
  let id: String?
  let api: APIClient?
  let app: AppModel
  @State private var tasks: [JSONValue] = []
  @State private var models: [JSONValue] = []
  @State private var draft = BackgroundTaskDraft()
  @State private var loading = false
  @State private var creating = false
  @State private var error: String?
  @FocusState private var promptFocused: Bool

  var body: some View {
    NavigationStack {
      List {
        creationSection
        if let error { Text(error).foregroundStyle(.red) }
        Section(uncensiaText("这段对话的任务")) {
          if loading && tasks.isEmpty { ProgressView() }
          if tasks.isEmpty && !loading { Text(uncensiaText("暂无后台任务")).foregroundStyle(.secondary) }
          ForEach(tasks, id: \.stableID) { task in
            BackgroundTaskCard(task: task, api: api) { await load() }
          }
        }
      }
      .navigationTitle(uncensiaText("后台任务"))
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button(uncensiaText("关闭")) { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button(uncensiaText("刷新")) { Task { await load() } }.disabled(loading)
        }
        ToolbarItemGroup(placement: .keyboard) {
          Spacer()
          Button(uncensiaText("完成")) { promptFocused = false }
            .accessibilityIdentifier("task.keyboardDone")
        }
      }
      .task { await poll() }
      .refreshable { await load() }
    }
  }

  private var creationSection: some View {
    Section(uncensiaText("新任务")) {
      TextField(uncensiaText("任务目标"), text: $draft.prompt, axis: .vertical).lineLimit(3...8)
        .focused($promptFocused)
        .accessibilityIdentifier("task.prompt")
      Picker(uncensiaText("模型"), selection: $draft.modelID) {
        Text(uncensiaText("沿用本对话模型")).tag("")
        ForEach(models, id: \.stableID) { model in
          Text(model["name"].stringValue ?? model["id"].stringValue ?? uncensiaText("模型"))
            .tag(model["id"].stringValue ?? "")
        }
      }
      Picker(uncensiaText("执行方式"), selection: $draft.mode) {
        Text(uncensiaText("一次执行")).tag("once")
        Text(uncensiaText("持续推进")).tag("continuous")
        Text(uncensiaText("定期执行")).tag("interval")
      }.accessibilityIdentifier("task.mode")
      Text(taskModeHelp(draft.mode)).font(.caption).foregroundStyle(.secondary)
      Toggle(uncensiaText("指定开始时间"), isOn: $draft.scheduled)
        .accessibilityIdentifier("task.scheduled")
      if draft.scheduled {
        DatePicker(uncensiaText("开始时间"), selection: $draft.runAt,
          in: Date()...Calendar.current.date(byAdding: .year, value: 1, to: Date())!)
      }
      if draft.mode == "interval" {
        TextField(uncensiaText("重复间隔（分钟）"), value: $draft.intervalMinutes, format: .number)
          .keyboardType(.numberPad)
      }
      if draft.mode != "once" {
        Toggle(uncensiaText("不限执行轮数"), isOn: $draft.unlimited)
        if !draft.unlimited {
          TextField(uncensiaText("最多执行轮数"), value: $draft.maxRuns, format: .number)
            .keyboardType(.numberPad)
        }
      }
      Button(creating ? uncensiaText("正在安排…") : uncensiaText("安排任务")) { create() }
        .disabled(creating || !draft.isValid)
        .accessibilityIdentifier("task.create")
    }
  }

  private func create() {
    guard let id, let api else { error = uncensiaText("请先打开一段对话"); return }
    let payload = draft.payload()
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    creating = true
    Task {
      defer { creating = false }
      do {
        _ = try await api.request("POST", "/conversations/\(urlPart(id))/background-tasks", body: payload)
        draft.prompt = ""
        error = nil
        await load()
      } catch { self.error = error.localizedDescription }
    }
  }

  private func poll() async {
    await load()
    while !Task.isCancelled {
      do { try await Task.sleep(for: .seconds(2.5)) } catch { return }
      await load(silent: true)
    }
  }

  private func load(silent: Bool = false) async {
    guard let id, let api else { error = uncensiaText("请先打开一段对话"); return }
    if !silent { loading = true }
    defer { if !silent { loading = false } }
    do {
      async let taskResult = api.request("GET", "/conversations/\(urlPart(id))/background-tasks")
      async let modelResult = api.request("GET", "/models")
      let (taskValue, modelValue) = try await (taskResult, modelResult)
      tasks = taskValue["items"].arrayValue ?? []
      models = (modelValue["items"].arrayValue ?? []).filter {
        ($0["kind"].stringValue ?? "chat") == "chat" && $0["enabled"].boolValue != false
          && $0["configured"].boolValue != false
      }
      error = nil
    } catch { if !silent { self.error = error.localizedDescription } }
  }
}

struct BackgroundTaskCard: View {
  let task: JSONValue
  let api: APIClient?
  let onChanged: @MainActor () async -> Void
  var onOpenConversation: (() -> Void)?
  @State private var actionPending = false
  @State private var history: [JSONValue]?
  @State private var historyLoading = false
  @State private var error: String?

  private var status: String { task["status"].stringValue ?? "" }
  private var taskID: String { task["id"].stringValue ?? "" }
  private var state: JSONValue { task["state"] }
  private var currentRunActive: Bool {
    ["queued", "running"].contains(task["currentRun"]["status"].stringValue ?? "")
  }
  private var capped: Bool {
    guard let maximum = state["maxRuns"].doubleValue else { return false }
    return (state["completedRuns"].doubleValue ?? 0) >= maximum
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text(taskModeLabel(state["mode"].stringValue)).font(.caption).padding(.horizontal, 8).padding(.vertical, 4)
          .background(.quaternary, in: Capsule())
        Text(taskStatus(status)).font(.caption).foregroundStyle(status == "failed" ? .red : .secondary)
      }
      Text(task["prompt"].stringValue ?? "").textSelection(.enabled)
      taskProgress
      if let failure = task["error"].stringValue { Text(failure).font(.caption).foregroundStyle(.red) }
      if let error { Text(error).font(.caption).foregroundStyle(.red) }
      controls
      if let history { runHistory(history) }
    }.padding(.vertical, 4).accessibilityIdentifier("task.card.\(taskID)")
  }

  private var taskProgress: some View {
    VStack(alignment: .leading, spacing: 4) {
      let completed = Int(state["completedRuns"].doubleValue ?? 0)
      if let maximum = state["maxRuns"].doubleValue {
        Text(uncensiaText("已完成 %@ / 最多 %@ 轮", String(completed), String(Int(maximum))))
      } else {
        Text(uncensiaText("已完成 %@ 轮 · 不限轮数", String(completed)))
      }
      if state["mode"].stringValue == "interval", let ms = state["intervalMs"].doubleValue {
        Text(uncensiaText("每 %@ 分钟", String(Int(ms / 60_000))))
      }
      if let stamp = task["runAt"].doubleValue, status == "pending" {
        Text(uncensiaText("下次执行：%@", formatTaskDate(stamp)))
      }
      if let summary = state["progress"]["summary"].stringValue {
        Text(uncensiaText("助手报告的进度")).foregroundStyle(.secondary)
        Text(summary)
      }
    }.font(.caption).foregroundStyle(.secondary)
  }

  private var controls: some View {
    HStack {
      if let onOpenConversation { Button(uncensiaText("查看对话与结果"), action: onOpenConversation) }
      if ["pending", "running"].contains(status) {
        Button(currentRunActive ? uncensiaText("本轮后暂停") : uncensiaText("暂停")) { control("pause") }
      }
      if ["paused", "failed"].contains(status), !capped {
        Button(uncensiaText("继续")) { control("resume") }.disabled(currentRunActive)
      }
      if !["completed", "cancelled"].contains(status) {
        Button(uncensiaText("取消任务"), role: .destructive) { cancel() }
      }
      Button(history == nil ? uncensiaText("执行记录") : uncensiaText("收起")) { toggleHistory() }
    }.font(.caption).buttonStyle(.borderless).disabled(actionPending)
  }

  private func runHistory(_ runs: [JSONValue]) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      if historyLoading { ProgressView() }
      if runs.isEmpty && !historyLoading { Text(uncensiaText("还没有开始执行")) }
      ForEach(runs, id: \.stableID) { run in
        Text("\(formatTaskDate(run["createdAt"].doubleValue)) · \(taskStatus(run["status"].stringValue))\(run["error"].stringValue.map { " · \($0)" } ?? "")")
      }
    }.font(.caption).foregroundStyle(.secondary).padding(.top, 4)
  }

  private func control(_ action: String) { perform("PATCH", body: .object(["action": .string(action)])) }
  private func cancel() { perform("DELETE") }
  private func perform(_ method: String, body: JSONValue? = nil) {
    guard let api, !taskID.isEmpty else { return }
    actionPending = true
    Task {
      defer { actionPending = false }
      do {
        _ = try await api.request(method, "/background-tasks/\(urlPart(taskID))", body: body)
        error = nil
        await onChanged()
      } catch { self.error = error.localizedDescription }
    }
  }

  private func toggleHistory() {
    if history != nil { history = nil; return }
    guard let api, !taskID.isEmpty else { return }
    historyLoading = true
    Task {
      defer { historyLoading = false }
      do { history = try await api.request("GET", "/background-tasks/\(urlPart(taskID))/runs")["items"].arrayValue ?? [] }
      catch { self.error = error.localizedDescription }
    }
  }
}

private func taskModeLabel(_ mode: String?) -> String {
  ["once": uncensiaText("一次执行"), "continuous": uncensiaText("持续推进"), "interval": uncensiaText("定期执行")][mode ?? ""]
    ?? mode ?? uncensiaText("未知")
}

private func taskModeHelp(_ mode: String) -> String {
  if mode == "continuous" { return uncensiaText("每轮保存进度，未完成时继续。完成、阻塞或达到轮数上限时停止。") }
  if mode == "interval" { return uncensiaText("按固定间隔执行；错过多次也只执行一次，不集中补跑。") }
  return uncensiaText("执行一次，关闭应用后仍会继续。")
}

private func formatTaskDate(_ milliseconds: Double?) -> String {
  guard let milliseconds else { return "" }
  return Date(timeIntervalSince1970: milliseconds / 1000).formatted(date: .abbreviated, time: .shortened)
}
