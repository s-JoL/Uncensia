import SwiftUI

struct SecuritySettingsView: View {
  let store: SettingsStore
  let appModel: AppModel
  @State private var newAccessCode = ""
  @State private var pending: SecurityAction?
  @State private var enrolment: JSONValue?
  @State private var confirmCode = ""
  var body: some View {
    List {
      Section(uncensiaText("访问码")) {
        LabeledContent(
          uncensiaText("传输"), value: store.security["overTls"].boolValue == true ? "HTTPS" : uncensiaText("明文 HTTP"))
        SecureField(uncensiaText("新的访问码（至少 12 位）"), text: $newAccessCode)
        Button(uncensiaText("保存访问码")) { pending = .accessCode(newAccessCode) }.disabled(newAccessCode.count < 12)
      }
      Section(uncensiaText("两步验证")) {
        if store.security["totpEnabled"].boolValue == true {
          Label(uncensiaText("已开启"), systemImage: "checkmark.shield.fill").foregroundStyle(.green)
          Button(uncensiaText("关闭两步验证"), role: .destructive) { pending = .disableTOTP }
        } else if let enrolment {
          Text(uncensiaText("在验证器中添加密钥，再输入当前动态码。"))
          LabeledContent(uncensiaText("密钥"), value: enrolment["secret"].displayString)
          Text(enrolment["uri"].displayString).font(.caption).textSelection(.enabled)
          TextField(uncensiaText("6 位动态码"), text: $confirmCode).keyboardType(.numberPad)
          Button(uncensiaText("完成绑定")) { confirmTOTP() }.disabled(confirmCode.count < 6)
          Button(uncensiaText("取消")) { self.enrolment = nil }
        } else {
          Text(uncensiaText("开启后，登录需要访问码和验证器动态码。")).foregroundStyle(.secondary)
          Button(uncensiaText("开始绑定")) { pending = .startTOTP }
        }
      }
      Section(uncensiaText("登录设备（%@）", String(describing: (store.security["sessions"].arrayValue ?? []).count))) {
        Button(uncensiaText("注销其他设备")) { pending = .revokeOthers }.disabled(
          (store.security["sessions"].arrayValue ?? []).count < 2)
        ForEach(store.security["sessions"].arrayValue ?? [], id: \.stableID) { session in
          HStack {
            VStack(alignment: .leading) {
              Text(session["device"].displayString)
              Text(uncensiaText("最近活跃 %@", String(describing: date(session["lastSeen"].doubleValue)))).font(.caption).foregroundStyle(
                .secondary)
            }
            Spacer()
            if session["id"] == store.security["currentSessionId"] {
              Text(uncensiaText("当前设备")).font(.caption).foregroundStyle(.green)
            } else {
              Button(uncensiaText("注销"), role: .destructive) {
                pending = .revokeSession(session["id"].displayString)
              }
            }
          }
        }
      }
      Section(uncensiaText("对外访问")) {
        LabeledContent(
          uncensiaText("反向代理"), value: store.security["trustProxy"].boolValue == true ? uncensiaText("已信任") : uncensiaText("仅本机地址"))
        Text(uncensiaText("通过反向代理公开服务时设置 UNCENSIA_TRUST_PROXY=1，让登录限速按真实来源统计。")).font(.caption).foregroundStyle(
          .secondary)
      }
    }.sheet(item: $pending) { action in
      StepUpSheet(totpRequired: store.security["totpEnabled"].boolValue == true, action: action) {
        access, totp in try await perform(action, access: access, totp: totp)
      }
    }
  }
  func headers(_ access: String, _ totp: String) -> [String: String] {
    var h = ["x-uncensia-access-code": access]
    if !totp.isEmpty { h["x-uncensia-totp"] = totp }
    return h
  }
  func perform(_ action: SecurityAction, access: String, totp: String) async throws {
    guard let api = appModel.api else { throw URLError(.notConnectedToInternet) }
    let h = headers(access, totp)
    switch action {
    case .accessCode(let value):
      store.security = try await api.request(
        "PUT", "/security/access-code", body: .object(["value": .string(value)]), headers: h)
      newAccessCode = ""
    case .startTOTP: enrolment = try await api.request("POST", "/security/totp", headers: h)
    case .disableTOTP:
      store.security = try await api.request(
        "DELETE", "/security/totp", body: .object(["code": .string(totp)]), headers: h)
    case .revokeOthers:
      store.security = try await api.request("POST", "/security/sessions/revoke-others", headers: h)
    case .revokeSession(let id):
      store.security = try await api.request(
        "DELETE", "/security/sessions/\(encodedPath(id))", headers: h)
    }
  }
  func confirmTOTP() {
    withAPI(appModel, store: store) { api in
      store.security = try await api.request(
        "POST", "/security/totp/confirm", body: .object(["code": .string(confirmCode)]))
      confirmCode = ""
      enrolment = nil
    }
  }
  func date(_ ms: Double?) -> String {
    guard let ms else { return "" }
    return Date(timeIntervalSince1970: ms / 1000).formatted(date: .abbreviated, time: .shortened)
  }
}

enum SecurityAction: Identifiable {
  case accessCode(String)
  case startTOTP, disableTOTP, revokeOthers
  case revokeSession(String)
  var id: String {
    switch self {
    case .accessCode: "access"
    case .startTOTP: "start"
    case .disableTOTP: "disable"
    case .revokeOthers: "others"
    case .revokeSession(let id): "session-\(id)"
    }
  }
  var title: String {
    switch self {
    case .accessCode: uncensiaText("修改访问码")
    case .startTOTP: uncensiaText("开始绑定验证器")
    case .disableTOTP: uncensiaText("关闭两步验证")
    case .revokeOthers: uncensiaText("注销其他设备")
    case .revokeSession: uncensiaText("注销设备")
    }
  }
}

private struct StepUpSheet: View {
  let totpRequired: Bool
  let action: SecurityAction
  let perform: (String, String) async throws -> Void
  @Environment(\.dismiss) var dismiss
  @State var access = ""
  @State var totp = ""
  @State var error = ""
  @State var busy = false
  var body: some View {
    NavigationStack {
      Form {
        Section {
          Text(uncensiaText("这项改动需要再次确认身份。")).foregroundStyle(.secondary)
          SecureField(uncensiaText("当前访问码"), text: $access)
          if totpRequired { TextField(uncensiaText("验证器动态码"), text: $totp).keyboardType(.numberPad) }
          if !error.isEmpty { Text(error).foregroundStyle(.red) }
        }
      }.navigationTitle(action.title).toolbar {
        ToolbarItem(placement: .cancellationAction) { Button(uncensiaText("取消")) { dismiss() }.disabled(busy) }
        ToolbarItem(placement: .confirmationAction) {
          Button(busy ? uncensiaText("确认中…") : uncensiaText("确认")) { submit() }.disabled(
            access.isEmpty || (totpRequired && totp.count < 6) || busy)
        }
      }
    }
  }
  func submit() {
    busy = true
    error = ""
    Task { @MainActor in
      do {
        try await perform(access, totp)
        dismiss()
      } catch let api as APIError where api.code == "step_up_required" || api.code == "bad_step_up"
      {
        error = api.code == "bad_step_up" ? uncensiaText("访问码或动态码不正确，请使用最新动态码。") : uncensiaText("需要访问码和当前动态码。")
        totp = ""
      } catch let caught { error = caught.localizedDescription }
      busy = false
    }
  }
}
