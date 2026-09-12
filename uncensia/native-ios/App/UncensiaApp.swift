import SwiftUI

@main struct UncensiaApp: App {
    @State private var model = AppModel()
    var body: some Scene { WindowGroup { RootView().environment(model) } }
}

struct RootView: View {
    @Environment(AppModel.self) private var app
    @State private var restoring = true
    var body: some View {
        @Bindable var app = app
        Group { if restoring { ProgressView(uncensiaText("正在连接…")) } else if app.isReady { TabView(selection: $app.selectedTab) { Tab(uncensiaText("对话"), image: "lucide-messages-square", value: "chat") { ChatScreen() }; Tab(uncensiaText("创作台"), image: "lucide-images", value: "studio") { StudioScreen() }; Tab(uncensiaText("项目"), image: "lucide-folder-closed", value: "projects") { ProjectsScreen() }; Tab(uncensiaText("资料库"), image: "lucide-file-text", value: "library") { LibraryScreen() }; Tab(uncensiaText("设置"), image: "lucide-settings-2", value: "settings") { SettingsScreen() } } } else { SignInView() } }
        .task { await automaticConnection() }
    }
    private func automaticConnection() async {
        defer { restoring = false }
        let environment = ProcessInfo.processInfo.environment
        guard let raw = environment["UNCENSIA_SERVER_URL"], let server = URL(string: raw) else { await app.restoreConnection(); return }
        try? app.connect(server: server)
        // A restarted isolated fixture reuses its URL but invalidates the old
        // simulator Keychain token. An explicitly supplied test access code is
        // authoritative and must refresh that credential every launch.
        if let code = environment["UNCENSIA_ACCESS_CODE"] {
            if let response = try? await app.api?.request("POST", "/auth/token", body: .object(["accessCode": .string(code), "deviceName": .string("iOS") ])), let token = response["token"].stringValue { try? app.connect(server: server, token: token) }
        }
        #if DEBUG
        if let id = environment["UNCENSIA_TEST_CONVERSATION_ID"] {
            if environment["UNCENSIA_TEST_CLEAR_DRAFT"] == "1" { await app.drafts.clear(server: server, conversationID: id) }
            app.selectedConversationID = id
        }
        #endif
        await app.refreshBootstrap()
    }
}

private struct SignInView: View {
    @Environment(AppModel.self) private var app
    @State private var server = "http://127.0.0.1:8090"
    @State private var code = ""
    @State private var totp = ""
    @State private var error = ""
    var body: some View { NavigationStack { Form { Section(uncensiaText("Uncensia 服务")) { TextField(uncensiaText("服务器地址"), text: $server).textInputAutocapitalization(.never).keyboardType(.URL); SecureField(uncensiaText("访问码"), text: $code); TextField(uncensiaText("动态验证码（如已启用）"), text: $totp).keyboardType(.numberPad) }; if !error.isEmpty { Text(error).foregroundStyle(.red) }; Button(uncensiaText("连接")) { connect() }.buttonStyle(.borderedProminent).disabled(server.isEmpty || code.isEmpty) }.navigationTitle(uncensiaText("连接 Uncensia")) } }
    private func connect() { Task { do { guard let url = URL(string: server) else { throw URLError(.badURL) }; try app.connect(server: url); var body: [String: JSONValue] = ["accessCode": .string(code), "deviceName": .string("iOS")]; if !totp.isEmpty { body["totp"] = .string(totp) }; let response = try await app.api!.request("POST", "/auth/token", body: .object(body)); guard let token = response["token"].stringValue else { throw URLError(.userAuthenticationRequired) }; try app.connect(server: url, token: token); await app.refreshBootstrap(); if let failure = app.bootstrapError { throw APIError(status: 0, code: "bootstrap", message: failure) } } catch { self.error = error.localizedDescription } } }
}
