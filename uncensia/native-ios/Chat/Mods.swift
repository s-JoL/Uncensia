import SwiftUI

/// The enabled mods' contributions, read from the same `/mods` the web client
/// uses. A mod is a declaration: every value here is text placed in a slot.
struct ModContributions: Equatable {
    struct Prompt: Hashable { let label: String; let prompt: String }
    struct Panel: Hashable { let title: String; let notes: [String] }
    var starters: [Prompt] = []
    var actions: [Prompt] = []
    var panels: [Panel] = []

    /// Shipped mods are translated like the interface; others show as written.
    init(_ mods: [JSONValue] = []) {
        for mod in mods where mod["enabled"].boolValue != false {
            let c = mod["contributes"]
            starters += (c["starters"].arrayValue ?? []).compactMap(Self.prompt)
            actions += (c["messageActions"].arrayValue ?? []).compactMap(Self.prompt)
            panels += (c["panels"].arrayValue ?? []).compactMap { value in
                guard let title = value["title"].stringValue else { return nil }
                return Panel(title: uncensiaText(title), notes: (value["notes"].arrayValue ?? []).compactMap(\.stringValue))
            }
        }
    }
    private static func prompt(_ value: JSONValue) -> Prompt? {
        guard let label = value["label"].stringValue, let prompt = value["prompt"].stringValue else { return nil }
        return Prompt(label: uncensiaText(label), prompt: uncensiaText(prompt))
    }

    static func load(api: APIClient?) async -> ModContributions {
        guard let api, let response = try? await api.request("GET", "/mods") else { return ModContributions() }
        return ModContributions(response["items"].arrayValue ?? [])
    }

    /// Panels with at least one note the assistant has written, paired with those notes.
    func filledPanels(notes: [JSONValue]) -> [(Panel, [JSONValue])] {
        panels.compactMap { panel in
            let entries = panel.notes.compactMap { key in
                notes.first { $0["key"].stringValue == key && !($0["value"].stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            }
            return entries.isEmpty ? nil : (panel, entries)
        }
    }
}

/// A reply's opening as plain text, for prompts that quote the passage they act on.
func excerpt(of message: ChatMessage) -> String {
    let plain = message.text.replacingOccurrences(of: #"[#*_`>~|]+"#, with: " ", options: .regularExpression)
        .split(whereSeparator: \.isWhitespace).joined(separator: " ")
    return plain.count > 120 ? String(plain.prefix(120)) + "…" : plain
}

/// Conversation notes a mod asked to show, as the assistant keeps them.
struct NotePanelsSheet: View {
    let panels: [(ModContributions.Panel, [JSONValue])]
    @Environment(\.dismiss) private var dismiss
    private static let names = ["outline": "大纲", "continuity": "连续性", "style": "写作风格", "scene": "场景", "relationship": "关系", "today": "今天"]

    var body: some View {
        NavigationStack {
            List {
                ForEach(panels, id: \.0.title) { panel, entries in
                    Section(panel.title) {
                        ForEach(entries, id: \.self) { note in
                            let key = note["key"].stringValue ?? ""
                            let label = note["label"].stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? Self.names[key].map { uncensiaText($0) } ?? key
                            VStack(alignment: .leading, spacing: 6) {
                                Text(label).font(.caption.weight(.semibold)).foregroundStyle(.tint)
                                Text(note["value"].stringValue ?? "").font(.callout).textSelection(.enabled)
                            }.padding(.vertical, 4)
                        }
                    }
                }
            }
            .navigationTitle(uncensiaText("侧边面板"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(uncensiaText("完成")) { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }
}
