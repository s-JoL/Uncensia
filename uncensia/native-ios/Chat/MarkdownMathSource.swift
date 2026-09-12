import Foundation

enum MarkdownMathSource {
  enum Span: Equatable {
    case text(String)
    case math(latex: String, source: String)
  }
  private static let inline = try! NSRegularExpression(pattern: #"\\\((.+?)\\\)|(?<![\\$])\$([^$\n]+)\$(?!\$)"#)
  private static let destinations = [#"<[^>\n]+>"#, #"(?:https?|file|image|video|excerpt|mailto):[^\s<>]+"#].map {
    try! NSRegularExpression(pattern: $0, options: [.caseInsensitive])
  }

  static func spans(_ text: String) -> [Span] {
    guard text.contains("$") || text.contains("\\(") else { return [.text(text)] }
    let protected = MarkdownBlock.inlineCodeRanges(text) + destinationRanges(text)
    var result: [Span] = [], cursor = text.startIndex
    for match in inline.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
      guard !protected.contains(where: { NSIntersectionRange($0, match.range).length > 0 }),
        let range = Range(match.range, in: text) else { continue }
      let group = match.range(at: 1).location == NSNotFound ? 2 : 1
      guard let bodyRange = Range(match.range(at: group), in: text) else { continue }
      let body = String(text[bodyRange])
      if group == 2, body.range(of: #"[\\^_{}=]"#, options: .regularExpression) == nil,
        body.contains(where: { $0.isWhitespace }) || body.count > 40 { continue }
      if cursor < range.lowerBound { result.append(.text(String(text[cursor..<range.lowerBound]))) }
      result.append(.math(latex: body, source: String(text[range])))
      cursor = range.upperBound
    }
    if cursor < text.endIndex { result.append(.text(String(text[cursor...]))) }
    return result.isEmpty ? [.text(text)] : result
  }

  /// A dollar sign in a destination is URL data, never an equation. Include
  /// balanced/escaped parentheses and partial destinations while streaming.
  private static func destinationRanges(_ text: String) -> [NSRange] {
    let units = Array(text.utf16)
    var ranges: [NSRange] = [], i = 0
    while i + 1 < units.count {
      guard units[i] == 93, units[i + 1] == 40 else { i += 1; continue }
      let start = i + 1
      var depth = 1, cursor = i + 2, escaped = false
      while cursor < units.count && depth > 0 {
        let unit = units[cursor]
        if escaped { escaped = false }
        else if unit == 92 { escaped = true }
        else if unit == 40 { depth += 1 }
        else if unit == 41 { depth -= 1 }
        cursor += 1
      }
      ranges.append(NSRange(location: start, length: cursor - start)); i = cursor
    }
    for regex in destinations {
      ranges += regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).map(\.range)
    }
    return ranges
  }
}
