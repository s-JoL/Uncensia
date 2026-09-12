import Foundation

/// An upload belongs to the draft that started it. Navigating elsewhere must
/// leave that draft's operation running without disabling an unrelated composer.
struct ComposerUploadTracker {
    private struct Scope: Hashable {
        let server: URL
        let conversationID: String?
    }
    private var operations: [UUID: Scope] = [:]
    private var completed: [Scope: [JSONValue]] = [:]

    mutating func begin(server: URL, conversationID: String?, count: Int) -> [UUID] {
        let scope = Scope(server: server, conversationID: conversationID)
        return (0..<max(0, count)).map { _ in
            let ticket = UUID()
            operations[ticket] = scope
            return ticket
        }
    }

    func count(server: URL, conversationID: String?) -> Int {
        let scope = Scope(server: server, conversationID: conversationID)
        return operations.values.filter { $0 == scope }.count
    }

    mutating func finish(_ ticket: UUID) {
        operations.removeValue(forKey: ticket)
    }

    /// Keep a completion until its draft has actually been restored. Persisting
    /// it alone is insufficient when restoration already read an older snapshot.
    mutating func stage(_ attachment: JSONValue, server: URL, conversationID: String?) {
        let scope = Scope(server: server, conversationID: conversationID)
        if !completed[scope, default: []].contains(attachment) {
            completed[scope, default: []].append(attachment)
        }
    }

    mutating func takeCompleted(server: URL, conversationID: String?) -> [JSONValue] {
        completed.removeValue(forKey: Scope(server: server, conversationID: conversationID)) ?? []
    }
}
