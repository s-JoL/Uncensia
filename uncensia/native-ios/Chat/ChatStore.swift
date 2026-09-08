import Foundation
import Observation

@MainActor @Observable
public final class ChatStore {
    public var conversations: [Conversation] = []
    public var messages: [ChatMessage] = []
    public var draft = ""
    public var liveText = ""
    public var liveStatus = ""
    public var liveThinking = ""
    public var liveTools: [JSONValue] = []
    public var isRunning = false
    public var isLoading = false
    public var isSending = false
    public var error: String?
    public var approvals: [ApprovalItem] = []
    public var conversationDetails: JSONValue = .null
    public var selectedModelID = ""
    public var olderCursor: Int?
    private var followTask: Task<Void, Never>?
    private var pendingDelta = ""
    private var flushTask: Task<Void, Never>?
    private var pendingSend: (fingerprint: String, key: String)?
    private var followGeneration = UUID()
    private var revision: Double = -1

    public init() {}

    public func loadConversations(api: APIClient) async {
        do { conversations = (try await api.request("GET", "/conversations?limit=100"))["items"].arrayValue?.compactMap(Conversation.init) ?? [] }
        catch { self.error = error.localizedDescription }
    }

    public func open(id: String, app: AppModel) async {
        guard let api = app.api else { return }
        followTask?.cancel(); flushTask?.cancel(); pendingDelta = ""; followGeneration = UUID(); isRunning = false; liveText = ""; liveThinking = ""; liveTools = []; liveStatus = ""; messages = []; approvals = []; conversationDetails = .null; olderCursor = nil; isLoading = true; error = nil
        let generation = followGeneration
        defer { if generation == followGeneration { isLoading = false } }
        do {
            let saved = await app.drafts.load(server: api.server, conversationID: id)
            guard generation == followGeneration, app.selectedConversationID == id else { return }
            draft = saved.text; app.pendingAttachments = saved.attachments
            async let detail = api.request("GET", "/conversations/\(id)")
            async let log = api.request("GET", "/conversations/\(id)/messages?limit=60")
            async let approvalList = api.request("GET", "/conversations/\(id)/approvals")
            let (summary, page, waiting) = try await (detail, log, approvalList)
            guard generation == followGeneration, app.selectedConversationID == id else { return }
            conversationDetails = summary; revision = summary["updatedAt"].doubleValue ?? -1; selectedModelID = summary["modelId"].stringValue ?? ""
            messages = page["items"].arrayValue?.compactMap(ChatMessage.init) ?? []
            olderCursor = page["nextCursor"].intValue
            approvals = waiting["items"].arrayValue?.compactMap(ApprovalItem.init) ?? []
            if let runID = summary["activeRun"]["id"].stringValue { follow(runID: runID, after: summary["activeRun"]["resumeSeq"].intValue ?? 0, id: id, api: api, generation: generation) }
        } catch { if generation == followGeneration { self.error = error.localizedDescription } }
    }

    @discardableResult public func loadOlder(id: String, api: APIClient) async -> Bool {
        guard let cursor = olderCursor else { return false }
        let generation = followGeneration
        do {
            let page = try await api.request("GET", "/conversations/\(id)/messages?limit=60&before=\(cursor)")
            let older = page["items"].arrayValue?.compactMap(ChatMessage.init) ?? []
            guard generation == followGeneration else { return false }
            messages = older + messages
            olderCursor = page["nextCursor"].intValue
            return true
        } catch { if generation == followGeneration { self.error = error.localizedDescription }; return false }
    }

    public func send(app: AppModel, modelID: String? = nil, fromSeq: Int? = nil) async {
        guard let api = app.api else { return }
        guard !isSending else { return }
        isSending = true
        defer { isSending = false }
        var id = app.selectedConversationID
        do {
            if id == nil {
                let created = try await api.request("POST", "/conversations", body: .object(["modelId": modelID.map(JSONValue.string) ?? .null]))
                id = created["id"].stringValue; app.selectedConversationID = id
                await loadConversations(api: api)
            }
            guard let id else { return }
            let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return }
            let fileIDs = app.pendingAttachments.compactMap { $0["file"]["id"].stringValue ?? $0["id"].stringValue }
            var payload: [String: JSONValue] = ["text": .string(text), "attachments": .array(fileIDs.map(JSONValue.string))]
            let references = app.pendingAttachments.compactMap { item -> JSONValue? in
                let file = item["file"].objectValue == nil ? item : item["file"]
                guard let imageID = file["id"].stringValue, (file["mime"].stringValue ?? "").hasPrefix("image/") else { return nil }
                return .object(["imageId": .string(imageID), "role": .string(item["role"].stringValue ?? "context")])
            }
            if !references.isEmpty { payload["imageReferences"] = .array(references) }
            if let modelID { payload["modelId"] = .string(modelID) }
            if let fromSeq { payload["fromSeq"] = .integer(fromSeq) }
            let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
            let fingerprint = api.server.absoluteString + "\u{0}" + id + "\u{0}" + (String(data: try encoder.encode(JSONValue.object(payload)), encoding: .utf8) ?? "")
            let key = pendingSend?.fingerprint == fingerprint ? pendingSend!.key : UUID().uuidString
            pendingSend = (fingerprint, key)
            let result = try await api.request("POST", "/conversations/\(id)/runs", body: .object(payload), headers: ["Idempotency-Key": key])
            guard app.selectedConversationID == id else { return }
            pendingSend = nil
            draft = ""; app.pendingAttachments = []; await app.drafts.clear(server: api.server, conversationID: id)
            if app.selectedConversationID == id { await app.drafts.clear(server: api.server, conversationID: nil) }
            messages.append(ChatMessage(.object(["id": .string("pending-\(key)"), "seq": .number(Double(messages.last?.seq ?? 0) + 0.5), "role": .string("user"), "content": .string(text)]))!)
            follow(runID: result["runId"].stringValue ?? "", after: result["seq"].intValue ?? 0, id: id, api: api, generation: followGeneration)
        } catch { self.error = error.localizedDescription }
    }

    public func resync(id: String, api: APIClient) async {
        let generation = followGeneration
        do {
            let summary = try await api.request("GET", "/conversations/\(id)")
            guard generation == followGeneration else { return }
            let changed = summary["updatedAt"].doubleValue != revision
            revision = summary["updatedAt"].doubleValue ?? revision
            let remoteTail = summary["lastMessageSeq"].intValue ?? summary["messageSeq"].intValue
            let localTail = messages.filter { !$0.id.hasPrefix("pending-") }.map(\.seq).max() ?? -1
            if changed || (remoteTail != nil && remoteTail! < localTail) {
                let page = try await api.request("GET", "/conversations/\(id)/messages?limit=60")
                guard generation == followGeneration else { return }
                messages = page["items"].arrayValue?.compactMap(ChatMessage.init) ?? messages
                olderCursor = page["nextCursor"].intValue
                conversationDetails = summary
            }
            let waiting = (try await api.request("GET", "/conversations/\(id)/approvals"))["items"].arrayValue?.compactMap(ApprovalItem.init) ?? []
            guard generation == followGeneration else { return }
            approvals = waiting
            if let runID = summary["activeRun"]["id"].stringValue {
                follow(runID: runID, after: summary["activeRun"]["resumeSeq"].intValue ?? 0, id: id, api: api, generation: generation)
            } else if !changed {
                let after = messages.filter { !$0.id.hasPrefix("pending-") }.map(\.seq).max() ?? -1
                let tail = try await api.request("GET", "/conversations/\(id)/messages?after=\(after)")["items"].arrayValue?.compactMap(ChatMessage.init) ?? []
                messages = merge(messages.filter { !$0.id.hasPrefix("pending-") }, tail)
            }
        } catch { self.error = error.localizedDescription }
    }

    public func saveDraft(app: AppModel) async {
        guard let api = app.api else { return }
        await app.drafts.save(Draft(text: draft, attachments: app.pendingAttachments), server: api.server, conversationID: app.selectedConversationID)
    }

    public func command(_ path: String, body: JSONValue? = nil, id: String, api: APIClient) async {
        do {
            let result = try await api.request("POST", "/conversations/\(id)/\(path)", body: body)
            if let runID = result["runId"].stringValue { follow(runID: runID, after: result["seq"].intValue ?? 0, id: id, api: api, generation: followGeneration) }
        }
        catch { self.error = error.localizedDescription }
    }

    public func decide(_ approval: ApprovalItem, approved: Bool, api: APIClient) async {
        do { _ = try await api.request("POST", "/approvals/\(approval.id)", body: .object(["approved": .bool(approved)])); approvals.removeAll { $0.id == approval.id } }
        catch { self.error = error.localizedDescription }
    }

    private func follow(runID: String, after: Int, id: String, api: APIClient, generation: UUID) {
        guard !runID.isEmpty, generation == followGeneration else { return }; followTask?.cancel(); liveText = ""; liveThinking = ""; liveTools = []; isRunning = true
        followTask = Task { [weak self] in
            guard let self else { return }
            do {
                for try await event in await RunFollower(api: api).follow(runID: runID, after: after) { guard !Task.isCancelled, generation == self.followGeneration else { return }; self.apply(event) }
                guard !Task.isCancelled, generation == self.followGeneration else { return }
                await self.finish(id: id, api: api, generation: generation)
            } catch { if generation == self.followGeneration { self.error = error.localizedDescription; self.isRunning = false } }
        }
    }

    public func setModel(_ modelID: String, id: String, api: APIClient) async {
        do {
            let value = try await api.request("PATCH", "/conversations/\(id)", body: .object(["modelId": .string(modelID)]))
            guard id == value["id"].stringValue || value["id"] == .null else { return }
            selectedModelID = modelID; conversationDetails = value
            if let index = conversations.firstIndex(where: { $0.id == id }) { conversations[index].modelID = modelID }
        } catch { self.error = error.localizedDescription }
    }

    private func apply(_ event: ServerEvent) {
        switch event.type {
        case "message.delta":
            let update = event.data["assistantMessageEvent"]
            if update["type"].stringValue == "text_delta" {
                pendingDelta += update["delta"].stringValue ?? ""
                if flushTask == nil {
                    let generation = followGeneration
                    flushTask = Task {
                        do { try await Task.sleep(for: .milliseconds(32)) } catch { return }
                        await MainActor.run {
                            guard generation == self.followGeneration else { return }
                            self.liveText += self.pendingDelta; self.pendingDelta = ""; self.flushTask = nil
                        }
                    }
                }
            } else if update["type"].stringValue == "thinking_delta" { liveThinking += update["delta"].stringValue ?? "" }
        case "tool.execution.start": liveTools.append(event.data)
        case "tool.execution.update", "tool.execution.end":
            if let callID = event.data["toolCallId"].stringValue, let index = liveTools.firstIndex(where: { $0["toolCallId"].stringValue == callID }) { liveTools[index] = event.data }
        case "agent.extension_status": liveStatus = event.data["text"].stringValue ?? ""
        case "tool.approval.required", "tool.approval.resolved":
            if let approval = ApprovalItem(event.data["approval"]) { approvals.removeAll { $0.id == approval.id }; if approval.status == "pending" { approvals.append(approval) } }
        case "run.cancelled": liveStatus = uncensiaText("已停止")
        case "run.failed": error = event.data["message"].stringValue ?? uncensiaText("运行失败")
        default: break
        }
    }

    private func finish(id: String, api: APIClient, generation: UUID) async {
        guard generation == followGeneration, !Task.isCancelled else { return }
        flushTask?.cancel(); liveText += pendingDelta; pendingDelta = ""; flushTask = nil
        do {
            let settled = messages.filter { !$0.id.hasPrefix("pending-") }
            let after = settled.map(\.seq).max() ?? -1
            let tail = (try await api.request("GET", "/conversations/\(id)/messages?after=\(after)"))["items"].arrayValue?.compactMap(ChatMessage.init) ?? []
            guard generation == followGeneration, !Task.isCancelled else { return }
            messages = merge(settled, tail); liveText = ""
        }
        catch { self.error = error.localizedDescription }
        isRunning = false
    }

    private func merge(_ old: [ChatMessage], _ new: [ChatMessage]) -> [ChatMessage] {
        Dictionary((old + new).map { ($0.seq, $0) }, uniquingKeysWith: { _, latest in latest }).values.sorted { $0.seq < $1.seq }
    }
}
