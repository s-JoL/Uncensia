import SwiftUI
import UniformTypeIdentifiers

public struct ChatScreen: View {
    @Environment(AppModel.self) private var app
    @State private var store = ChatStore()
    @State private var showList = false
    @State private var showContext = false
    @State private var showTasks = false
    @State private var showBranches = false
    @State private var exporting = false
    @State private var exportDocument = ExportDocument(data: Data())
    @State private var models: [JSONValue] = []
    @State private var editingSeq: Int?
    @State private var didLoad = false
    @Environment(\.scenePhase) private var scenePhase

    public init() {}
    public var body: some View {
        @Bindable var app = app
        NavigationStack {
            VStack(spacing: 0) {
                if let error = store.error { HStack { Text(error).font(.footnote).foregroundStyle(.red); Spacer(); Button(uncensiaText("重试")) { guard let id = app.selectedConversationID, let api = app.api else { return }; Task { await store.resync(id: id, api: api) } } }.padding(.horizontal) }
                TranscriptView(store: store, conversationID: app.selectedConversationID, api: app.api, edit: edit)
                    .id(app.selectedConversationID ?? "new")
                    .environment(store.citations)
                ComposerView(store: store, app: app, editingSeq: $editingSeq)
            }
            .navigationTitle(currentTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button { withAnimation(.easeOut(duration: 0.2)) { showList = true } } label: { Image("lucide-menu") }.accessibilityIdentifier("conversation.history") }
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
                    Menu {
                        Button(uncensiaText("对话设定"), image: "lucide-sliders-horizontal") { showContext = true }
                        Button(uncensiaText("分支"), image: "lucide-git-branch") { showBranches = true }
                        Button(uncensiaText("后台任务"), image: "lucide-clock") { showTasks = true }
                        Button(uncensiaText("整理上下文"), image: "lucide-minimize-2") { runCommand("compact") }
                        Button(uncensiaText("继续"), image: "lucide-play") { runCommand("continue") }
                        Button(uncensiaText("导出 JSONL"), image: "lucide-share") { exportConversation() }.disabled(app.selectedConversationID == nil)
                    } label: { Image("lucide-ellipsis") }
                }
            }

            .sheet(isPresented: $showContext) { ConversationContextSheet(details: store.conversationDetails, id: app.selectedConversationID, api: app.api, store: store) }
            .sheet(isPresented: $showBranches) { BranchSheet(id: app.selectedConversationID, api: app.api, app: app, store: store) }
            .sheet(isPresented: $showTasks) { BackgroundTasksSheet(id: app.selectedConversationID, api: app.api, app: app) }
            .fileExporter(isPresented: $exporting, document: exportDocument, contentType: .json, defaultFilename: "uncensia-conversation.jsonl") { result in if case .failure(let error) = result { store.error = error.localizedDescription } }
            .task {
                guard !didLoad else { return }
                didLoad = true
                if let api = app.api {
                    async let history: Void = store.loadConversations(api: api)
                    async let catalogue: Void = loadModels(api: api)
                    if let id = app.selectedConversationID { await store.open(id: id, app: app) }
                    else { let saved = await app.drafts.load(server: api.server, conversationID: nil); store.draft = saved.text; app.pendingAttachments = saved.attachments }
                    _ = await (history, catalogue)
                }
            }
            .onChange(of: app.selectedConversationID) { oldID, id in
                guard oldID != id else { return }
                // Only our own newly created ID is adopted without reloading.
                guard !(oldID == nil && id == store.createdConversationID) else { return }
                let oldDraft = Draft(text: store.draft, attachments: app.pendingAttachments)
                let server = app.api?.server
                editingSeq = nil
                store.clearForConversationSwitch(loading: id != nil)
                app.pendingAttachments = []
                if id == nil { store.selectedModelID = app.bootstrap["defaultModelId"].stringValue ?? "" }
                Task {
                    if let server { await app.drafts.save(oldDraft, server: server, conversationID: oldID) }
                    guard app.selectedConversationID == id else { return }
                    if let id { await store.open(id: id, app: app) }
                    else if let server {
                        let saved = await app.drafts.load(server: server, conversationID: nil)
                        guard app.selectedConversationID == nil else { return }
                        store.draft = saved.text; app.pendingAttachments = saved.attachments
                    }
                }
            }
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
    private func closeHistory() { withAnimation(.easeOut(duration: 0.2)) { showList = false } }
    private func loadModels(api: APIClient) async {
                    do {
                        let items: [JSONValue]
                        if let bootstrapped = app.bootstrap["models"].arrayValue { items = bootstrapped }
                        else { items = try await api.request("GET", "/models")["items"].arrayValue ?? [] }
                        models = items.filter { ($0["kind"].stringValue ?? "chat") == "chat" && $0["enabled"].boolValue != false && $0["configured"].boolValue != false }
                        if app.selectedConversationID == nil && store.selectedModelID.isEmpty {
                            store.selectedModelID = app.bootstrap["defaultModelId"].stringValue ?? ""
                        }
                    } catch { store.error = uncensiaText("无法载入模型：%@", String(describing: error.localizedDescription)) }
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
    var body: some View {
        ScrollView {
            LazyVStack(spacing: 20) {
                if store.olderCursor != nil { Button(uncensiaText("载入更早消息")) {
                    guard let conversationID, let api else { return }
                    guard !loadingOlder else { return }
                    let anchor = store.messages.first?.id
                    let interaction = viewport.interaction
                    loadingOlder = true
                    closeToBottom = false
                    scrollFollow.cancel()
                    Task {
                        let loaded = await store.loadOlder(id: conversationID, api: api)
                        loadingOlder = false
                        guard loaded, let anchor, viewport.interaction == interaction else { return }
                        scrollFollow.schedule {
                            guard viewport.interaction == interaction, !userScrolling else { return }
                            position.scrollTo(id: anchor, anchor: .top)
                        }
                    }
                }.disabled(loadingOlder) }
                ForEach(store.messages) { message in
                    MessageRow(message: message, api: api).id(message.id).accessibilityIdentifier("chat.message.\(message.id)").contextMenu {
                        if message.role == "user" { Button(uncensiaText("编辑并重试"), image: "lucide-pencil") { edit(message) } }
                    }
                }
                ForEach(store.approvals) { approval in ApprovalCard(item: approval, store: store, api: api) }
                if store.isRunning || !store.liveText.isEmpty { LiveTranscriptRow(store: store, api: api).id("live") }
                Color.clear.frame(height: 1).id("bottom")
            }.scrollTargetLayout().padding(.vertical, 20)
        }
        .accessibilityIdentifier("chat.transcript")
        .contentMargins(.horizontal, 20, for: .scrollContent)
        .scrollDismissesKeyboard(.interactively)
        .scrollPosition($position)
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .onScrollGeometryChange(for: TranscriptGeometry.self) { value in
            TranscriptGeometry(offset: value.contentOffset.y, height: value.contentSize.height, viewport: value.containerSize.height, visibleBottom: value.visibleRect.maxY, bottomInset: value.contentInsets.bottom)
        } action: { old, new in
            // Image decoding and lazy layout estimates are not new assistant output.
            // Only a live tail may request bottom following.
            if store.isRunning, closeToBottom, !userScrolling, new.height > old.height {
                scrollFollow.schedule { if store.isRunning && closeToBottom && !userScrolling { position.scrollTo(edge: .bottom) } }
            }
            let nowClose = new.distanceFromBottom < 96
            viewport.nearBottom = nowClose
            if userScrolling {
                if new.offset < old.offset - 1 { viewport.lastMovementDown = false }
                else if new.offset > old.offset + 1 { viewport.lastMovementDown = true }
            }
        }
        .onScrollPhaseChange { _, phase in
            let wasUserScrolling = userScrolling
            userScrolling = phase == .interacting || phase == .decelerating || phase == .tracking
            if userScrolling { scrollFollow.cancel() }
            if phase == .tracking || phase == .interacting {
                viewport.interaction += 1
                closeToBottom = false
                viewport.lastMovementDown = false
            }
            if phase == .idle && wasUserScrolling { closeToBottom = viewport.nearBottom && viewport.lastMovementDown }
        }
        .overlay { if store.isLoading && store.messages.isEmpty { ProgressView() } else if store.messages.isEmpty && !store.isRunning { ContentUnavailableView(uncensiaText("开始对话"), image: "lucide-sparkles", description: Text(uncensiaText("可以聊天、处理资料，也可以直接创作图片和视频。"))) } }
        .overlay(alignment: .bottomTrailing) { if !closeToBottom { Button { closeToBottom = true; position.scrollTo(edge: .bottom) } label: { Image("lucide-arrow-down") }.accessibilityLabel(uncensiaText("返回最新消息")).buttonStyle(.borderedProminent).clipShape(Circle()).padding() } }
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
    var offset: CGFloat; var height: CGFloat; var viewport: CGFloat; var visibleBottom: CGFloat; var bottomInset: CGFloat
    var distanceFromBottom: CGFloat { max(0, height + bottomInset - visibleBottom) }
}

@MainActor private final class ViewportTracker {
    var interaction = 0
    var nearBottom = true
    var lastMovementDown = false
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
    @Bindable var store: ChatStore; let app: AppModel
    @Binding var editingSeq: Int?
    @State private var importing = false; @State private var mode = "follow-up"
    @FocusState private var inputFocused: Bool
    var body: some View { VStack(spacing: 8) {
        if !app.pendingAttachments.isEmpty { ScrollView(.horizontal) { HStack { ForEach(Array(app.pendingAttachments.enumerated()), id: \.offset) { index, item in Label(item["file"]["name"].stringValue ?? item["name"].stringValue ?? uncensiaText("附件"), image: "lucide-paperclip").padding(8).background(.thinMaterial, in: Capsule()).onTapGesture { app.pendingAttachments.remove(at: index) } } } }.scrollIndicators(.hidden) }
        if store.isRunning { HStack { Picker("", selection: $mode) { Text(uncensiaText("追问")).tag("follow-up"); Text(uncensiaText("转向")).tag("steer") }.labelsHidden(); Spacer(); Button(uncensiaText("停止"), image: "lucide-square") { guard let id = app.selectedConversationID, let api = app.api else { return }; Task { await store.command("stop", id: id, api: api) } } }.font(.caption) }
        if let editingSeq { HStack { Label(uncensiaText("正在编辑第 %@ 条消息", String(describing: editingSeq)), image: "lucide-pencil"); Spacer(); Button(uncensiaText("取消")) { self.editingSeq = nil } }.font(.caption).foregroundStyle(.secondary).padding(.horizontal) }
        HStack(alignment: .bottom) { Button { importing = true } label: { Image("lucide-plus") }.accessibilityLabel(uncensiaText("添加附件")).frame(width: 36, height: 44).buttonStyle(.plain); TextField(uncensiaText("发消息"), text: $store.draft, axis: .vertical).lineLimit(1...5).focused($inputFocused).accessibilityIdentifier("chat.composer").textFieldStyle(.plain).padding(.horizontal, 12).padding(.vertical, 10).background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 20)).onChange(of: store.draft) { Task { await store.saveDraft(app: app) } }; Button {
            if store.isRunning {
                guard let id = app.selectedConversationID, let api = app.api else { return }
                let text = store.draft; let command = mode
                Task { if await store.command(command, body: .object(["text": .string(text)]), id: id, api: api), store.draft == text { store.draft = ""; await store.saveDraft(app: app) } }
            } else { let seq = editingSeq; editingSeq = nil; Task { await store.send(app: app, modelID: store.selectedModelID.isEmpty ? nil : store.selectedModelID, fromSeq: seq) } }
        } label: { Image("lucide-arrow-up") }.accessibilityLabel(editingSeq == nil ? uncensiaText("发送") : uncensiaText("编辑并重试")).buttonStyle(.borderedProminent).clipShape(Circle()).disabled(store.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.isSending || store.isLoading) }
    }.padding().background(.bar).toolbar { ToolbarItemGroup(placement: .keyboard) { Spacer(); Button { inputFocused = false } label: { Image("lucide-keyboard") }.accessibilityLabel(uncensiaText("收起键盘")) } }.fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in Task { if case .success(let urls) = result, let api = app.api { for url in urls { guard url.startAccessingSecurityScopedResource() else { continue }; defer { url.stopAccessingSecurityScopedResource() }; if let data = try? Data(contentsOf: url), let uploaded = try? await api.upload(data: data, filename: url.lastPathComponent, mimeType: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream") { app.pendingAttachments.append(.object(["file": uploaded, "role": .string("context")])) } }; await store.saveDraft(app: app) } } } }
}
