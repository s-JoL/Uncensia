import Foundation
import Security

public final class CredentialVault: @unchecked Sendable {
    public enum VaultError: Error { case keychain(OSStatus) }
    public init() {}
    private func account(server: URL) -> String { server.absoluteString.lowercased() }
    public func token(for server: URL) -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "app.uncensia.session", kSecAttrAccount as String: account(server: server), kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    public func setToken(_ token: String, for server: URL) throws {
        let key: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "app.uncensia.session", kSecAttrAccount as String: account(server: server)]
        SecItemDelete(key as CFDictionary)
        var item = key
        item[kSecValueData as String] = Data(token.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw VaultError.keychain(status) }
    }
    public func removeToken(for server: URL) throws {
        let status = SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "app.uncensia.session", kSecAttrAccount as String: account(server: server)] as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw VaultError.keychain(status) }
    }
}

public struct Draft: Codable, Sendable, Equatable { public var text = ""; public var attachments: [JSONValue] = [] }

public actor DraftStore {
    private let defaults: UserDefaults
    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    private func key(server: URL, conversationID: String?) -> String {
        let scope = Data(server.absoluteString.utf8).base64EncodedString()
        return "uncensia.draft.\(scope).\(conversationID ?? "new")"
    }
    public func load(server: URL, conversationID: String?) -> Draft {
        guard let data = defaults.data(forKey: key(server: server, conversationID: conversationID)) else { return Draft() }
        return (try? JSONDecoder().decode(Draft.self, from: data)) ?? Draft()
    }
    public func save(_ draft: Draft, server: URL, conversationID: String?) {
        defaults.set(try? JSONEncoder().encode(draft), forKey: key(server: server, conversationID: conversationID))
    }
    public func clear(server: URL, conversationID: String?) { defaults.removeObject(forKey: key(server: server, conversationID: conversationID)) }
}
