import SwiftUI

struct ResourceImportSheet: View {
    let api: APIClient?
    let onImported: (JSONValue) async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var importing = false
    @State private var completed = false
    @State private var failure: String?
    @State private var importTask: Task<Void, Never>?
    @FocusState private var addressFocused: Bool

    private var validAddress: Bool {
        guard let url = URL(string: address.trimmingCharacters(in: .whitespacesAndNewlines)),
              ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              let host = url.host, !host.isEmpty else { return false }
        return true
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://…", text: $address)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .focused($addressFocused).disabled(importing || completed)
                        .accessibilityIdentifier("resource.import.url")
                        .onSubmit { beginImport() }
                }
                if importing { ProgressView(uncensiaText("正在获取并索引…")) }
                if let failure {
                    Section {
                        if completed { Label(uncensiaText("文件已导入"), systemImage: "checkmark.circle") }
                        Text(failure).foregroundStyle(completed ? Color.secondary : .red)
                            .accessibilityIdentifier("resource.import.error")
                    }
                }
            }
            .navigationTitle(uncensiaText("从链接导入")).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(uncensiaText("取消")) { importTask?.cancel(); dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(uncensiaText(completed ? "完成" : "导入")) {
                        if completed { dismiss() } else { beginImport() }
                    }.disabled(!completed && (!validAddress || importing))
                        .accessibilityIdentifier("resource.import.submit")
                }
            }
        }
        .task { addressFocused = true }
        .onDisappear { importTask?.cancel() }
    }

    private func beginImport() {
        guard !importing, !completed, validAddress, let api else { return }
        let url = address.trimmingCharacters(in: .whitespacesAndNewlines)
        importing = true; failure = nil; addressFocused = false
        importTask = Task {
            defer { importing = false }
            do {
                let result = try await api.request("POST", "/resources/acquire", body: .object(["url": .string(url)]))
                guard !Task.isCancelled else { return }
                await onImported(result)
                guard !Task.isCancelled else { return }
                if let indexError = result["index_error"].stringValue, !indexError.isEmpty {
                    completed = true
                    failure = uncensiaText("原件已保存，但搜索索引未完成：%@", indexError)
                } else {
                    dismiss()
                }
            } catch {
                guard !Task.isCancelled else { return }
                failure = error.localizedDescription
            }
        }
    }
}
