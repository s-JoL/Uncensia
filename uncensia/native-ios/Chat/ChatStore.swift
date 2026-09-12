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
              transientIDs.isEmpty, reconciliationAfter == nil,
              !messages.contains(where: { $0.id.hasPrefix("pending-") }) else { return }
        // Keep only the recent page of four conversations, never an unbounded transcript.
        let recent = Array(messages.suffix(40))
        snapshots[id] = TranscriptSnapshot(details: conversationDetails, messages: recent,
            cursor: messages.count > recent.count ? recent.first?.seq : olderCursor, revision: revision)
        snapshotOrder.removeAll { $0 == id }; snapshotOrder.append(id)
        while snapshotOrder.count > 4 { snapshots.removeValue(forKey: snapshotOrder.removeFirst()) }
    }
    public var messages: [ChatMessage] = [] { didSet { citations.replaceMessages(messages) } }
    let citations = TranscriptCitationIndex()
    public struct DraftScope: Equatable, Sendable {
        public let server: URL
        public let conversationID: String?
    }
    public private(set) var draftScope: DraftScope?
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
    private var reconciliationAfter: Int?
    private var activeFollowID: String?
    private var followTask: Task<Void, Never>?
    @ObservationIgnored private var loadingOlder = false
    @ObservationIgnored private var resyncRevision = UUID()
    @ObservationIgnored private var sendRevision = UUID()
    private var pendingSend: (fingerprint: String, key: String)?
    private var followGeneration = UUID()
    private var revision: Double = -1

    public init() {}

    /// Sequence-based mutations (editing and feedback) must use the persisted
    /// projection, never a pending row or an event's temporary sequence.
    public func isCanonicalMessage(id: String) -> Bool {
        !id.hasPrefix("pending-") && !transientIDs.contains(id) && messages.contains(where: { $0.id == id })
    }

    public func ownsDraft(server: URL, conversationID: String?) -> Bool {
        draftScope == DraftScope(server: server, conversationID: conversationID)
    }

    public func adoptDraft(_ saved: Draft, server: URL, conversationID: String?) {
        draft = saved.text
        draftScope = DraftScope(server: server, conversationID: conversationID)
    }

    public func clearForConversationSwitch(loading: Bool = false) {
        rememberTranscript()
        draftScope = nil
        openingID = nil; createdConversationID = nil
        followGeneration = UUID(); followTask?.cancel(); followTask = nil; activeFollowID = nil
        transientIDs = []; reconciliationAfter = nil; loadingOlder = false; sendRevision = UUID(); isSending = false
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
        draftScope = nil; draft = ""
        let cached = snapshots[id]
        followTask?.cancel(); activeFollowID = nil; transientIDs = []; loadingOlder = false; citations.reset(); followGeneration = UUID(); isRunning = false; liveText = ""; liveThinking = ""; liveTools = []; liveStatus = ""; messages = []; approvals = []; conversationDetails = .null; olderCursor = nil; isLoading = true; error = nil
        openingID = id
        reconciliationAfter = nil
        sendRevision = UUID(); isSending = false
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
            guard generation == followGeneration, app.api === api, app.selectedConversationID == id else { return }
            adoptDraft(saved, server: api.server, conversationID: id)
            app.pendingAttachments = saved.attachments
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
        guard !loadingOlder, openingID == id, let cursor = olderCursor else { return false }
        let generation = followGeneration
        loadingOlder = true
        defer { if generation == followGeneration { loadingOlder = false } }
        do {
            let page = try await api.request("GET", "/conversations/\(id)/messages?limit=20&before=\(cursor)")
            let older = page["items"].arrayValue?.compactMap(ChatMessage.init) ?? []
            guard generation == followGeneration, openingID == id else { return false }
            let existingIDs = Set(messages.map(\.id))
            messages = older.filter { !existingIDs.contains($0.id) } + messages
            olderCursor = page["nextCursor"].intValue
            return true
        } catch { if generation == followGeneration { self.error = error.localizedDescription }; return false }
    }

    @discardableResult public func send(app: AppModel, modelID: String? = nil, fromSeq: Int? = nil) async -> Bool {
        guard let api = app.api else { return false }
        guard ownsDraft(server: api.server, conversationID: app.selectedConversationID) else { return false }
        guard !isSending, !isRunning, !isLoading else { return false }
        let sendID = UUID()
        sendRevision = sendID
        isSending = true
        defer { if sendRevision == sendID { isSending = false } }
        var id = app.selectedConversationID
        let startedNewConversation = id == nil
        let generation = followGeneration
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let attachments = app.pendingAttachments
        guard !text.isEmpty else { return false }
        var optimisticID: String?
        do {
            if id == nil {
                let created = try await api.request("POST", "/conversations", body: .object(["modelId": modelID.map(JSONValue.string) ?? .null]))
                guard generation == followGeneration, app.api === api, app.selectedConversationID == nil else { return false }
                id = created["id"].stringValue; createdConversationID = id; openingID = id
                // The new screen inherits this draft before selection changes;
                // switching away during the send must save it under its new ID.
                if let id { draftScope = DraftScope(server: api.server, conversationID: id) }
                selectedModelID = created["modelId"].stringValue ?? selectedModelID
                if let item = Conversation(created) { conversations.insert(item, at: 0) }
                app.selectedConversationID = id
            }
            guard let id else { return false }
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
            if !isRunning, activeFollowID != nil {
                // A terminal run may still be aligning its transcript over a
                // slow connection. It must not own a new outgoing turn.
                followTask?.cancel(); followTask = nil; activeFollowID = nil
            }
            if fromSeq == nil {
                let pending = pendingMessage(text: text, attachments: attachments, key: key)
                optimisticID = pending.id
                if !messages.contains(where: { $0.id == pending.id }) { messages.append(pending) }
            }
            let result = try await api.request("POST", "/conversations/\(id)/runs", body: .object(payload), headers: ["Idempotency-Key": key])
            guard generation == followGeneration, app.api === api, app.selectedConversationID == id else { return false }
            guard let runID = result["runId"].stringValue, !runID.isEmpty else { throw URLError(.badServerResponse) }
            pendingSend = nil
            if draft.trimmingCharacters(in: .whitespacesAndNewlines) == text && app.pendingAttachments == attachments {
                draft = ""; app.pendingAttachments = []; await app.drafts.clear(server: api.server, conversationID: id)
            }
            guard generation == followGeneration, app.api === api, app.selectedConversationID == id else { return false }
            if startedNewConversation { await app.drafts.clear(server: api.server, conversationID: nil) }
            guard generation == followGeneration, app.api === api, app.selectedConversationID == id else { return false }
            // Rewind regenerates all server message IDs. Remove the abandoned
            // answer now and reconcile the whole visible window when it settles.
            let alreadyObservedRun = activeFollowID == runID || conversationDetails["activeRun"]["id"].stringValue == runID
            let reconcileAfter = alreadyObservedRun ? nil : fromSeq.map { _ in (messages.first?.seq ?? 0) - 1 }
            if let fromSeq, !alreadyObservedRun {
                messages.removeAll { $0.seq >= fromSeq }
                messages.append(pendingMessage(text: text, attachments: attachments, key: key))
            }
            // Ordinary sends already inserted their pending row before POST.
            // A foreground refresh may have replaced it with the canonical user
            // while the acknowledgement was in flight; never insert it twice.
            follow(runID: runID, after: result["seq"].intValue ?? 0, id: id, api: api, generation: followGeneration, reconcileAfter: reconcileAfter)
            return true
        } catch {
            if generation == followGeneration, app.api === api {
                if let optimisticID { messages.removeAll { $0.id == optimisticID } }
                self.error = error.localizedDescription
            }
            return false
        }
    }

    private func pendingMessage(text: String, attachments: [JSONValue], key: String) -> ChatMessage {
        var content: [JSONValue] = [.object(["type": .string("text"), "text": .string(text)])]
        for item in attachments {
            let file = item["file"].objectValue == nil ? item : item["file"]
            guard let id = file["id"].stringValue else { continue }
            if (file["mime"].stringValue ?? "").hasPrefix("image/") {
                content.append(.object(["type": .string("image_ref"), "image_id": .string(id), "reference_role": item["role"]]))
            } else {
                content.append(.object(["type": .string("file_ref"), "file_id": .string(id), "name": file["name"], "mime_type": file["mime"]]))
            }
        }
        return ChatMessage(.object(["id": .string("pending-\(key)"), "seq": .integer((messages.last?.seq ?? -1) + 1), "role": .string("user"), "content": .array(content)]))!
    }

    public func resync(id: String, api: APIClient) async {
        guard openingID == id else { return }
        let generation = followGeneration
        let requestID = UUID()
        resyncRevision = requestID
        let followedAtStart = activeFollowID
        var interruptedFollower = false
        func ownsRequest() -> Bool {
            generation == followGeneration && requestID == resyncRevision && openingID == id
        }
        do {
            let summary = try await api.request("GET", "/conversations/\(id)")
            guard ownsRequest(), activeFollowID == followedAtStart else { return }
            let remoteRun = summary["activeRun"]["id"].stringValue
            let changed = summary["updatedAt"].doubleValue != revision
            let provisional = !transientIDs.isEmpty || messages.contains(where: { $0.id.hasPrefix("pending-") }) || !liveText.isEmpty || !liveThinking.isEmpty
            if remoteRun != activeFollowID || (activeFollowID == nil && (changed || provisional)) {
                // A suspended stream may have finished, or another client may
                // already be running its next turn. Settle the old rows first.
                if followedAtStart != nil { followTask?.cancel(); interruptedFollower = true }
                let old = messages.filter { !$0.id.hasPrefix("pending-") && !transientIDs.contains($0.id) }
                var sameProjection = false
                if let anchor = old.last {
                    // Include one known ID to distinguish an append from a
                    // branch projection. A latest page alone has no overlap if
                    // a long background task has added more than twenty rows.
                    let tail = try await api.request("GET", "/conversations/\(id)/messages?after=\(anchor.seq - 1)")["items"].arrayValue?.compactMap(ChatMessage.init) ?? []
                    guard ownsRequest(), activeFollowID == followedAtStart else { return }
                    if tail.contains(where: { $0.id == anchor.id && $0.seq == anchor.seq }) {
                        messages = merge(old, tail)
                        sameProjection = true
                    }
                }
                if !sameProjection {
                    let page = try await api.request("GET", "/conversations/\(id)/messages?limit=20")
                    guard ownsRequest(), activeFollowID == followedAtStart else { return }
                    messages = page["items"].arrayValue?.compactMap(ChatMessage.init) ?? []
                    olderCursor = page["nextCursor"].intValue
                }
                transientIDs = []
                reconciliationAfter = nil
                activeFollowID = nil; isRunning = false
                liveText = ""; liveThinking = ""; liveTools = []; liveStatus = ""
            }
            // A failed transcript fetch must not mark an unseen revision current.
            conversationDetails = summary
            revision = summary["updatedAt"].doubleValue ?? revision
            selectedModelID = summary["modelId"].stringValue ?? selectedModelID
            error = nil
            if let remoteRun {
                follow(runID: remoteRun, after: summary["activeRun"]["resumeSeq"].intValue ?? 0, id: id, api: api, generation: generation)
            }
            let waiting = try await api.request("GET", "/conversations/\(id)/approvals")
            guard ownsRequest() else { return }
            approvals = waiting["items"].arrayValue?.compactMap(ApprovalItem.init) ?? []
        } catch {
            if ownsRequest() {
                if interruptedFollower, activeFollowID == followedAtStart { activeFollowID = nil; isRunning = false }
                self.error = error.localizedDescription
            }
        }
    }

    public func saveDraft(app: AppModel) async {
        guard let api = app.api else { return }
        let id = app.selectedConversationID
        guard ownsDraft(server: api.server, conversationID: id) else { return }
        await app.drafts.save(Draft(text: draft, attachments: app.pendingAttachments), server: api.server, conversationID: id)
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
        let generation = followGeneration
        do {
            _ = try await api.request("POST", "/approvals/\(approval.id)", body: .object(["approved": .bool(approved)]))
            guard generation == followGeneration else { return }
            approvals.removeAll { $0.id == approval.id }
        } catch { if generation == followGeneration { self.error = error.localizedDescription } }
    }

    private func follow(runID: String, after: Int, id: String, api: APIClient, generation: UUID, reconcileAfter: Int? = nil) {
        guard !runID.isEmpty, generation == followGeneration else { return }
        if activeFollowID == runID { return }
        followTask?.cancel()
        let base = reconcileAfter ?? (messages.filter { !$0.id.hasPrefix("pending-") && !transientIDs.contains($0.id) }.map(\.seq).max() ?? -1)
        reconciliationAfter = min(reconciliationAfter ?? base, base)
        followBaseSeq = reconciliationAfter ?? base
        // Retain earlier unsettled rows until this run's canonical tail has
        // reconciled both runs. Clearing their IDs here loses the old boundary.
        activeFollowID = runID; liveText = ""; liveThinking = ""; liveTools = []; liveStatus = ""; error = nil; isRunning = true
        followTask = Task { [weak self] in
            guard let self else { return }
            do {
                for try await events in await RunFollower(api: api).followBatches(runID: runID, after: after) {
                    guard !Task.isCancelled, generation == self.followGeneration, self.activeFollowID == runID else { return }
                    self.apply(events)
                }
                guard !Task.isCancelled, generation == self.followGeneration else { return }
                await self.finish(id: id, api: api, generation: generation, runID: runID)
            } catch {
                if !Task.isCancelled, generation == self.followGeneration, self.activeFollowID == runID {
                    self.settleVisibleRun()
                    self.activeFollowID = nil; self.error = error.localizedDescription
                }
            }
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
        } catch { if generation == followGeneration { self.error = error.localizedDescription } }
    }

    private func apply(_ events: [ServerEvent]) {
        var text = "", thinking = ""
        func flush() {
            if !text.isEmpty { liveText += text; text = "" }
            if !thinking.isEmpty { liveThinking += thinking; thinking = "" }
        }
        for event in events {
            let update = event.data["assistantMessageEvent"]
            if event.type == "message.delta", update["type"].stringValue == "text_delta" {
                text += update["delta"].stringValue ?? ""
            } else if event.type == "message.delta", update["type"].stringValue == "thinking_delta" {
                thinking += update["delta"].stringValue ?? ""
            } else {
                flush()
                apply(event)
            }
        }
        flush()
    }

    func apply(_ event: ServerEvent) {
        switch event.type {
        case "message.end":
            var raw = event.data["message"].objectValue ?? [:]
            if let id = event.data["messageId"].stringValue {
                raw["id"] = .string(id)
                let existing = messages.firstIndex(where: { $0.id == id })
                // Preserve a canonical sequence already loaded while this event
                // was in flight. Only genuinely new messages need a temporary one.
                raw["seq"] = .integer(existing.map { messages[$0].seq } ?? ((messages.map(\.seq).max() ?? -1) + 1))
                if let message = ChatMessage(.object(raw)) {
                    if message.role == "user" { messages.removeAll { $0.id.hasPrefix("pending-") } }
                    // The paged transcript wraps the full AgentMessage and has
                    // richer metadata than a streamed row. Keep it authoritative.
                    if !messages.contains(where: { $0.id == id }) {
                        transientIDs.insert(id)
                        messages.append(message)
                    }
                    if message.role == "assistant" {
                        liveText = ""; liveThinking = ""; liveTools = []; liveStatus = ""
                    }
                }
            }
        case "message.start":
            if event.data["message"]["role"].stringValue == "assistant" { liveTools = [] }
        case "message.delta":
            let update = event.data["assistantMessageEvent"]
            if update["type"].stringValue == "thinking_delta" { liveThinking += update["delta"].stringValue ?? "" }
            else if update["type"].stringValue == "text_delta" { liveText += update["delta"].stringValue ?? "" }
        case "tool.execution.start":
            if let callID = event.data["toolCallId"].stringValue {
                liveTools.removeAll { $0["toolCallId"].stringValue == callID }
            }
            liveTools.append(event.data)
        case "tool.execution.update", "tool.execution.end":
            if let callID = event.data["toolCallId"].stringValue, let index = liveTools.firstIndex(where: { $0["toolCallId"].stringValue == callID }) { liveTools[index] = event.data }
        case "agent.extension_status": liveStatus = event.data["text"].stringValue ?? ""
        case "tool.approval.required", "tool.approval.resolved":
            if let approval = ApprovalItem(event.data["approval"]) { approvals.removeAll { $0.id == approval.id }; if approval.status == "pending" { approvals.append(approval) } }
        case "run.completed": settleVisibleRun()
        case "run.cancelled": settleVisibleRun(); liveStatus = uncensiaText("已停止")
        case "run.failed": settleVisibleRun(); error = event.data["message"].stringValue ?? uncensiaText("运行失败")
        default: break
        }
    }

    private func settleVisibleRun() {
        // The event batch flushes preceding deltas before this terminal event.
        // Preserve a partial answer even when cancellation skipped message.end.
        if !liveText.isEmpty || !liveThinking.isEmpty {
            let id = "unsettled-\(activeFollowID ?? UUID().uuidString)"
            var content: [JSONValue] = []
            if !liveThinking.isEmpty { content.append(.object(["type": .string("thinking"), "thinking": .string(liveThinking)])) }
            if !liveText.isEmpty { content.append(.object(["type": .string("text"), "text": .string(liveText)])) }
            if !messages.contains(where: { $0.id == id }), let message = ChatMessage(.object([
                "id": .string(id), "seq": .integer((messages.map(\.seq).max() ?? -1) + 1),
                "role": .string("assistant"), "content": .array(content)
            ])) {
                transientIDs.insert(id); messages.append(message)
            }
        }
        liveText = ""; liveThinking = ""; liveTools = []; liveStatus = ""; isRunning = false
    }

    private func finish(id: String, api: APIClient, generation: UUID, runID: String) async {
        guard generation == followGeneration, activeFollowID == runID, !Task.isCancelled else { return }
        // Poll recovery can finish without replaying a terminal event.
        settleVisibleRun()
        do {
            let tail = (try await api.request("GET", "/conversations/\(id)/messages?after=\(followBaseSeq)"))["items"].arrayValue?.compactMap(ChatMessage.init) ?? []
            guard generation == followGeneration, activeFollowID == runID, !Task.isCancelled else { return }
            messages = merge(messages.filter { !$0.id.hasPrefix("pending-") && !transientIDs.contains($0.id) }, tail)
            transientIDs = []; reconciliationAfter = nil; liveText = ""; liveThinking = ""; liveTools = []; liveStatus = ""
        }
        catch { if generation == followGeneration, activeFollowID == runID, !Task.isCancelled { self.error = error.localizedDescription } }
        guard generation == followGeneration, activeFollowID == runID, !Task.isCancelled else { return }
        activeFollowID = nil; isRunning = false
    }

    private func merge(_ old: [ChatMessage], _ new: [ChatMessage]) -> [ChatMessage] {
        Dictionary((old + new).map { ($0.seq, $0) }, uniquingKeysWith: { _, latest in latest }).values.sorted { $0.seq < $1.seq }
    }
}
