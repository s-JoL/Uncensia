import SwiftUI

/// The same persisted deliverables, feedback and context records shown by Web.
struct ConversationEvidenceSheet: View {
    let id: String
    let api: APIClient?
    @Environment(\.dismiss) private var dismiss
    @State private var evidence: JSONValue?
    @State private var failure: String?
    @State private var attempt = 0
    @State private var requestRevision = UUID()
    @State private var resource: TranscriptResourceLink?

    private var deliverables: [JSONValue] { evidence?["deliverables"].arrayValue ?? [] }
    private var feedback: [JSONValue] { evidence?["feedback"].arrayValue ?? [] }
    private var contexts: [JSONValue] { evidence?["contexts"].arrayValue ?? [] }

    var body: some View {
        NavigationStack {
            Group {
                if evidence != nil {
                    if deliverables.isEmpty && feedback.isEmpty && contexts.isEmpty {
                        ContentUnavailableView(uncensiaText("暂无记录"), systemImage: "tray")
                    } else {
                        List {
                            if !deliverables.isEmpty { deliverablesSection }
                            if !feedback.isEmpty { feedbackSection }
                            if !contexts.isEmpty { contextsSection }
                        }.refreshable { await load() }
                    }
                } else if let failure {
                    VStack(spacing: 12) {
                        Text(failure).foregroundStyle(.secondary)
                        Button(uncensiaText("重试")) { attempt += 1 }
                    }.padding()
                } else {
                    ProgressView(uncensiaText("正在读取…"))
                }
            }
            .navigationTitle(uncensiaText("交付、反馈与执行记录"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(uncensiaText("完成")) { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button { attempt += 1 } label: { Image(systemName: "arrow.clockwise") }
                        .accessibilityLabel(uncensiaText("刷新"))
                }
            }
        }
        .accessibilityIdentifier("conversation.evidence")
        .task(id: "\(id)|\(attempt)") { await load() }
        .sheet(item: $resource) { TranscriptResourceViewer(resource: $0, api: api) }
    }

    private var deliverablesSection: some View {
        Section(uncensiaText("交付")) {
            ForEach(Array(deliverables.enumerated()), id: \.offset) { _, item in
                VStack(alignment: .leading, spacing: 8) {
                    Text(item["description"].stringValue ?? item["key"].stringValue ?? "").font(.headline)
                    Label(statusLabel(item["status"].stringValue), systemImage: item["status"].stringValue == "verified" ? "checkmark.seal" : "circle.dotted")
                        .font(.caption).foregroundStyle(.secondary)
                    if let detail = item["evidence"].stringValue, !detail.isEmpty {
                        Text(detail).font(.subheadline).textSelection(.enabled)
                    }
                    if let asset = item["asset_id"].stringValue {
                        Button {
                            resource = .init(kind: .file, assetID: asset)
                        } label: { Label(uncensiaText("打开交付文件"), systemImage: "doc") }
                            .accessibilityIdentifier("conversation.deliverable.\(item["key"].stringValue ?? asset)")
                    }
                }.padding(.vertical, 4)
            }
        }
    }

    private var feedbackSection: some View {
        Section(uncensiaText("反馈")) {
            ForEach(Array(feedback.enumerated()), id: \.offset) { _, item in
                Text(item["text"].stringValue ?? "").textSelection(.enabled)
            }
        }
    }

    private var contextsSection: some View {
        Section(uncensiaText("执行记录")) {
            ForEach(Array(contexts.enumerated()), id: \.offset) { _, item in
                DisclosureGroup(item["modelId"].stringValue ?? uncensiaText("模型")) {
                    let input = item["modelInput"].arrayValue?.compactMap(\.stringValue) ?? []
                    let tools = item["tools"].arrayValue?.compactMap(\.stringValue) ?? []
                    if !input.isEmpty {
                        Text(input.joined(separator: "\n")).font(.subheadline).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    if !tools.isEmpty {
                        Text(tools.joined(separator: "\n")).font(.caption).foregroundStyle(.secondary)
                            .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
    }

    private func statusLabel(_ value: String?) -> String {
        switch value {
        case "verified": return uncensiaText("已核验")
        case "produced": return uncensiaText("已生成")
        default: return uncensiaText("待完成")
        }
    }

    private func load() async {
        let revision = UUID()
        requestRevision = revision
        failure = nil
        guard let api else { failure = uncensiaText("请先连接服务器。"); return }
        do {
            let result = try await api.request("GET", "/resources/conversations/\(id)/evidence")
            guard !Task.isCancelled, requestRevision == revision else { return }
            evidence = result
        } catch {
            guard !Task.isCancelled, requestRevision == revision else { return }
            failure = error.localizedDescription
            evidence = nil
        }
    }
}
