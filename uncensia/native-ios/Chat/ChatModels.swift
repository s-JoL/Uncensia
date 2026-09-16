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

/// A dialog an extension opened through Pi's `ui.select` / `ui.confirm` / `ui.input`. Not an approval: nothing destructive is waiting, the extension just needs a word from the reader.
public struct QuestionItem: Identifiable, Sendable, Equatable {
    public let id: String; public let kind: String; public let title: String; public let message: String; public let options: [String]; public let placeholder: String; public let status: String; public let answer: String?
    public init?(_ json: JSONValue) {
        guard let id = json["id"].stringValue else { return nil }
        self.id = id; kind = json["kind"].stringValue ?? "input"; title = json["title"].stringValue ?? ""; message = json["message"].stringValue ?? ""
        options = json["options"].arrayValue?.compactMap(\.stringValue) ?? []; placeholder = json["placeholder"].stringValue ?? ""; status = json["status"].stringValue ?? "pending"
        answer = json["answer"].stringValue
    }
    public var isPending: Bool { status == "pending" }
    /// Web keeps a settled card in place with its outcome; the same copy here.
    public var settledLabel: String {
        switch status {
        case "answered":
            if kind == "confirm" { return answer == "yes" ? uncensiaText("已确认") : uncensiaText("已否决") }
            return uncensiaText("已回答：%@", answer ?? "")
        case "expired": return uncensiaText("已超时，扩展未收到回答")
        default: return uncensiaText("已跳过，扩展未收到回答")
        }
    }
}
