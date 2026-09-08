import Foundation
import Observation

@MainActor @Observable
public final class ChatStore {
    public var conversations: [Conversation] = []
    public var conversationCursor: String?
    private var listLoadedAt: Date?
    private var loadingList = false
    public private(set) var createdConversationID: String?
    private var openingID: String?
    private struct TranscriptSnapshot {
        let details: JSONValue
        let messages: [ChatMessage]
        let cursor: Int?
        let revision: Double
    }
    private var snapshots: [String: TranscriptSnapshot] = [:]
    private var snapshotOrder: [String] = []
    private func rememberTranscript() {
        guard let id = openingID, !isLoading, !isRunning, !messages.isEmpty,
              !messages.contains(where: { $0.id.hasPrefix("pending-") }) else { return }
        // Keep only the recent page of four conversations, never an unbounded transcript.
        let recent = Array(messages.suffix(40))
        snapshots[id] = TranscriptSnapshot(details: conversationDetails, messages: recent,
            cursor: messages.count > recent.count ? recent.first?.seq : olderCursor, revision: revision)
        snapshotOrder.removeAll { $0 == id }; snapshotOrder.append(id)
        while snapshotOrder.count > 4 { snapshots.removeValue(forKey: snapshotOrder.removeFirst()) }
    }
    public var messages: [ChatMessage] = [] { didSet { for message in messages where message.role == "toolResult" { citations.ingest(message) } } }
    let citations = TranscriptCitationIndex()
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
    private var transientIDs: Set<String> = []
    private var followBaseSeq = -1
    private var activeFollowID: String?
    private var followTask: Task<Void, Never>?
    private var pendingDelta = ""
    private var pendingThinking = ""
    private var flushTask: Task<Void, Never>?
    private var pendingSend: (fingerprint: String, key: String)?
    private var followGeneration = UUID()
    private var revision: Double = -1

    public init() {}

    public func clearForConversationSwitch(loading: Bool = false) {
        rememberTranscript()
        openingID = nil; createdConversationID = nil
        followGeneration = UUID(); followTask?.cancel(); followTask = nil; activeFollowID = nil
        flushTask?.cancel(); flushTask = nil; pendingDelta = ""; pendingThinking = ""; transientIDs = []
        liveText = ""; liveThinking = ""; liveTools = []; liveStatus = ""
        isRunning = false; isLoading = loading; messages = []; approvals = []; citations.reset()
        conversationDetails = .null; olderCursor = nil; revision = -1; error = nil; selectedModelID = ""; draft = ""
    }

    public func loadConversations(api: APIClient, force: Bool = false) async {
        guard !loadingList, force || listLoadedAt == nil || Date().timeIntervalSince(listLoadedAt!) > 30 else { return }
        loadingList = true
        defer { loadingList = false }
        do {
            let page = try await api.request("GET", "/conversations?limit=30")
            conversations = page["items"].arrayValue?.compactMap(Conversation.init) ?? []
            conversationCursor = page["nextCursor"].stringValue
            listLoadedAt = Date()
        } catch { self.error = error.localizedDescription }
    }

    public func open(id: String, app: AppModel) async {
        guard let api = app.api else { return }
        rememberTranscript()
        let cached = snapshots[id]
        followTask?.cancel(); activeFollowID = nil; flushTask?.cancel(); flushTask = nil; pendingDelta = ""; pendingThinking = ""; citations.reset(); followGeneration = UUID(); isRunning = false; liveText = ""; liveThinking = ""; liveTools = []; liveStatus = ""; messages = []; approvals = []; conversationDetails = .null; olderCursor = nil; isLoading = true; error = nil
        openingID = id
        selectedModelID = conversations.first { $0.id == id }?.modelID ?? ""
        if let cached {
            messages = cached.messages; olderCursor = cached.cursor; conversationDetails = cached.details
            selectedModelID = cached.details["modelId"].stringValue ?? selectedModelID
            revision = cached.revision
        }
        let generation = followGeneration
        defer { if generation == followGeneration { isLoading = false } }
        do {
            let saved = await app.drafts.load(server: api.server, conversationID: id)
            guard generation == followGeneration, app.selectedConversationID == id else { return }
            draft = saved.text; app.pendingAttachments = saved.attachments
            let summary: JSONValue
            let page: JSONValue?
            if let cached {
                summary = try await api.request("GET", "/conversations/\(id)")
                if summary["updatedAt"].doubleValue == cached.revision && summary["activeRun"] == .null {
                    page = nil
                } else {
                    page = try await api.request("GET", "/conversations/\(id)/messages?limit=20")
                }
            } else {
                async let detail = api.request("GET", "/conversations/\(id)")
                async let log = api.request("GET", "/conversations/\(id)/messages?limit=20")
                (summary, page) = try await (detail, log)
            }
            guard generation == followGeneration, app.selectedConversationID == id else { return }
            conversationDetails = summary; revision = summary["updatedAt"].doubleValue ?? -1; selectedModelID = summary["modelId"].stringValue ?? ""
            if let page {
                messages = page["items"].arrayValue?.compactMap(ChatMessage.init) ?? []
                olderCursor = page["nextCursor"].intValue
            }
            isLoading = false
            if let runID = summary["activeRun"]["id"].stringValue { follow(runID: runID, after: summary["activeRun"]["resumeSeq"].intValue ?? 0, id: id, api: api, generation: generation) }
            // Pending approvals must not hold the transcript's first paint hostage.
            let waiting = try await api.request("GET", "/conversations/\(id)/approvals")
            guard generation == followGeneration else { return }
            approvals = waiting["items"].arrayValue?.compactMap(ApprovalItem.init) ?? []
        } catch { if generation == followGeneration { self.error = error.localizedDescription } }
    }

    @discardableResult public func loadOlder(id: String, api: APIClient) async -> Bool {
        guard let cursor = olderCursor else { return false }
        let generation = followGeneration
        do {
            let page = try await api.request("GET", "/conversations/\(id)/messages?limit=20&before=\(cursor)")
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
        let startedNewConversation = id == nil
        let generation = followGeneration
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let attachments = app.pendingAttachments
        guard !text.isEmpty else { return }
        do {
            if id == nil {
                let created = try await api.request("POST", "/conversations", body: .object(["modelId": modelID.map(JSONValue.string) ?? .null]))
                guard generation == followGeneration, app.selectedConversationID == nil else { return }
                id = created["id"].stringValue; createdConversationID = id; openingID = id
                selectedModelID = created["modelId"].stringValue ?? selectedModelID
                if let item = Conversation(created) { conversations.insert(item, at: 0) }
                app.selectedConversationID = id
            }
            guard let id else { return }
            let fileIDs = attachments.compactMap { $0["file"]["id"].stringValue ?? $0["id"].stringValue }
            var payload: [String: JSONValue] = ["text": .string(text), "attachments": .array(fileIDs.map(JSONValue.string))]
            let references = attachments.compactMap { item -> JSONValue? in
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
            guard generation == followGeneration, app.selectedConversationID == id else { return }
            pendingSend = nil
            if draft.trimmingCharacters(in: .whitespacesAndNewlines) == text && app.pendingAttachments == attachments {
                draft = ""; app.pendingAttachments = []; await app.drafts.clear(server: api.server, conversationID: id)
            }
            guard generation == followGeneration, app.selectedConversationID == id else { return }
            if startedNewConversation { await app.drafts.clear(server: api.server, conversationID: nil) }
            guard generation == followGeneration, app.selectedConversationID == id else { return }
            messages.append(ChatMessage(.object(["id": .string("pending-\(key)"), "seq": .number(Double(messages.last?.seq ?? 0) + 0.5), "role": .string("user"), "content": .string(text)]))!)
            follow(runID: result["runId"].stringValue ?? "", after: result["seq"].intValue ?? 0, id: id, api: api, generation: followGeneration)
        } catch { if generation == followGeneration { self.error = error.localizedDescription } }
    }

    public func resync(id: String, api: APIClient) async {
        let generation = followGeneration
        do {
            let summary = try await api.request("GET", "/conversations/\(id)")
            guard generation == followGeneration else { return }
            let changed = summary["updatedAt"].doubleValue != revision
            revision = summary["updatedAt"].doubleValue ?? revision
            selectedModelID = summary["modelId"].stringValue ?? selectedModelID
            let remoteTail = summary["lastMessageSeq"].intValue ?? summary["messageSeq"].intValue
            let localTail = messages.filter { !$0.id.hasPrefix("pending-") }.map(\.seq).max() ?? -1
            if activeFollowID == nil && (changed || (remoteTail != nil && remoteTail! < localTail)) {
                let page = try await api.request("GET", "/conversations/\(id)/messages?limit=20")
                guard generation == followGeneration else { return }
                messages = page["items"].arrayValue?.compactMap(ChatMessage.init) ?? messages
                olderCursor = page["nextCursor"].intValue
                conversationDetails = summary
            }
            let waiting = (try await api.request("GET", "/conversations/\(id)/approvals"))["items"].arrayValue?.compactMap(ApprovalItem.init) ?? []
            guard generation == followGeneration else { return }
            approvals = waiting; error = nil
            if let runID = summary["activeRun"]["id"].stringValue {
                follow(runID: runID, after: summary["activeRun"]["resumeSeq"].intValue ?? 0, id: id, api: api, generation: generation)
            } else if activeFollowID == nil {
                liveText = ""; liveThinking = ""; liveTools = []; isRunning = false
                guard !changed else { return }
                let after = messages.filter { !$0.id.hasPrefix("pending-") }.map(\.seq).max() ?? -1
                let tail = try await api.request("GET", "/conversations/\(id)/messages?after=\(after)")["items"].arrayValue?.compactMap(ChatMessage.init) ?? []
                guard generation == followGeneration else { return }
                messages = merge(messages.filter { !$0.id.hasPrefix("pending-") }, tail)
            }
        } catch { self.error = error.localizedDescription }
    }

    public func saveDraft(app: AppModel) async {
        guard let api = app.api else { return }
        await app.drafts.save(Draft(text: draft, attachments: app.pendingAttachments), server: api.server, conversationID: app.selectedConversationID)
    }

    @discardableResult public func command(_ path: String, body: JSONValue? = nil, id: String, api: APIClient) async -> Bool {
        let generation = followGeneration
        do {
            let result = try await api.request("POST", "/conversations/\(id)/\(path)", body: body)
            guard generation == followGeneration else { return false }
            if let runID = result["runId"].stringValue { follow(runID: runID, after: result["seq"].intValue ?? 0, id: id, api: api, generation: generation) }
            return true
        }
        catch { if generation == followGeneration { self.error = error.localizedDescription }; return false }
    }

    public func decide(_ approval: ApprovalItem, approved: Bool, api: APIClient) async {
        do { _ = try await api.request("POST", "/approvals/\(approval.id)", body: .object(["approved": .bool(approved)])); approvals.removeAll { $0.id == approval.id } }
        catch { self.error = error.localizedDescription }
    }

    private func follow(runID: String, after: Int, id: String, api: APIClient, generation: UUID) {
        guard !runID.isEmpty, generation == followGeneration else { return }
        if activeFollowID == runID { return }
        followTask?.cancel(); flushTask?.cancel(); flushTask = nil; pendingDelta = ""; pendingThinking = ""
        followBaseSeq = messages.filter { !$0.id.hasPrefix("pending-") && !transientIDs.contains($0.id) }.map(\.seq).max() ?? -1
        transientIDs = []
        activeFollowID = runID; liveText = ""; liveThinking = ""; liveTools = []; isRunning = true
        followTask = Task { [weak self] in
            guard let self else { return }
            do {
                for try await event in await RunFollower(api: api).follow(runID: runID, after: after) { guard !Task.isCancelled, generation == self.followGeneration else { return }; self.apply(event) }
                guard !Task.isCancelled, generation == self.followGeneration else { return }
                await self.finish(id: id, api: api, generation: generation)
            } catch { if !Task.isCancelled, generation == self.followGeneration { self.activeFollowID = nil; self.error = error.localizedDescription; self.isRunning = false } }
        }
    }

    public func setModel(_ modelID: String, id: String, api: APIClient) async {
        let generation = followGeneration
        do {
            let value = try await api.request("PATCH", "/conversations/\(id)", body: .object(["modelId": .string(modelID)]))
            guard generation == followGeneration, openingID == id,
                  id == value["id"].stringValue || value["id"] == .null else { return }
            selectedModelID = modelID; conversationDetails = value
            if let index = conversations.firstIndex(where: { $0.id == id }) { conversations[index].modelID = modelID }
        } catch { self.error = error.localizedDescription }
    }

    func apply(_ event: ServerEvent) {
        switch event.type {
        case "message.end":
            var raw = event.data["message"].objectValue ?? [:]
            if let id = event.data["messageId"].stringValue {
                raw["id"] = .string(id)
                // The canonical sequence is fetched when the run settles.
                raw["seq"] = .integer((messages.map(\.seq).max() ?? -1) + 1)
                if let message = ChatMessage(.object(raw)), !messages.contains(where: { $0.id == id }) {
                    if message.role == "user" { messages.removeAll { $0.id.hasPrefix("pending-") } }
                    transientIDs.insert(id)
                    messages.append(message)
                    if message.role == "assistant" {
                        flushTask?.cancel(); flushTask = nil; pendingDelta = ""; pendingThinking = ""; liveText = ""; liveThinking = ""
                    }
                }
            }
        case "message.start":
            if event.data["message"]["role"].stringValue == "assistant" { liveTools = [] }
        case "message.delta":
            let update = event.data["assistantMessageEvent"]
            if ["text_delta", "thinking_delta"].contains(update["type"].stringValue ?? "") {
                if update["type"].stringValue == "thinking_delta" { pendingThinking += update["delta"].stringValue ?? "" }
                else { pendingDelta += update["delta"].stringValue ?? "" }
                if flushTask == nil {
                    let generation = followGeneration
                    flushTask = Task {
                        do { try await Task.sleep(for: .milliseconds(80)) } catch { return }
                        await MainActor.run {
                            guard generation == self.followGeneration else { return }
                            self.liveText += self.pendingDelta; self.liveThinking += self.pendingThinking
                            self.pendingDelta = ""; self.pendingThinking = ""; self.flushTask = nil
                        }
                    }
                }
            }
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
        flushTask?.cancel(); liveText += pendingDelta; pendingDelta = ""; pendingThinking = ""; flushTask = nil
        do {
            let tail = (try await api.request("GET", "/conversations/\(id)/messages?after=\(followBaseSeq)"))["items"].arrayValue?.compactMap(ChatMessage.init) ?? []
            guard generation == followGeneration, !Task.isCancelled else { return }
            messages = merge(messages.filter { !$0.id.hasPrefix("pending-") && !transientIDs.contains($0.id) }, tail)
            transientIDs = []; liveText = ""
        }
        catch { if generation == followGeneration, !Task.isCancelled { self.error = error.localizedDescription } }
        guard generation == followGeneration, !Task.isCancelled else { return }
        activeFollowID = nil; isRunning = false
    }

    private func merge(_ old: [ChatMessage], _ new: [ChatMessage]) -> [ChatMessage] {
        Dictionary((old + new).map { ($0.seq, $0) }, uniquingKeysWith: { _, latest in latest }).values.sorted { $0.seq < $1.seq }
    }
}
