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
    @State private var loadedConversationID: String?
    @Environment(\.scenePhase) private var scenePhase

    public init() {}
    public var body: some View {
        @Bindable var app = app
        NavigationStack {
            VStack(spacing: 0) {
                if let error = store.error { Text(error).font(.footnote).foregroundStyle(.red).padding(.horizontal) }
                TranscriptView(store: store, conversationID: app.selectedConversationID, api: app.api, edit: edit)
                    .id(app.selectedConversationID ?? "new")
                ComposerView(store: store, app: app, editingSeq: $editingSeq)
            }
            .navigationTitle(currentTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button { showList = true } label: { Image(systemName: "sidebar.left") } }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Picker(uncensiaText("模型"), selection: Binding(get: { store.selectedModelID }, set: { setModel($0) })) {
                        ForEach(models, id: \.self) { model in Text(model["name"].stringValue ?? model["id"].stringValue ?? uncensiaText("模型")).tag(model["id"].stringValue ?? "") }
                    }.labelsHidden().disabled(app.selectedConversationID == nil || store.isRunning)
                    if store.isRunning { Button(uncensiaText("停止"), systemImage: "stop.fill") { runCommand("stop") } }
                    Menu {
                        Button(uncensiaText("对话设定"), systemImage: "person.text.rectangle") { showContext = true }
                        Button(uncensiaText("分支"), systemImage: "arrow.triangle.branch") { showBranches = true }
                        Button(uncensiaText("后台任务"), systemImage: "clock") { showTasks = true }
                        Button(uncensiaText("整理上下文"), systemImage: "arrow.down.right.and.arrow.up.left") { runCommand("compact") }
                        Button(uncensiaText("继续"), systemImage: "play") { runCommand("continue") }
                        Button(uncensiaText("导出 JSONL"), systemImage: "square.and.arrow.up") { exportConversation() }.disabled(app.selectedConversationID == nil)
                    } label: { Image(systemName: "ellipsis.circle") }
                }
            }
            .sheet(isPresented: $showList) { ConversationList(store: store, app: app) }
            .sheet(isPresented: $showContext) { ConversationContextSheet(details: store.conversationDetails, id: app.selectedConversationID, api: app.api, store: store) }
            .sheet(isPresented: $showBranches) { BranchSheet(id: app.selectedConversationID, api: app.api, app: app, store: store) }
            .sheet(isPresented: $showTasks) { BackgroundTasksSheet(id: app.selectedConversationID, api: app.api, app: app) }
            .fileExporter(isPresented: $exporting, document: exportDocument, contentType: .json, defaultFilename: "uncensia-conversation.jsonl") { result in if case .failure(let error) = result { store.error = error.localizedDescription } }
            .task {
                if let api = app.api {
                    do {
                        let catalogue = try await api.request("GET", "/models")
                        models = (catalogue["items"].arrayValue ?? []).filter { ($0["kind"].stringValue ?? "chat") == "chat" && $0["enabled"].boolValue != false && $0["configured"].boolValue != false }
                    } catch { store.error = uncensiaText("无法载入模型：%@", String(describing: error.localizedDescription)) }
                    await store.loadConversations(api: api)
                    if let id = app.selectedConversationID { loadedConversationID = id; await store.open(id: id, app: app) }
                    else { let saved = await app.drafts.load(server: api.server, conversationID: nil); store.draft = saved.text; app.pendingAttachments = saved.attachments }
                }
            }
            .onChange(of: app.selectedConversationID) { oldID, id in
                guard oldID != id else { return }
                let oldDraft = Draft(text: store.draft, attachments: app.pendingAttachments)
                let server = app.api?.server
                loadedConversationID = id; editingSeq = nil
                Task {
                    if let server { await app.drafts.save(oldDraft, server: server, conversationID: oldID) }
                    if let id, !store.isSending { await store.open(id: id, app: app) }
                    else if id == nil, let server { let saved = await app.drafts.load(server: server, conversationID: nil); store.messages = []; store.draft = saved.text; app.pendingAttachments = saved.attachments }
                }
            }
            .onChange(of: scenePhase) { _, phase in if phase == .active, let id = app.selectedConversationID, let api = app.api { Task { await store.resync(id: id, api: api) } } }
        }
    }
    private var currentTitle: String { store.conversations.first { $0.id == app.selectedConversationID }?.title ?? "Uncensia" }
    private func runCommand(_ command: String) { guard let id = app.selectedConversationID, let api = app.api else { return }; Task { await store.command(command, id: id, api: api) } }
    private func setModel(_ modelID: String) { guard !modelID.isEmpty, let id = app.selectedConversationID, let api = app.api else { return }; Task { await store.setModel(modelID, id: id, api: api) } }
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
    @State private var pendingPrepend: PendingPrepend?
    var body: some View {
        ScrollView {
            LazyVStack(spacing: 20) {
                if store.olderCursor != nil { Button(uncensiaText("载入更早消息")) {
                    guard let conversationID, let api else { return }
                    pendingPrepend = PendingPrepend(offset: viewport.offset, height: viewport.height, messageCount: store.messages.count)
                    Task { if !(await store.loadOlder(id: conversationID, api: api)) { pendingPrepend = nil } }
                } }
                ForEach(store.messages) { message in
                    MessageRow(message: message, api: api).id(message.id).contextMenu {
                        if message.role == "user" { Button(uncensiaText("编辑并重试"), systemImage: "pencil") { edit(message) } }
                    }
                }
                ForEach(store.approvals) { approval in ApprovalCard(item: approval, store: store, api: api) }
                if store.isRunning { LiveTranscriptRow(store: store, api: api).id("live") }
                Color.clear.frame(height: 1).id("bottom")
            }.scrollTargetLayout().padding(.vertical, 20)
        }
        .contentMargins(.horizontal, 20, for: .scrollContent)
        .scrollPosition($position)
        .defaultScrollAnchor(.bottom)
        .onScrollGeometryChange(for: TranscriptGeometry.self) { value in
            TranscriptGeometry(offset: value.contentOffset.y, height: value.contentSize.height, viewport: value.containerSize.height, visibleBottom: value.visibleRect.maxY, bottomInset: value.contentInsets.bottom)
        } action: { old, new in
            viewport.offset = new.offset; viewport.height = new.height
            if let pendingPrepend, store.messages.count > pendingPrepend.messageCount, new.height > pendingPrepend.height {
                self.pendingPrepend = nil
                position.scrollTo(y: max(0, pendingPrepend.offset + new.height - pendingPrepend.height))
            } else if closeToBottom, new.height > old.height {
                position.scrollTo(edge: .bottom)
            }
            let nowClose = new.distanceFromBottom < 96
            if closeToBottom != nowClose { closeToBottom = nowClose }
        }
        .onScrollPhaseChange { _, phase in if phase == .interacting { pendingPrepend = nil } }
        .overlay { if store.isLoading { ProgressView() } else if store.messages.isEmpty && !store.isRunning { ContentUnavailableView(uncensiaText("开始对话"), systemImage: "sparkles", description: Text(uncensiaText("可以聊天、处理资料，也可以直接创作图片和视频。"))) } }
        .overlay(alignment: .bottomTrailing) { if !closeToBottom { Button { closeToBottom = true; position.scrollTo(edge: .bottom) } label: { Image(systemName: "arrow.down") }.accessibilityLabel(uncensiaText("返回最新消息")).buttonStyle(.borderedProminent).clipShape(Circle()).padding() } }
    }
}

private struct TranscriptGeometry: Equatable {
    var offset: CGFloat; var height: CGFloat; var viewport: CGFloat; var visibleBottom: CGFloat; var bottomInset: CGFloat
    var distanceFromBottom: CGFloat { max(0, height + bottomInset - visibleBottom) }
}

@MainActor private final class ViewportTracker {
    var offset: CGFloat = 0
    var height: CGFloat = 0
}

private struct PendingPrepend {
    let offset: CGFloat; let height: CGFloat; let messageCount: Int
}

private struct LiveTranscriptRow: View {
    @Bindable var store: ChatStore
    let api: APIClient?
    var body: some View { StreamingRow(text: store.liveText, status: store.liveStatus, api: api, thinking: store.liveThinking, tools: store.liveTools) }
}

private struct ApprovalCard: View {
    let item: ApprovalItem; let store: ChatStore; let api: APIClient?
    var body: some View { VStack(alignment: .leading, spacing: 10) { Label(uncensiaText("需要确认"), systemImage: "exclamationmark.shield").font(.headline); Text(item.summary); Text(item.action).font(.caption).foregroundStyle(.secondary); HStack { Button(uncensiaText("拒绝"), role: .destructive) { decide(false) }; Button(uncensiaText("允许")) { decide(true) }.buttonStyle(.borderedProminent) } }.padding().background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 16)) }
    private func decide(_ value: Bool) { guard let api else { return }; Task { await store.decide(item, approved: value, api: api) } }
}

private struct ComposerView: View {
    @Bindable var store: ChatStore; let app: AppModel
    @Binding var editingSeq: Int?
    @State private var importing = false; @State private var instruction = ""; @State private var mode = "steer"
    var body: some View { VStack(spacing: 8) {
        if !app.pendingAttachments.isEmpty { ScrollView(.horizontal) { HStack { ForEach(Array(app.pendingAttachments.enumerated()), id: \.offset) { index, item in Label(item["file"]["name"].stringValue ?? item["name"].stringValue ?? uncensiaText("附件"), systemImage: "paperclip").padding(8).background(.thinMaterial, in: Capsule()).onTapGesture { app.pendingAttachments.remove(at: index) } } } }.scrollIndicators(.hidden) }
        if store.isRunning { HStack { TextField(mode == "steer" ? uncensiaText("调整当前回答…") : uncensiaText("回答后继续…"), text: $instruction); Picker("", selection: $mode) { Text(uncensiaText("转向")).tag("steer"); Text(uncensiaText("追问")).tag("follow-up") }.labelsHidden(); Button(uncensiaText("提交")) { guard let id = app.selectedConversationID, let api = app.api else { return }; let text = instruction; instruction = ""; Task { await store.command(mode, body: .object(["text": .string(text)]), id: id, api: api) } }.disabled(instruction.trimmingCharacters(in: .whitespaces).isEmpty) }.padding(.horizontal) }
        if let editingSeq { HStack { Label(uncensiaText("正在编辑第 %@ 条消息", String(describing: editingSeq)), systemImage: "pencil"); Spacer(); Button(uncensiaText("取消")) { self.editingSeq = nil } }.font(.caption).foregroundStyle(.secondary).padding(.horizontal) }
        HStack(alignment: .bottom) { Button { importing = true } label: { Image(systemName: "plus") }.accessibilityLabel(uncensiaText("添加附件")).buttonStyle(.bordered); TextField(uncensiaText("发消息"), text: $store.draft, axis: .vertical).lineLimit(1...8).textFieldStyle(.roundedBorder).onChange(of: store.draft) { Task { await store.saveDraft(app: app) } }; Button { let seq = editingSeq; editingSeq = nil; Task { await store.send(app: app, modelID: store.selectedModelID.isEmpty ? nil : store.selectedModelID, fromSeq: seq) } } label: { Image(systemName: "arrow.up") }.accessibilityLabel(editingSeq == nil ? uncensiaText("发送") : uncensiaText("编辑并重试")).buttonStyle(.borderedProminent).disabled(store.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.isRunning) }
    }.padding().background(.bar).fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in Task { if case .success(let urls) = result, let api = app.api { for url in urls { guard url.startAccessingSecurityScopedResource() else { continue }; defer { url.stopAccessingSecurityScopedResource() }; if let data = try? Data(contentsOf: url), let uploaded = try? await api.upload(data: data, filename: url.lastPathComponent, mimeType: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream") { app.pendingAttachments.append(.object(["file": uploaded, "role": .string("context")])) } }; await store.saveDraft(app: app) } } } }
}
