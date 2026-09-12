import SwiftUI
import UniformTypeIdentifiers
import PhotosUI

public struct ChatScreen: View {
    @Environment(AppModel.self) private var app
    @State private var store = ChatStore()
    @State private var showList = false
    @State private var showContext = false
    @State private var showTasks = false
    @State private var showBranches = false
    @State private var showEvidence = false
    @State private var showErrorDetails = false
    @State private var exporting = false
    @State private var exportDocument = ExportDocument(data: Data())
    @State private var models: [JSONValue] = []
    @State private var editingSeq: Int?
    @State private var didLoad = false
    @State private var draftLoadRevision = UUID()
    @Environment(\.scenePhase) private var scenePhase

    public init() {}
    public var body: some View {
        @Bindable var app = app
        NavigationStack {
            VStack(spacing: 0) {
                if let error = store.error {
                    HStack(alignment: .top, spacing: 8) {
                        Button { showErrorDetails = true } label: {
                            Label(error, image: "lucide-triangle-alert")
                                .font(.footnote).lineLimit(3).multilineTextAlignment(.leading)
                        }.buttonStyle(.plain).foregroundStyle(.red)
                        Spacer(minLength: 0)
                        Button { store.error = nil } label: { Image(systemName: "xmark").frame(width: 32, height: 32) }
                            .accessibilityLabel(uncensiaText("关闭"))
                    }.padding(.horizontal, 16).padding(.vertical, 8)
                }
                TranscriptView(store: store, conversationID: app.selectedConversationID, api: app.api, edit: edit)
                    .id(app.selectedConversationID ?? "new")
                    .environment(store.citations)
                ComposerView(store: store, app: app, editingSeq: $editingSeq)
            }
            .navigationTitle(currentTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button {
                    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                    withAnimation(.easeOut(duration: 0.2)) { showList = true }
                } label: { Image("lucide-menu") }.accessibilityIdentifier("conversation.history") }
                ToolbarItem(placement: .principal) {
                    Menu {
                        Picker(uncensiaText("模型"), selection: Binding(get: { store.selectedModelID }, set: { setModel($0) })) {
                            ForEach(models, id: \.self) { model in Text(model["name"].stringValue ?? model["id"].stringValue ?? uncensiaText("模型")).tag(model["id"].stringValue ?? "") }
                        }
                    } label: {
                        VStack(spacing: 1) {
                            Text("Uncensia").font(.headline)
                            Text(selectedModelName).font(.caption2).lineLimit(1).truncationMode(.tail)
                        }.frame(maxWidth: 170)
                    }.disabled(store.isRunning || store.isLoading || store.isSending).accessibilityLabel(uncensiaText("模型"))
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { app.selectedConversationID = nil } label: { Image("lucide-square-pen") }
                        .accessibilityLabel(uncensiaText("新对话")).accessibilityIdentifier("conversation.newQuick")
                    Menu {
                        Button(uncensiaText("对话设定"), image: "lucide-sliders-horizontal") { showContext = true }
                        Button(uncensiaText("分支"), image: "lucide-git-branch") { showBranches = true }
                        Button(uncensiaText("后台任务"), image: "lucide-clock") { showTasks = true }
                        Button(uncensiaText("交付、反馈与执行记录"), image: "lucide-list-todo") { showEvidence = true }.disabled(app.selectedConversationID == nil)
                        Button(uncensiaText("整理上下文"), image: "lucide-minimize-2") { runCommand("compact") }
                        Button(uncensiaText("继续"), image: "lucide-play") { runCommand("continue") }
                        Button(uncensiaText("导出 JSONL"), image: "lucide-share") { exportConversation() }.disabled(app.selectedConversationID == nil)
                    } label: { Image("lucide-ellipsis") }.accessibilityIdentifier("conversation.actions")
                }
            }

            .sheet(isPresented: $showContext) { ConversationContextSheet(details: store.conversationDetails, id: app.selectedConversationID, api: app.api, store: store) }
            .sheet(isPresented: $showBranches) { BranchSheet(id: app.selectedConversationID, api: app.api, app: app, store: store) }
            .sheet(isPresented: $showTasks) { BackgroundTasksSheet(id: app.selectedConversationID, api: app.api, app: app) }
            .sheet(isPresented: $showEvidence) {
                if let id = app.selectedConversationID { ConversationEvidenceSheet(id: id, api: app.api) }
            }
            .alert(uncensiaText("操作未完成"), isPresented: $showErrorDetails) {
                Button(uncensiaText("重试")) { retryAfterError() }
                Button(uncensiaText("关闭"), role: .cancel) {}
            } message: { Text(store.error ?? "") }
            .fileExporter(isPresented: $exporting, document: exportDocument, contentType: .json, defaultFilename: "uncensia-conversation.jsonl") { result in if case .failure(let error) = result { store.error = error.localizedDescription } }
            .task {
                guard !didLoad else { return }
                didLoad = true
                let draftRequest = draftLoadRevision
                if let api = app.api {
                    let initialID = app.selectedConversationID
                    async let history: Void = store.loadConversations(api: api)
                    async let catalogue: Void = loadModels(api: api)
                    if let id = initialID { await store.open(id: id, app: app) }
                    else {
                        let saved = await app.drafts.load(server: api.server, conversationID: nil)
                        guard draftRequest == draftLoadRevision, app.api === api, app.selectedConversationID == nil else { return }
                        store.adoptDraft(saved, server: api.server, conversationID: nil)
                        app.pendingAttachments = saved.attachments
                    }
                    guard app.api?.server == api.server, app.selectedConversationID == initialID else { return }
                    consumeHandoff()
                    _ = await (history, catalogue)
                }
            }
            .onChange(of: app.selectedConversationID) { oldID, id in
                guard oldID != id else { return }
                // Only our own newly created ID is adopted without reloading.
                if oldID == nil && id == store.createdConversationID {
                    return
                }
                let draftRequest = UUID()
                draftLoadRevision = draftRequest
                let api = app.api
                let server = api?.server
                let oldDraft = server.flatMap { store.ownsDraft(server: $0, conversationID: oldID)
                    ? Draft(text: store.draft, attachments: app.pendingAttachments) : nil }
                editingSeq = nil
                store.clearForConversationSwitch(loading: id != nil)
                app.pendingAttachments = []
                if id == nil { store.selectedModelID = app.bootstrap["defaultModelId"].stringValue ?? "" }
                Task {
                    if let server, let oldDraft { await app.drafts.save(oldDraft, server: server, conversationID: oldID) }
                    guard draftRequest == draftLoadRevision, app.api === api, app.selectedConversationID == id else { return }
                    if let id { await store.open(id: id, app: app) }
                    else if let server {
                        let saved = await app.drafts.load(server: server, conversationID: nil)
                        guard draftRequest == draftLoadRevision, app.api === api, app.selectedConversationID == nil else { return }
                        store.adoptDraft(saved, server: server, conversationID: nil)
                        app.pendingAttachments = saved.attachments
                    }
                    guard app.selectedConversationID == id else { return }
                    consumeHandoff()
                }
            }
            .onChange(of: app.chatHandoff?.id) { _, _ in consumeHandoff() }
            .onChange(of: store.draftScope) { _, _ in consumeHandoff() }
            .onChange(of: scenePhase) { _, phase in if phase == .active, !store.isLoading, let id = app.selectedConversationID, let api = app.api { Task { await store.resync(id: id, api: api) } } }
        }
        .toolbar(showList ? .hidden : .visible, for: .tabBar)
        .overlay {
            if showList {
                GeometryReader { geometry in
                    ZStack(alignment: .leading) {
                        Color.black.opacity(0.22).ignoresSafeArea().onTapGesture { closeHistory() }
                        ConversationList(store: store, app: app, onClose: closeHistory)
                            .frame(width: min(340, geometry.size.width * 0.88))
                            .background(.background).shadow(radius: 12, x: 4)
                            .transition(.move(edge: .leading))
                    }
                }.transition(.opacity)
            }
        }
    }
    private func consumeHandoff() {
        guard let server = app.api?.server, store.ownsDraft(server: server, conversationID: nil), app.selectedConversationID == nil,
              let handoff = app.chatHandoff else { return }
        app.consumeChatHandoff(handoff.id)
        Task { await store.saveDraft(app: app) }
    }
    private func closeHistory() { withAnimation(.easeOut(duration: 0.2)) { showList = false } }
    private func retryAfterError() {
        guard let api = app.api else { return }
        store.error = nil
        Task {
            async let history: Void = store.loadConversations(api: api, force: true)
            async let catalogue: Void = loadModels(api: api)
            if let id = app.selectedConversationID { await store.resync(id: id, api: api) }
            _ = await (history, catalogue)
        }
    }
    private func loadModels(api: APIClient) async {
                    do {
                        let items: [JSONValue]
                        if let bootstrapped = app.bootstrap["models"].arrayValue { items = bootstrapped }
                        else { items = try await api.request("GET", "/models")["items"].arrayValue ?? [] }
                        guard app.api === api else { return }
                        models = items.filter { ($0["kind"].stringValue ?? "chat") == "chat" && $0["enabled"].boolValue != false && $0["configured"].boolValue != false }
                        if app.selectedConversationID == nil && store.selectedModelID.isEmpty {
                            store.selectedModelID = app.bootstrap["defaultModelId"].stringValue ?? ""
                        }
                    } catch {
                        guard app.api === api else { return }
                        store.error = uncensiaText("无法载入模型：%@", String(describing: error.localizedDescription))
                    }
    }
    private var selectedModelName: String {
        let name = models.first { $0["id"].stringValue == store.selectedModelID }?["name"].stringValue ?? uncensiaText("模型")
        return name.components(separatedBy: " · ").first ?? name
    }
    private var currentTitle: String { store.conversations.first { $0.id == app.selectedConversationID }?.title ?? "Uncensia" }
    private func runCommand(_ command: String) { guard let id = app.selectedConversationID, let api = app.api else { return }; Task { await store.command(command, id: id, api: api) } }
    private func setModel(_ modelID: String) { guard !modelID.isEmpty else { return }; guard let id = app.selectedConversationID, let api = app.api else { store.selectedModelID = modelID; return }; Task { await store.setModel(modelID, id: id, api: api) } }
    private func edit(_ message: ChatMessage) { store.draft = message.text; editingSeq = message.seq }
    private func exportConversation() { guard let id = app.selectedConversationID, let api = app.api else { return }; Task { do { exportDocument = ExportDocument(data: try await api.download("/conversations/\(id)/export")); exporting = true } catch { store.error = error.localizedDescription } } }
}

private struct ExportDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json, .plainText] }
    var data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws { data = configuration.file.regularFileContents ?? Data() }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}

private struct TranscriptView: View {
    let store: ChatStore; let conversationID: String?; let api: APIClient?; let edit: (ChatMessage) -> Void
    @State private var position = ScrollPosition(edge: .bottom)
    @State private var closeToBottom = true
    @State private var viewport = ViewportTracker()
    @State private var userScrolling = false
    @State private var scrollFollow = TranscriptScrollScheduler()
    @State private var loadingOlder = false
    @State private var feedbackMessage: ChatMessage?
    var body: some View {
        ScrollViewReader { reader in
        ScrollView {
            VStack(spacing: 20) {
                if store.olderCursor != nil { Button(uncensiaText("载入更早消息")) {
                    guard let conversationID, let api else { return }
                    guard !loadingOlder else { return }
                    let anchor = viewport.readingAnchor
                    let frameRevision = anchor.flatMap { viewport.frameRevisions[$0.id] } ?? 0
                    let interaction = viewport.interaction
                    loadingOlder = true
                    closeToBottom = false
                    scrollFollow.cancel()
                    Task {
                        let loaded = await store.loadOlder(id: conversationID, api: api)
                        loadingOlder = false
                        guard loaded, let anchor, viewport.interaction == interaction else { return }
                        viewport.restoration = .init(id: anchor.id, y: anchor.y, interaction: interaction, previousFrameRevision: frameRevision)
                        restoreReadingPosition()
                    }
                }.disabled(loadingOlder) }
                ForEach(store.messages) { message in transcriptMessage(message) }
                ForEach(store.approvals) { approval in ApprovalCard(item: approval, store: store, api: api) }
                if store.isRunning || !store.liveText.isEmpty { LiveTranscriptRow(store: store, api: api).id("live") }
                Color.clear.frame(height: 1).id("bottom")
            }.scrollTargetLayout().padding(.horizontal, 20).padding(.vertical, 20)
        }
        .coordinateSpace(name: "transcriptViewport")
        .accessibilityIdentifier("chat.transcript")
        .scrollDismissesKeyboard(.interactively)
        .scrollPosition($position)
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .onScrollGeometryChange(for: TranscriptGeometry.self) { value in
            TranscriptGeometry(offset: value.contentOffset.y, height: value.contentSize.height, viewport: value.containerSize.height, visibleBottom: value.visibleRect.maxY, topInset: value.contentInsets.top, bottomInset: value.contentInsets.bottom)
        } action: { old, new in
            viewport.offset = new.offset
            viewport.topInset = new.topInset
            viewport.height = new.viewport
            // Following is a user intent, not the run's lifetime. Keyboard resizing
            // and the live-to-persisted handoff must keep the last line reachable.
            if closeToBottom, !userScrolling, !loadingOlder,
               abs(new.height - old.height) > 1 || abs(new.viewport - old.viewport) > 1 {
                followLatest()
            }
            let nowClose = new.distanceFromBottom < 96
            viewport.nearBottom = nowClose
        }
        .simultaneousGesture(
            DragGesture(minimumDistance: 8)
                .onChanged { gesture in
                    guard abs(gesture.translation.height) > abs(gesture.translation.width) else { return }
                    closeToBottom = false
                    scrollFollow.cancel()
                    viewport.restoration = nil
                    viewport.lastMovementDown = gesture.translation.height < 0
                }
        )
        .onScrollPhaseChange { _, phase in
            let wasUserScrolling = userScrolling
            userScrolling = phase == .interacting || phase == .decelerating || phase == .tracking
            if userScrolling { scrollFollow.cancel() }
            if phase == .tracking || phase == .interacting {
                viewport.interaction += 1
                viewport.restoration = nil
                closeToBottom = false
                viewport.lastMovementDown = false
            }
            if phase == .idle && wasUserScrolling { closeToBottom = viewport.nearBottom && viewport.lastMovementDown }
        }
        .onChange(of: store.messages.last?.id) { _, _ in followLatest() }
        .onChange(of: store.isSending) { _, sending in
            if sending {
                viewport.interaction += 1; scrollFollow.cancel()
                closeToBottom = true; viewport.restoration = nil; followLatest()
            }
        }
        .onAppear { viewport.scrollToBottom = { reader.scrollTo("bottom", anchor: .bottom) }; followLatest() }
        .onDisappear { scrollFollow.cancel(); viewport.restoration = nil; viewport.scrollToBottom = nil }
        .sheet(item: $feedbackMessage) { message in
            if let conversationID { MessageFeedbackSheet(conversationID: conversationID, messageSeq: message.seq, api: api) }
        }
        .overlay { if store.isLoading && store.messages.isEmpty { ProgressView() } else if store.messages.isEmpty && !store.isRunning { ContentUnavailableView(uncensiaText("开始对话"), image: "lucide-sparkles", description: Text(uncensiaText("可以聊天、处理资料，也可以直接创作图片和视频。"))) } }
        .overlay(alignment: .bottom) {
            if !closeToBottom {
                Button {
                    viewport.interaction += 1; scrollFollow.cancel()
                    viewport.restoration = nil
                    closeToBottom = true
                    followLatest()
                } label: {
                    Image("lucide-arrow-down").frame(width: 44, height: 44)
                }
                .accessibilityLabel(uncensiaText("返回最新消息"))
                .buttonStyle(.plain).background(.regularMaterial, in: Circle())
                .overlay(Circle().stroke(.quaternary, lineWidth: 1))
                .shadow(color: .black.opacity(0.08), radius: 4, y: 2).padding(12)
            }
        }
        }
    }
    private func transcriptMessage(_ message: ChatMessage) -> some View {
        MessageRow(message: message, api: api)
            .environment(store.citations.scope(for: message.id))
            .id(message.id).accessibilityElement(children: .contain)
            .accessibilityIdentifier("chat.message.\(message.id)").contextMenu {
                if !message.text.isEmpty {
                    Button(uncensiaText("复制"), systemImage: "doc.on.doc") {
                        UIPasteboard.general.string = message.text
                    }
                }
                if message.role == "user", store.isCanonicalMessage(id: message.id) {
                    Button(uncensiaText("编辑并重试"), image: "lucide-pencil") { edit(message) }
                }
                if message.role == "assistant", conversationID != nil, store.isCanonicalMessage(id: message.id) {
                    Button(uncensiaText("保存反馈"), image: "lucide-pencil") { feedbackMessage = message }
                        .accessibilityIdentifier("message.feedback.open.\(message.id)")
                }
            }
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .named("transcriptViewport")) } action: { frame in
                viewport.frames[message.id] = frame
                viewport.frameRevisions[message.id, default: 0] += 1
                if viewport.restoration?.id == message.id { restoreReadingPosition() }
                if message.id == store.messages.last?.id { followLatest() }
            }
            .onDisappear { viewport.frames.removeValue(forKey: message.id) }
    }
    private func followLatest() {
        guard closeToBottom, !userScrolling else { return }
        scrollFollow.schedule {
            guard closeToBottom, !userScrolling else { return }
            viewport.scrollToBottom?()
        }
    }
    private func restoreReadingPosition() {
        guard viewport.restoration != nil else { return }
        scrollFollow.schedule {
            guard var anchor = viewport.restoration,
                  anchor.interaction == viewport.interaction, !userScrolling else { return }
            guard let frame = viewport.frames[anchor.id] else {
                // Materialize a lazy row first; its subsequent geometry restores
                // the exact offset instead of leaving it pinned to the top.
                position.scrollTo(id: anchor.id, anchor: .top)
                return
            }
            guard viewport.frameRevisions[anchor.id, default: 0] > anchor.previousFrameRevision else { return }
            let delta = frame.minY - anchor.y
            if abs(delta) <= 1 || anchor.adjustments >= 3 {
                viewport.restoration = nil
                return
            }
            anchor.adjustments += 1
            viewport.restoration = anchor
            // ScrollPosition uses distance from the inset-adjusted content origin;
            // ScrollGeometry.contentOffset includes the negative top safe area.
            position.scrollTo(y: max(0, viewport.offset + viewport.topInset + delta))
        }
    }
}

@MainActor private final class TranscriptScrollScheduler {
    private var task: Task<Void, Never>?
    func schedule(_ action: @escaping @MainActor () -> Void) {
        guard task == nil else { return }
        task = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(20)) } catch { return }
            self?.task = nil; action()
        }
    }
    func cancel() { task?.cancel(); task = nil }
}

private struct TranscriptGeometry: Equatable {
    var offset: CGFloat; var height: CGFloat; var viewport: CGFloat; var visibleBottom: CGFloat; var topInset: CGFloat; var bottomInset: CGFloat
    var distanceFromBottom: CGFloat { max(0, height + bottomInset - visibleBottom) }
}

@MainActor private final class ViewportTracker {
    struct Restoration {
        let id: String
        let y: CGFloat
        let interaction: Int
        let previousFrameRevision: Int
        var adjustments = 0
    }
    var interaction = 0
    var nearBottom = true
    var lastMovementDown = false
    var offset: CGFloat = 0
    var topInset: CGFloat = 0
    var scrollToBottom: (() -> Void)?
    var height: CGFloat = 0
    var frames: [String: CGRect] = [:]
    var frameRevisions: [String: Int] = [:]
    var restoration: Restoration?
    var readingAnchor: (id: String, y: CGFloat)? {
        frames.filter { $0.value.maxY > 0 && $0.value.minY < height }
            .min { $0.value.minY < $1.value.minY }
            .map { (id: $0.key, y: $0.value.minY) }
    }
}


private struct LiveTranscriptRow: View {
    @Bindable var store: ChatStore
    let api: APIClient?
    var body: some View { StreamingRow(text: store.liveText, status: store.liveStatus, api: api, thinking: store.liveThinking, tools: store.liveTools) }
}

private struct ApprovalCard: View {
    let item: ApprovalItem; let store: ChatStore; let api: APIClient?
    var body: some View { VStack(alignment: .leading, spacing: 10) { Label(uncensiaText("需要确认"), image: "lucide-shield-alert").font(.headline); Text(item.summary); Text(item.action).font(.caption).foregroundStyle(.secondary); HStack { Button(uncensiaText("拒绝"), role: .destructive) { decide(false) }; Button(uncensiaText("允许")) { decide(true) }.buttonStyle(.borderedProminent) } }.padding().background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 16)) }
    private func decide(_ value: Bool) { guard let api else { return }; Task { await store.decide(item, approved: value, api: api) } }
}

private struct ComposerView: View {
    @Bindable var store: ChatStore
    let app: AppModel
    @Binding var editingSeq: Int?
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @State private var importing = false
    @State private var choosingPhotos = false
    @State private var photos: [PhotosPickerItem] = []
    @State private var mode = "follow-up"
    @State private var uploads = ComposerUploadTracker()
    @State private var uploadError: String?
    @State private var pendingCommand: UUID?
    @State private var pendingStop: UUID?
    @State private var draftSaveTask: Task<Void, Never>?
    @FocusState private var inputFocused: Bool

    private var uploadCount: Int {
        guard let server = app.api?.server else { return 0 }
        return uploads.count(server: server, conversationID: app.selectedConversationID)
    }
    private var hasText: Bool { !store.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var ownsDraft: Bool {
        app.api.map { store.ownsDraft(server: $0.server, conversationID: app.selectedConversationID) } ?? false
    }
    private var canSend: Bool {
        ownsDraft && hasText && !store.isSending && !store.isLoading && uploadCount == 0 && pendingCommand == nil
            && !(store.isRunning && !app.pendingAttachments.isEmpty)
    }

    var body: some View {
        VStack(spacing: 8) {
            if !app.pendingAttachments.isEmpty { attachments }
            if uploadCount > 0 {
                HStack(spacing: 8) { ProgressView(); Text(uncensiaText("正在上传 %@ 个附件…", String(uploadCount))); Spacer() }
                    .font(.caption).accessibilityIdentifier("chat.uploading")
            }
            if let uploadError {
                HStack(alignment: .top) {
                    Text(uploadError).font(.caption).foregroundStyle(.red)
                    Spacer()
                    Button { self.uploadError = nil } label: { Image(systemName: "xmark") }
                        .accessibilityLabel(uncensiaText("关闭"))
                }.accessibilityIdentifier("chat.uploadError")
            }
            if store.isRunning && !app.pendingAttachments.isEmpty {
                Text(uncensiaText("附件已保留，生成结束后可随消息发送。"))
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let editingSeq {
                HStack {
                    Label(uncensiaText("正在编辑第 %@ 条消息", String(editingSeq)), image: "lucide-pencil")
                    Spacer()
                    Button(uncensiaText("取消")) { self.editingSeq = nil }
                }.font(.caption).foregroundStyle(.secondary)
            }
            HStack(alignment: .bottom, spacing: 6) {
                Menu {
                    Button(uncensiaText("照片与视频"), systemImage: "photo.on.rectangle") { choosingPhotos = true }
                    Button(uncensiaText("选取文件"), systemImage: "folder") { importing = true }
                } label: { Image("lucide-plus").frame(width: 44, height: 44) }
                    .accessibilityLabel(uncensiaText("添加附件"))
                    .buttonStyle(.plain).disabled(store.isRunning || store.isSending || store.isLoading)
                VStack(alignment: .leading, spacing: 2) {
                    if store.isRunning && hasText && verticalSizeClass != .compact {
                        sendModeMenu(compact: false)
                            .padding(.horizontal, 12).padding(.top, 6)
                    }
                    TextField(uncensiaText("发消息"), text: $store.draft, axis: .vertical)
                        .lineLimit(1...5).focused($inputFocused)
                        .disabled(!ownsDraft)
                        .accessibilityIdentifier("chat.composer").textFieldStyle(.plain)
                        .padding(.horizontal, 12).padding(.vertical, 11)
                }
                .frame(minHeight: 44).background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 22))
                if store.isRunning && hasText && verticalSizeClass == .compact {
                    sendModeMenu(compact: true)
                }
                if store.isRunning {
                    Button(action: stop) {
                        Group {
                            if pendingStop != nil { ProgressView() }
                            else { Image("lucide-square") }
                        }.frame(width: 44, height: 44)
                    }.accessibilityLabel(uncensiaText("停止"))
                        .buttonStyle(.plain).background(Color.primary.opacity(0.09), in: Circle())
                        .disabled(pendingStop != nil)
                }
                if !store.isRunning || hasText {
                    Button(action: send) {
                        Group {
                            if store.isSending || pendingCommand != nil { ProgressView().tint(.white) }
                            else { Image("lucide-arrow-up") }
                        }.frame(width: 44, height: 44)
                    }
                    .accessibilityLabel(editingSeq == nil ? uncensiaText("发送") : uncensiaText("编辑并重试"))
                    .buttonStyle(.plain).foregroundStyle(canSend ? Color(uiColor: .systemBackground) : .secondary)
                    .background(canSend ? Color.primary : Color.secondary.opacity(0.1), in: Circle())
                    .disabled(!canSend)
                }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8).background(.bar)
        .onChange(of: store.draft) { _, _ in saveDraftSoon() }
        .onChange(of: app.pendingAttachments) { _, _ in saveDraftSoon() }
        .onChange(of: store.draftScope) { _, _ in mergeCompletedUploads() }
        .onChange(of: app.selectedConversationID) { _, _ in
            draftSaveTask?.cancel(); pendingCommand = nil; pendingStop = nil; uploadError = nil
        }
        .onChange(of: scenePhase) { _, phase in if phase != .active { saveDraftNow() } }
        .onDisappear { saveDraftNow() }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): upload(urls)
            case .failure(let error): uploadError = error.localizedDescription
            }
        }
        .photosPicker(isPresented: $choosingPhotos, selection: $photos, maxSelectionCount: 10, matching: .any(of: [.images, .videos]))
        .onChange(of: photos) { _, items in uploadPhotos(items) }
    }

    private func sendModeMenu(compact: Bool) -> some View {
        Menu {
            Picker(uncensiaText("消息发送方式"), selection: $mode) {
                Text(uncensiaText("追问")).tag("follow-up")
                Text(uncensiaText("转向")).tag("steer")
            }
        } label: {
            Group {
                if compact {
                    Image(systemName: mode == "steer" ? "arrow.turn.up.right" : "text.line.first.and.arrowtriangle.forward")
                        .frame(width: 44, height: 44)
                } else {
                    HStack(spacing: 4) {
                        Text(uncensiaText(mode == "steer" ? "转向" : "追问"))
                        Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold))
                    }.font(.caption)
                }
            }.foregroundStyle(.secondary)
        }
        .accessibilityLabel(uncensiaText("消息发送方式"))
        .accessibilityValue(uncensiaText(mode == "steer" ? "转向" : "追问"))
        .buttonStyle(.plain)
    }

    private var attachments: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(Array(app.pendingAttachments.enumerated()), id: \.offset) { index, item in
                    let name = item["file"]["name"].stringValue ?? item["name"].stringValue ?? uncensiaText("附件")
                    HStack(spacing: 6) {
                        Label(name, image: "lucide-paperclip").lineLimit(1)
                        Button {
                            guard app.pendingAttachments.indices.contains(index) else { return }
                            app.pendingAttachments.remove(at: index)
                        } label: { Image(systemName: "xmark.circle.fill").frame(width: 32, height: 36) }
                            .accessibilityLabel(uncensiaText("移除附件 %@", name))
                    }.font(.caption).padding(.leading, 10)
                        .background(Color.secondary.opacity(0.08), in: Capsule())
                }
            }
        }.scrollIndicators(.hidden)
    }

    private func send() {
        guard canSend else { return }
        if store.isRunning {
            guard let id = app.selectedConversationID, let api = app.api else { return }
            let text = store.draft
            let command = mode
            let request = UUID()
            pendingCommand = request
            Task {
                let sent = await store.command(command, body: .object(["text": .string(text)]), id: id, api: api)
                guard pendingCommand == request else { return }
                pendingCommand = nil
                if sent, app.api?.server == api.server, app.selectedConversationID == id, store.draft == text {
                    store.draft = ""; saveDraftNow()
                }
            }
        } else {
            guard let api = app.api, let scope = store.draftScope else { return }
            let id = app.selectedConversationID
            let text = store.draft
            let attachments = app.pendingAttachments
            let modelID = store.selectedModelID
            let seq = editingSeq
            let request = UUID()
            pendingCommand = request
            Task {
                defer { if pendingCommand == request { pendingCommand = nil } }
                // A queued tap must not read another conversation's input after
                // selection changes but before SwiftUI processes its onChange.
                guard pendingCommand == request, app.api === api, app.selectedConversationID == id, store.draftScope == scope,
                      store.draft == text, app.pendingAttachments == attachments,
                      store.selectedModelID == modelID, editingSeq == seq else { return }
                if await store.send(app: app, modelID: modelID.isEmpty ? nil : modelID, fromSeq: seq),
                   pendingCommand == request, app.api === api, editingSeq == seq,
                   id == nil || app.selectedConversationID == id {
                    editingSeq = nil
                }
            }
        }
    }

    private func stop() {
        guard pendingStop == nil, let id = app.selectedConversationID, let api = app.api else { return }
        let request = UUID(); pendingStop = request
        Task {
            await store.command("stop", id: id, api: api)
            if pendingStop == request { pendingStop = nil }
        }
    }

    private func saveDraftSoon() {
        draftSaveTask?.cancel()
        guard ownsDraft, let server = app.api?.server else { return }
        let id = app.selectedConversationID
        let draft = Draft(text: store.draft, attachments: app.pendingAttachments)
        let drafts = app.drafts
        draftSaveTask = Task {
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            guard !Task.isCancelled else { return }
            await drafts.save(draft, server: server, conversationID: id)
        }
    }

    private func saveDraftNow() {
        draftSaveTask?.cancel()
        guard ownsDraft, let server = app.api?.server else { return }
        let id = app.selectedConversationID
        let draft = Draft(text: store.draft, attachments: app.pendingAttachments)
        Task { await app.drafts.save(draft, server: server, conversationID: id) }
    }

    private func upload(_ urls: [URL]) {
        guard let api = app.api, !urls.isEmpty else { return }
        let id = app.selectedConversationID
        let tickets = uploads.begin(server: api.server, conversationID: id, count: urls.count)
        uploadError = nil
        Task {
            for (url, ticket) in zip(urls, tickets) {
                do {
                    let data = try await Task.detached(priority: .userInitiated) {
                        let scoped = url.startAccessingSecurityScopedResource()
                        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                        return try Data(contentsOf: url, options: .mappedIfSafe)
                    }.value
                    let uploaded = try await api.upload(data: data, filename: url.lastPathComponent,
                        mimeType: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream")
                    await keepUpload(uploaded, api: api, conversationID: id)
                } catch {
                    if app.api?.server == api.server, app.selectedConversationID == id {
                        uploadError = uncensiaText("上传 %@ 失败：%@", url.lastPathComponent, error.localizedDescription)
                    }
                }
                uploads.finish(ticket)
            }
        }
    }

    private func uploadPhotos(_ items: [PhotosPickerItem]) {
        guard let api = app.api, !items.isEmpty else { return }
        let id = app.selectedConversationID
        let tickets = uploads.begin(server: api.server, conversationID: id, count: items.count)
        uploadError = nil
        Task {
            for (item, ticket) in zip(items, tickets) {
                do {
                    guard let data = try await item.loadTransferable(type: Data.self) else { throw URLError(.cannotDecodeContentData) }
                    let type = item.supportedContentTypes.first ?? .image
                    let name = "\(UUID().uuidString).\(type.preferredFilenameExtension ?? "jpg")"
                    let uploaded = try await api.upload(data: data, filename: name, mimeType: type.preferredMIMEType ?? "image/jpeg")
                    await keepUpload(uploaded, api: api, conversationID: id)
                } catch {
                    if app.api?.server == api.server, app.selectedConversationID == id { uploadError = error.localizedDescription }
                }
                uploads.finish(ticket)
            }
            if photos == items { photos = [] }
        }
    }

    private func keepUpload(_ uploaded: JSONValue, api: APIClient, conversationID: String?) async {
        let attachment = JSONValue.object(["file": uploaded, "role": .string("context")])
        uploads.stage(attachment, server: api.server, conversationID: conversationID)
        if app.api?.server == api.server, app.selectedConversationID == conversationID,
           store.ownsDraft(server: api.server, conversationID: conversationID) {
            mergeCompletedUploads()
        } else {
            // Upload completion belongs to its original draft even after navigation.
            await app.drafts.appendAttachment(attachment, server: api.server, conversationID: conversationID)
            mergeCompletedUploads()
        }
    }

    private func mergeCompletedUploads() {
        guard ownsDraft, let server = app.api?.server else { return }
        let completed = uploads.takeCompleted(server: server, conversationID: app.selectedConversationID)
        guard !completed.isEmpty else { return }
        for attachment in completed where !app.pendingAttachments.contains(attachment) {
            app.pendingAttachments.append(attachment)
        }
        saveDraftNow()
    }
}
