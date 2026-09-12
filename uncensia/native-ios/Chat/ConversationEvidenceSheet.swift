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
    }

    private var deliverablesSection: some View {
        Section(uncensiaText("交付")) {
            ForEach(Array(deliverables.enumerated()), id: \.offset) { _, item in
                DeliverableCard(conversationID: id, item: item, api: api) { await load() }
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

private struct DeliverableCard: View {
    let conversationID: String
    let item: JSONValue
    let api: APIClient?
    let onChanged: @MainActor () async -> Void
    @State private var versions: [JSONValue]?
    @State private var comparison: JSONValue?
    @State private var resource: TranscriptResourceLink?
    @State private var busy = false
    @State private var error: String?

    private var key: String { item["key"].stringValue ?? "" }
    private var revision: Int { item["revision"].intValue ?? 0 }
    private var assetID: String? { item["asset_id"].stringValue }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text("\(key) · \(item["description"].stringValue ?? "")").font(.headline).textSelection(.enabled)
            Text(summary).font(.caption).foregroundStyle(.secondary)
            if let detail = item["evidence"].stringValue, !detail.isEmpty {
                DisclosureGroup(uncensiaText("检查依据")) {
                    Text(detail).font(.subheadline).textSelection(.enabled)
                }
            }
            if let assetID {
                Button { resource = .init(kind: .file, assetID: assetID) } label: {
                    Label(uncensiaText("预览原件"), systemImage: "doc")
                }.accessibilityIdentifier("conversation.deliverable.\(key.isEmpty ? assetID : key)")
            }
            if assetID != nil, revision > 0, item["status"].stringValue != "pending" {
                HStack {
                    Button(uncensiaText("接受版本 %@", String(revision))) { review("accepted") }
                        .disabled(busy || item["review"]["status"].stringValue == "accepted")
                    Button(uncensiaText("退回版本 %@", String(revision)), role: .destructive) { review("rejected") }
                        .disabled(busy || item["review"]["status"].stringValue == "rejected")
                }.font(.caption)
            }
            Button(versions == nil ? uncensiaText("查看版本") : uncensiaText("隐藏版本")) {
                if versions == nil { Task { await loadVersions() } } else { versions = nil; comparison = nil }
            }.font(.caption)
            if let versions { versionList(versions) }
            if let comparison { comparisonView(comparison) }
            if let error { Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
        }.padding(.vertical, 4).buttonStyle(.borderless)
        .sheet(item: $resource) { TranscriptResourceViewer(resource: $0, api: api) }
    }

    private var summary: String {
        var parts = [uncensiaText("版本 %@", String(revision)), statusLabel(item["status"].stringValue)]
        if let review = item["review"]["status"].stringValue {
            parts.append(review == "accepted" ? uncensiaText("用户已接受") : uncensiaText("用户已退回"))
        }
        return parts.joined(separator: " · ")
    }

    private func versionList(_ values: [JSONValue]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            // Revisions intentionally share one deliverable key; the complete
            // immutable record, not `stableID`, distinguishes each row.
            ForEach(values, id: \.self) { version in
                VStack(alignment: .leading, spacing: 4) {
                    Text(uncensiaText("版本 %@ · %@", String(version["revision"].intValue ?? 0), version["description"].stringValue ?? ""))
                    HStack {
                        if let asset = version["asset_id"].stringValue {
                            Button(uncensiaText("预览原件")) { resource = .init(kind: .file, assetID: asset) }
                            if version["revision"].intValue != revision, assetID != nil {
                                Button(uncensiaText("与当前版本比较")) { Task { await compare(version["revision"].intValue ?? 0) } }
                            }
                        }
                    }.font(.caption)
                }.padding(8).background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
            }
        }
    }

    @ViewBuilder private func comparisonView(_ value: JSONValue) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(uncensiaText("版本 %@ → %@", String(value["from"]["revision"].intValue ?? 0), String(value["to"]["revision"].intValue ?? 0))).font(.headline)
                Spacer()
                Button(uncensiaText("关闭比较")) { comparison = nil }.font(.caption)
            }
            if value["kind"].stringValue == "text" {
                ScrollView([.vertical, .horizontal]) {
                    Text(value["patch"].stringValue ?? "").font(.caption.monospaced()).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }.frame(maxHeight: 360)
            } else {
                Text(value["reason"].stringValue == "size"
                    ? uncensiaText("内容较大，请分别阅读原件；未生成完整文本差异。")
                    : uncensiaText("此格式使用原件并排预览。文档显示提取的文本。"))
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    previewButton(value["from"])
                    previewButton(value["to"])
                }
            }
        }.padding(10).background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 10))
    }

    private func previewButton(_ version: JSONValue) -> some View {
        Button(uncensiaText("预览版本 %@", String(version["revision"].intValue ?? 0))) {
            if let asset = version["asset_id"].stringValue { resource = .init(kind: .file, assetID: asset) }
        }.disabled(version["asset_id"].stringValue == nil)
    }

    private func statusLabel(_ value: String?) -> String {
        switch value {
        case "verified": return uncensiaText("模型已检查")
        case "produced": return uncensiaText("已生成")
        default: return uncensiaText("待完成")
        }
    }

    private func review(_ status: String) {
        guard let api else { error = uncensiaText("请先连接服务器。"); return }
        busy = true; error = nil
        Task {
            defer { busy = false }
            do {
                _ = try await api.request("POST", "/resources/conversations/\(urlPart(conversationID))/deliverables/\(urlPart(key))/review",
                    body: .object(["revision": .integer(revision), "status": .string(status)]))
                versions = nil
                await onChanged()
            } catch { self.error = error.localizedDescription; await onChanged() }
        }
    }

    private func loadVersions() async {
        guard let api else { error = uncensiaText("请先连接服务器。"); return }
        busy = true
        defer { busy = false }
        do {
            versions = try await api.request("GET", "/resources/conversations/\(urlPart(conversationID))/deliverables/\(urlPart(key))/versions").arrayValue ?? []
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    private func compare(_ from: Int) async {
        guard let api else { return }
        busy = true
        defer { busy = false }
        do {
            comparison = try await api.request("GET", "/resources/conversations/\(urlPart(conversationID))/deliverables/\(urlPart(key))/compare?from=\(from)&to=\(revision)")
            error = nil
        } catch { self.error = error.localizedDescription }
    }
}
