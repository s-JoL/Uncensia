import Foundation
import Observation

@MainActor @Observable
final class SettingsStore {
  var loading = false
  var errorMessage: String?
  var successMessage: String?
  var providers: [JSONValue] = []
  var models: [JSONValue] = []
  var defaultModelID = ""
  var defaultImageModelID = ""
  var defaultEditModelID = ""
  var defaultVideoModelID = ""
  var mcpServers: [JSONValue] = []
  var mcpStatus: [JSONValue] = []
  var skills: [JSONValue] = []
  var skillDiagnostics: [String] = []
  var capabilities: JSONValue = .object([:])
  var prompts: JSONValue = .object([:])
  var promptDefaults: JSONValue = .object([:])
  var memory: JSONValue = .object([:])
  var tasks: [JSONValue] = []
  var security: JSONValue = .object([:])

  func load(using app: AppModel) async {
    guard let api = app.api else { return }
    loading = true
    defer { loading = false }
    do {
      async let providers = api.request("GET", "/providers")
      async let models = api.request("GET", "/models")
      async let mcp = api.request("GET", "/mcp/servers")
      async let skills = api.request("GET", "/skills")
      async let capabilities = api.request("GET", "/capabilities")
      async let prompts = api.request("GET", "/prompts")
      async let promptDefaults = api.request("GET", "/prompts/defaults")
      async let memory = api.request("GET", "/memory")
      async let tasks = api.request("GET", "/background-tasks")
      async let security = api.request("GET", "/security")
      let values = try await (
        providers, models, mcp, skills, capabilities, prompts, promptDefaults, memory, tasks,
        security
      )
      self.providers = values.0.arrayValue ?? []
      applyModels(values.1)
      self.mcpServers = values.2["items"].arrayValue ?? []
      self.mcpStatus = values.2["status"].arrayValue ?? []
      self.skills = values.3["items"].arrayValue ?? []
      self.skillDiagnostics = (values.3["diagnostics"].arrayValue ?? []).compactMap(\.stringValue)
      self.capabilities = values.4
      self.prompts = values.5
      self.promptDefaults = values.6
      self.memory = values.7
      self.tasks = values.8["items"].arrayValue ?? []
      self.security = values.9
    } catch { fail(error) }
  }

  func refreshModels(_ api: APIClient) async throws {
    applyModels(try await api.request("GET", "/models"))
  }
  func refreshProviders(_ api: APIClient) async throws {
    providers = try await api.request("GET", "/providers").arrayValue ?? []
  }
  func refreshMCP(_ api: APIClient) async throws {
    let v = try await api.request("GET", "/mcp/servers")
    mcpServers = v["items"].arrayValue ?? []
    mcpStatus = v["status"].arrayValue ?? []
  }
  func refreshSkills(_ api: APIClient) async throws {
    let v = try await api.request("GET", "/skills")
    skills = v["items"].arrayValue ?? []
    skillDiagnostics = (v["diagnostics"].arrayValue ?? []).compactMap(\.stringValue)
  }
  func refreshTasks(_ api: APIClient) async throws {
    tasks = try await api.request("GET", "/background-tasks")["items"].arrayValue ?? []
  }
  func refreshMemory(_ api: APIClient) async throws {
    memory = try await api.request("GET", "/memory")
  }
  func refreshSecurity(_ api: APIClient) async throws {
    security = try await api.request("GET", "/security")
  }
  func fail(_ error: Error) { errorMessage = error.localizedDescription }

  private func applyModels(_ value: JSONValue) {
    models = value["items"].arrayValue ?? []
    defaultModelID = value["defaultModelId"].stringValue ?? ""
    defaultImageModelID = value["defaultImageModelId"].stringValue ?? ""
    defaultEditModelID = value["defaultEditModelId"].stringValue ?? ""
    defaultVideoModelID = value["defaultVideoModelId"].stringValue ?? ""
  }
}

extension JSONValue {
  static func strings(_ values: [String]) -> JSONValue { .array(values.map(JSONValue.string)) }
  var displayString: String {
    switch self {
    case .string(let value): value
    case .number(let value): value.formatted()
    case .bool(let value): value ? uncensiaText("是") : uncensiaText("否")
    case .null: ""
    case .array(let value): value.map(\.displayString).joined(separator: ", ")
    case .object: ""
    }
  }

  var stableID: String {
    for key in ["id", "key", "model", "name", "title", "filePath"] {
      if let value = self[key].stringValue, !value.isEmpty { return "\(key):\(value)" }
    }
    return displayString
  }
}

extension JSONValue: Identifiable {
  public var id: String { stableID }
}

@MainActor func withAPI(
  _ app: AppModel, store: SettingsStore, operation: @escaping (APIClient) async throws -> Void
) {
  guard let api = app.api else {
    store.errorMessage = uncensiaText("尚未连接服务器")
    return
  }
  store.errorMessage = nil
  Task { @MainActor in
    store.loading = true
    defer { store.loading = false }
    do { try await operation(api) } catch { store.fail(error) }
    if store.errorMessage == nil { store.successMessage = uncensiaText("操作已完成") }
  }
}

func encodedPath(_ value: String) -> String {
  value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
}
