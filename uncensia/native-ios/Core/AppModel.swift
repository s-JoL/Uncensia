import Foundation
import Observation

@MainActor @Observable
public final class AppModel {
    public var api: APIClient?
    public var bootstrap: JSONValue = .object([:])
    public var pendingAttachments: [JSONValue] = []
    public struct ChatHandoff: Identifiable, Sendable {
        public let id = UUID()
        public let server: URL
        public let attachments: [JSONValue]
    }
    public private(set) var chatHandoff: ChatHandoff?
    public var selectedConversationID: String? {
        didSet {
            if let server = api?.server {
                UserDefaults.standard.set(selectedConversationID, forKey: "uncensia.selected.\(Data(server.absoluteString.utf8).base64EncodedString())")
            }
        }
    }
    public var bootstrapError: String?
    public var isReady = false
    public var selectedTab = "chat"
    public let drafts = DraftStore()
    public let credentials = CredentialVault()

    public init(api: APIClient? = nil) { self.api = api }

    public func startNewChat(attachments: [JSONValue]) {
        guard let server = api?.server else { return }
        // Keep incoming library items separate until the old draft has been saved.
        chatHandoff = ChatHandoff(server: server, attachments: attachments)
        selectedConversationID = nil
        selectedTab = "chat"
    }

    public func consumeChatHandoff(_ id: UUID) {
        guard let handoff = chatHandoff, handoff.id == id,
              handoff.server == api?.server, selectedConversationID == nil else { return }
        for item in handoff.attachments where !pendingAttachments.contains(item) {
            pendingAttachments.append(item)
        }
        chatHandoff = nil
    }

    public func connect(server: URL, token: String? = nil) throws {
        let changedServer = api?.server != server
        if changedServer { bootstrap = .object([:]); pendingAttachments = []; chatHandoff = nil; selectedConversationID = nil; isReady = false; bootstrapError = nil }
        if let token { try credentials.setToken(token, for: server) }
        let vault = credentials
        api = APIClient(server: server, token: { vault.token(for: server) }, tokenUpdated: { try vault.setToken($0, for: server) })
        UserDefaults.standard.set(server.absoluteString, forKey: "uncensia.server")
        selectedConversationID = UserDefaults.standard.string(forKey: "uncensia.selected.\(Data(server.absoluteString.utf8).base64EncodedString())")
    }

    public func refreshBootstrap() async {
        guard let api else { bootstrapError = uncensiaText("请先连接 Uncensia 服务"); return }
        do {
            let result = try await api.request("GET", "/bootstrap")
            guard self.api === api else { return }
            bootstrap = result; bootstrapError = nil; isReady = true
        }
        catch {
            guard self.api === api else { return }
            bootstrapError = error.localizedDescription
            if bootstrap.objectValue?.isEmpty != false { isReady = false }
        }
    }

    public func restoreConnection() async {
        guard let value = UserDefaults.standard.string(forKey: "uncensia.server"), let server = URL(string: value), credentials.token(for: server) != nil else { return }
        try? connect(server: server); await refreshBootstrap()
    }

    public func disconnect() throws {
        if let server = api?.server { try credentials.removeToken(for: server) }
        api = nil; bootstrap = .object([:]); pendingAttachments = []; chatHandoff = nil; selectedConversationID = nil; isReady = false
    }
}
