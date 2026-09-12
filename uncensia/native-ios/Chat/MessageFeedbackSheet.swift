import SwiftUI

struct MessageFeedbackSheet: View {
    let conversationID: String
    let messageSeq: Int
    let api: APIClient?
    @Environment(\.dismiss) private var dismiss
    @State private var feedback = ""
    @State private var saving = false
    @State private var failure: String?
    @State private var saveTask: Task<Void, Never>?
    @FocusState private var focused: Bool

    // The server and Web limit JavaScript string length (UTF-16 code units).
    private var feedbackLength: Int { feedback.utf16.count }
    private var canSave: Bool {
        !feedback.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && feedbackLength <= 4000 && !saving
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextEditor(text: $feedback).frame(minHeight: 150)
                        .focused($focused).disabled(saving)
                        .accessibilityIdentifier("message.feedback.text")
                    Text("\(feedbackLength) / 4000").font(.caption).foregroundStyle(feedbackLength > 4000 ? .red : .secondary)
                }
                if let failure {
                    Text(failure).foregroundStyle(.red).accessibilityIdentifier("message.feedback.error")
                }
                if saving { ProgressView(uncensiaText("正在保存…")) }
            }
            .navigationTitle(uncensiaText("反馈")).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(uncensiaText("取消")) { saveTask?.cancel(); dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(uncensiaText("保存")) { save() }.disabled(!canSave)
                        .accessibilityIdentifier("message.feedback.save")
                }
            }
        }
        .task { focused = true }
        .onDisappear { saveTask?.cancel() }
    }

    private func save() {
        guard canSave, let api else { return }
        let text = feedback
        saving = true; failure = nil
        saveTask = Task {
            defer { saving = false }
            do {
                _ = try await api.request("POST", "/resources/feedback", body: .object([
                    "conversationId": .string(conversationID), "seq": .integer(messageSeq), "text": .string(text),
                ]))
                guard !Task.isCancelled else { return }
                dismiss()
            } catch {
                guard !Task.isCancelled else { return }
                failure = error.localizedDescription
            }
        }
    }
}
