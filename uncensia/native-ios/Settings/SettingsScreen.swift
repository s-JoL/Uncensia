import SwiftUI

public struct SettingsScreen: View {
  @Environment(AppModel.self) private var appModel
  @State private var store = SettingsStore()
  @State private var selection: SettingsDestination? = .overview

  public init() {}

  public var body: some View {
    NavigationSplitView {
      List(SettingsDestination.allCases, selection: $selection) { item in
        Label(item.title, image: item.icon).tag(item)
      }
      .navigationTitle(uncensiaText("设置"))
    } detail: {
      Group {
        if let selection {
          SettingsDetail(destination: selection, store: store, appModel: appModel)
        } else {
          ContentUnavailableView(uncensiaText("选择一项设置"), image: "lucide-settings-2")
        }
      }
    }
    .task { await store.load(using: appModel) }
    .alert(
      uncensiaText("操作失败"),
      isPresented: Binding(
        get: { store.errorMessage != nil },
        set: { if !$0 { store.errorMessage = nil } }
      )
    ) {
      Button(uncensiaText("好")) { store.errorMessage = nil }
    } message: {
      Text(store.errorMessage ?? uncensiaText("未知错误"))
    }
    .alert(
      uncensiaText("完成"),
      isPresented: Binding(
        get: { store.successMessage != nil },
        set: { if !$0 { store.successMessage = nil } }
      )
    ) {
      Button(uncensiaText("好")) { store.successMessage = nil }
    } message: {
      Text(store.successMessage ?? "")
    }
  }
}

enum SettingsDestination: String, CaseIterable, Identifiable {
  case overview, providers, models, extensions, skills, capabilities, tasks, prompts, memory,
    security
  var id: String { rawValue }
  var title: String {
    switch self {
    case .overview: uncensiaText("常用设置")
    case .providers: uncensiaText("连接服务")
    case .models: uncensiaText("模型")
    case .extensions: uncensiaText("扩展连接")
    case .skills: uncensiaText("技能")
    case .capabilities: uncensiaText("工具与权限")
    case .tasks: uncensiaText("定时任务")
    case .prompts: uncensiaText("个性化")
    case .memory: uncensiaText("记忆")
    case .security: uncensiaText("访问与登录")
    }
  }
  var icon: String {
    switch self {
    case .overview: "lucide-sliders-horizontal"
    case .providers: "lucide-network"
    case .models: "lucide-cpu"
    case .extensions: "lucide-box"
    case .skills: "lucide-sparkles"
    case .capabilities: "lucide-wrench"
    case .tasks: "lucide-clock"
    case .prompts: "lucide-quote"
    case .memory: "lucide-brain"
    case .security: "lucide-shield"
    }
  }
}

private struct SettingsDetail: View {
  let destination: SettingsDestination
  let store: SettingsStore
  let appModel: AppModel

  var body: some View {
    Group {
      if store.loading && store.providers.isEmpty {
        ProgressView(uncensiaText("正在加载…"))
      } else {
        switch destination {
        case .overview: OverviewSettingsView(store: store)
        case .providers: ProvidersSettingsView(store: store, appModel: appModel)
        case .models: ModelsSettingsView(store: store, appModel: appModel)
        case .extensions: MCPSettingsView(store: store, appModel: appModel)
        case .skills: SkillsSettingsView(store: store, appModel: appModel)
        case .capabilities: CapabilitiesSettingsView(store: store, appModel: appModel)
        case .tasks: TasksSettingsView(store: store, appModel: appModel)
        case .prompts: PromptsSettingsView(store: store, appModel: appModel)
        case .memory: MemorySettingsView(store: store, appModel: appModel)
        case .security: SecuritySettingsView(store: store, appModel: appModel)
        }
      }
    }
    .navigationTitle(destination.title)
    .disabled(store.loading)
    .toolbar { ToolbarItem(placement: .primaryAction) { if store.loading { ProgressView() } } }
  }
}
