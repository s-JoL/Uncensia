import Foundation

/// Application labels only. Conversation text and provider responses are never translated.
func uncensiaText(_ key: String, _ values: String...) -> String {
    let template = NSLocalizedString(key, comment: "Uncensia interface")
    guard !values.isEmpty else { return template }
    return String(format: template, arguments: values)
}
