import SwiftUI

/// Reads the server's original extracted text, including legacy encodings.
/// The ordinary library preview continues to show the original file.
struct ResourceReaderSheet: View {
    let fileID: String
    let title: String
    let media: Bool
    let api: APIClient?
    @Environment(\.dismiss) private var dismiss
    @State private var page: JSONValue?
    @State private var sources: [JSONValue] = []
    @State private var pageError: String?
    @State private var sourceError: String?
    @State private var start = 1
    @State private var previousStarts: [Int] = []
    @State private var encoding = ""
    @State private var attempt = 0
    @State private var original: TranscriptResourceLink?

    private var requestKey: String { "\(fileID)|\(start)|\(encoding)|\(attempt)" }

    var body: some View {
        NavigationStack {
            ScrollViewReader { scroll in
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        Color.clear.frame(height: 1).id("reader.top")
                        Button {
                            original = .init(kind: .file, assetID: fileID)
                        } label: { Label(uncensiaText("打开原件"), systemImage: "doc") }
                            .accessibilityIdentifier("resource.reader.original")
                        sourceSection
                        if !media { textSection }
                    }.padding()
                }
                .accessibilityIdentifier("resource.reader")
                .onChange(of: start) { _, _ in scroll.scrollTo("reader.top", anchor: .top) }
                .onChange(of: encoding) { _, _ in
                    previousStarts = []; start = 1
                    scroll.scrollTo("reader.top", anchor: .top)
                }
            }
            .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(uncensiaText("完成")) { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button { attempt += 1 } label: { Image(systemName: "arrow.clockwise") }
                        .accessibilityLabel(uncensiaText("刷新"))
                }
            }
        }
        .task(id: "\(fileID)|\(attempt)") { await loadSources() }
        .task(id: requestKey) { await loadText() }
        .sheet(item: $original) { TranscriptResourceViewer(resource: $0, api: api) }
    }

    @ViewBuilder private var sourceSection: some View {
        if !sources.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text(uncensiaText("来源")).font(.headline)
                ForEach(Array(sources.enumerated()), id: \.offset) { _, source in
                    if let raw = source["original_url"].stringValue,
                       let url = URL(string: raw), ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                        Link(raw, destination: url).font(.subheadline).textSelection(.enabled)
                            .accessibilityIdentifier("resource.reader.source")
                        if let fetched = source["fetched_at"].stringValue {
                            Text(fetched).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        } else if let sourceError {
            VStack(alignment: .leading, spacing: 8) {
                Text(sourceError).font(.footnote).foregroundStyle(.secondary)
                Button(uncensiaText("重试")) { attempt += 1 }
            }
        } else if media {
            Text(uncensiaText("暂无来源记录")).foregroundStyle(.secondary)
        }
    }

    private var textSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            Picker(uncensiaText("文本编码"), selection: $encoding) {
                Text("UTF-8 / PDF / DOCX / EPUB").tag("")
                Text("GB18030").tag("gb18030")
                Text("Big5").tag("big5")
                Text("UTF-16 LE").tag("utf-16le")
            }.accessibilityIdentifier("resource.reader.encoding")
            if let page {
                let total = page["total_lines"].intValue ?? 0
                let next = page["next_line"].intValue
                Text(uncensiaText("第 %@–%@ 行，共 %@ 行", String(start), String(next.map { $0 - 1 } ?? total), String(total)))
                    .font(.caption).foregroundStyle(.secondary).monospacedDigit()
                    .accessibilityIdentifier("resource.reader.range")
                Text(page["text"].stringValue ?? "")
                    .font(.body).textSelection(.enabled).lineSpacing(4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("resource.reader.text")
                HStack {
                    Button(uncensiaText("上一页")) {
                        guard let previous = previousStarts.popLast() else { return }
                        start = previous
                    }.disabled(previousStarts.isEmpty).accessibilityIdentifier("resource.reader.previous")
                    Spacer()
                    Button(uncensiaText("下一页")) {
                        guard let next, next > start else { return }
                        previousStarts.append(start); start = next
                    }.disabled(next == nil || (next ?? 0) <= start).accessibilityIdentifier("resource.reader.next")
                }.buttonStyle(.bordered)
            } else if let pageError {
                Text(pageError).foregroundStyle(.secondary)
                Button(uncensiaText("重试")) { attempt += 1 }
            } else {
                ProgressView(uncensiaText("正在读取…")).frame(maxWidth: .infinity, minHeight: 100)
            }
        }
    }

    private func loadSources() async {
        sourceError = nil
        guard let api else { sourceError = uncensiaText("请先连接服务器。"); return }
        do {
            let result = try await api.request("GET", "/resources/sources/\(fileID)")
            guard !Task.isCancelled else { return }
            sources = result.arrayValue ?? []
        } catch {
            guard !Task.isCancelled else { return }
            sourceError = error.localizedDescription
        }
    }

    private func loadText() async {
        guard !media else { return }
        page = nil; pageError = nil
        guard let api else { pageError = uncensiaText("请先连接服务器。"); return }
        var components = URLComponents()
        components.queryItems = [URLQueryItem(name: "start", value: String(start))]
        if !encoding.isEmpty { components.queryItems?.append(URLQueryItem(name: "encoding", value: encoding)) }
        do {
            let result = try await api.request("GET", "/resources/files/\(fileID)?\(components.percentEncodedQuery ?? "")")
            guard !Task.isCancelled else { return }
            page = result
        } catch {
            guard !Task.isCancelled else { return }
            pageError = error.localizedDescription
        }
    }
}
