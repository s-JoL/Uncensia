import Foundation

public struct Conversation: Identifiable, Sendable, Equatable {
    public let id: String
    public var title: String
    public var modelID: String
    public var updatedAt: Double
    public init?(_ json: JSONValue) {
        guard let id = json["id"].stringValue else { return nil }
        self.id = id; title = json["title"].stringValue ?? uncensiaText("新对话"); modelID = json["modelId"].stringValue ?? ""; updatedAt = json["updatedAt"].doubleValue ?? 0
    }
}

public struct ChatMessage: Identifiable, Sendable, Equatable {
    public let id: String
    public let seq: Int
    public let role: String
    public let content: JSONValue
    public let raw: JSONValue
    public let text: String
    public init?(_ json: JSONValue) {
        guard let id = json["id"].stringValue else { return nil }
        self.id = id; seq = json["seq"].intValue ?? 0; role = json["role"].stringValue ?? "assistant"; content = json["content"]; raw = json
        text = Self.text(from: json["content"])
    }
    private static func text(from value: JSONValue) -> String {
        if let text = value.stringValue { return text }
        if let nested = value["content"].stringValue { return nested }
        let parts = value["content"].arrayValue ?? value.arrayValue ?? []
        return parts.compactMap { part in
            guard ["text", "thinking"].contains(part["type"].stringValue ?? "") else { return nil }
            return part["text"].stringValue ?? part["thinking"].stringValue
        }.joined(separator: "\n")
    }
}

public struct ApprovalItem: Identifiable, Sendable, Equatable {
    public let id: String; public let summary: String; public let action: String; public let status: String
    public init?(_ json: JSONValue) { guard let id = json["id"].stringValue else { return nil }; self.id = id; summary = json["summary"].stringValue ?? uncensiaText("等待确认"); action = json["action"].stringValue ?? ""; status = json["status"].stringValue ?? "pending" }
}
