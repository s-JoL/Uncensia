import Foundation

struct MarkdownBlock: Identifiable, Sendable, Equatable {
  enum Kind: Sendable, Equatable {
    case prose(String)
    case code(String, String)
    case table([[String]])
    case image(String, String)
    case quote(String)
    case math(String, closed: Bool)
  }
  let id: Int
  let kind: Kind

  static func parse(_ text: String) -> [Self] { scan(text).blocks }

  struct Scan: Sendable {
    let blocks: [MarkdownBlock]
    let stableCount: Int
    let stableBytes: Int
  }

  private static let media = try! NSRegularExpression(pattern: #"!\[([^\]]*)\]\((?:(?:image|video)://|/(?:v1/)?(?:images|videos)/)((?:img|vid)_[A-Za-z0-9_-]+)(?:\?[^)]*)?\)|\[image image_id=(img_[A-Za-z0-9_-]+)\]|(?<!!)\[[^\]\n]*\]\(excerpt://(quote_[0-9a-f]{32})\)"#, options: [.caseInsensitive])
  private static let separator = try! NSRegularExpression(pattern: #"^:?-{3,}:?$"#)

  /// Only complete block boundaries may be retained while the last line grows.
  /// In particular, a paragraph's last line can still become a table header.
  static func scan(_ text: String, startingID: Int = 0) -> Scan {
    var result: [Self] = []
    var prose: [String] = []
    var stableCount = 0, stableBytes = 0
    let rawLines = text.components(separatedBy: "\n")
    let lines = rawLines.map { $0.hasSuffix("\r") ? String($0.dropLast()) : $0 }
    var lineStarts: [Int] = [], offset = 0
    for line in rawLines { lineStarts.append(offset); offset += line.utf8.count + 1 }
    func append(_ kind: Kind) { result.append(.init(id: startingID + result.count, kind: kind)) }
    func commit(through bytes: Int) { stableCount = result.count; stableBytes = bytes }
    func flush() {
      guard !prose.isEmpty else { return }
      let value = prose.joined(separator: "\n")
      var cursor = value.startIndex
      let protected = inlineCodeRanges(value)
      for match in media.matches(in: value, range: NSRange(value.startIndex..., in: value)) {
        guard !protected.contains(where: { NSIntersectionRange($0, match.range).length > 0 }),
          let range = Range(match.range, in: value) else { continue }
        if cursor < range.lowerBound { append(.prose(String(value[cursor..<range.lowerBound]))) }
        if let quote = Range(match.range(at: 4), in: value) {
          append(.quote(String(value[quote])))
        } else {
          let group = match.range(at: 3).location == NSNotFound ? 2 : 3
          let idRange = Range(match.range(at: group), in: value)!
          let label = Range(match.range(at: 1), in: value).map { String(value[$0]) } ?? ""
          append(.image(String(value[idRange]), label))
        }
        cursor = range.upperBound
      }
      if cursor < value.endIndex { append(.prose(String(value[cursor...]))) }
      prose.removeAll(keepingCapacity: true)
    }
    var i = 0
    while i < lines.count {
      let line = lines[i]
      if let fence = openingFence(line) {
        flush(); commit(through: lineStarts[i])
        var code: [String] = []; i += 1
        while i < lines.count && !closesFence(lines[i], fence: fence) { code.append(lines[i]); i += 1 }
        append(.code(fence.language, code.joined(separator: "\n")))
        if i < lines.count - 1 { commit(through: lineStarts[i + 1]) }
        i += 1
      } else if let opening = displayMathOpening(line) {
        flush(); commit(through: lineStarts[i])
        var chunks: [String] = [], current = opening.body, closed = false
        while true {
          if let end = current.range(of: opening.closer) {
            chunks.append(String(current[..<end.lowerBound])); closed = true
            append(.math(chunks.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines), closed: true))
            let remainder = String(current[end.upperBound...])
            if !remainder.trimmingCharacters(in: .whitespaces).isEmpty { append(.prose(remainder)) }
            if i < lines.count - 1 { commit(through: lineStarts[i + 1]) }
            i += 1; break
          }
          chunks.append(current); i += 1
          guard i < lines.count else { break }
          current = lines[i]
        }
        if !closed { append(.math(chunks.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines), closed: false)) }
      } else if i + 1 < lines.count, let header = tableHeader(line, separator: lines[i + 1]) {
        flush(); commit(through: lineStarts[i])
        var rows = [header]; i += 2
        while i < lines.count && hasTablePipe(lines[i]) && !lines[i].trimmingCharacters(in: .whitespaces).isEmpty {
          let row = tableCells(lines[i])
          rows.append(Array((row + Array(repeating: "", count: max(0, header.count - row.count))).prefix(header.count)))
          i += 1
        }
        append(.table(rows))
        if i < lines.count - 1 { commit(through: lineStarts[i]) }
      } else {
        prose.append(line)
        if line.trimmingCharacters(in: .whitespaces).isEmpty && i < lines.count - 1 {
          flush(); commit(through: lineStarts[i + 1])
        }
        i += 1
      }
    }
    flush()
    return Scan(blocks: result, stableCount: stableCount, stableBytes: stableBytes)
  }

  private struct Fence { let marker: Character; let count: Int; let language: String }
  private static func displayMathOpening(_ line: String) -> (body: String, closer: String)? {
    let value = line.trimmingCharacters(in: .whitespaces)
    if value.hasPrefix("$$") { return (String(value.dropFirst(2)), "$$") }
    if value.hasPrefix("\\[") { return (String(value.dropFirst(2)), "\\]") }
    return nil
  }
  private static func openingFence(_ line: String) -> Fence? {
    let spaces = line.prefix(while: { $0 == " " }).count
    guard spaces <= 3 else { return nil }
    let value = line.dropFirst(spaces)
    guard let first = value.first, first == "`" || first == "~" else { return nil }
    let count = value.prefix(while: { $0 == first }).count
    guard count >= 3 else { return nil }
    let language = String(value.dropFirst(count)).trimmingCharacters(in: .whitespaces)
    guard first != "`" || !language.contains("`") else { return nil }
    return Fence(marker: first, count: count, language: language)
  }
  private static func closesFence(_ line: String, fence: Fence) -> Bool {
    let spaces = line.prefix(while: { $0 == " " }).count
    guard spaces <= 3 else { return false }
    let value = line.dropFirst(spaces), count = line.dropFirst(spaces).prefix(while: { $0 == fence.marker }).count
    return count >= fence.count && value.dropFirst(count).trimmingCharacters(in: .whitespaces).isEmpty
  }

  private static func tableHeader(_ line: String, separator separatorLine: String) -> [String]? {
    guard hasTablePipe(line) else { return nil }
    let header = tableCells(line), rules = tableCells(separatorLine)
    guard !header.isEmpty, header.count == rules.count, rules.allSatisfy({
      separator.firstMatch(in: $0, range: NSRange($0.startIndex..., in: $0)) != nil
    }) else { return nil }
    return header
  }

  private static func hasTablePipe(_ value: String) -> Bool { tableParts(value).count > 1 }
  static func tableCells(_ value: String) -> [String] {
    var parts = tableParts(value.trimmingCharacters(in: .whitespaces))
    if parts.count > 1, parts.first == "" { parts.removeFirst() }
    if parts.count > 1, parts.last == "" { parts.removeLast() }
    return parts.map { $0.trimmingCharacters(in: .whitespaces) }
  }
  private static func tableParts(_ value: String) -> [String] {
    let protected = inlineCodeRanges(value)
    var result: [String] = [], cell = "", escaped = false, utf16Offset = 0
    for character in value {
      defer { utf16Offset += String(character).utf16.count }
      if escaped { cell.append(character); escaped = false; continue }
      if character == "\\" { cell.append(character); escaped = true; continue }
      if character == "|", !protected.contains(where: { NSLocationInRange(utf16Offset, $0) }) {
        result.append(cell); cell = ""
      } else { cell.append(character) }
    }
    result.append(cell)
    return result
  }

  /// Backtick spans use a matching run length; `` `image://…` `` is still code.
  static func inlineCodeRanges(_ text: String) -> [NSRange] {
    let value = Array(text.utf16)
    var ranges: [NSRange] = [], i = 0
    while i < value.count {
      guard value[i] == 96 else { i += 1; continue }
      let start = i
      while i < value.count && value[i] == 96 { i += 1 }
      let count = i - start
      var cursor = i
      while cursor < value.count {
        guard value[cursor] == 96 else { cursor += 1; continue }
        let close = cursor
        while cursor < value.count && value[cursor] == 96 { cursor += 1 }
        if cursor - close == count {
          ranges.append(NSRange(location: start, length: cursor - start)); i = cursor; break
        }
      }
    }
    return ranges
  }
}

/// Each rendered reply owns one parser. Complete paragraphs, tables and fences
/// remain immutable, so growing an answer only parses its unfinished suffix.
actor StreamingMarkdownParser {
  private var previous = ""
  private var stable: [MarkdownBlock] = []
  private var stableBytes = 0
  private(set) var lastScannedBytes = 0

  func parse(_ source: String) throws -> [MarkdownBlock] {
    try Task.checkCancellation()
    if !source.utf8.starts(with: previous.utf8) { stable = []; stableBytes = 0 }
    let tail = String(decoding: source.utf8.dropFirst(stableBytes), as: UTF8.self)
    let parsed = MarkdownBlock.scan(tail, startingID: stable.count)
    try Task.checkCancellation()
    let result = stable + parsed.blocks
    stable += parsed.blocks.prefix(parsed.stableCount)
    stableBytes += parsed.stableBytes
    previous = source
    lastScannedBytes = tail.utf8.count
    return result
  }
}

enum MarkdownStreamingTail {
  /// Prepare only the provisional prose block. A half-written URL never appears
  /// on screen, and emphasis starts in its final style before its closer arrives.
  static func prepare(_ text: String) -> String {
    let protectedEnd = MarkdownBlock.inlineCodeRanges(text).last.map(NSMaxRange) ?? 0
    let boundary = String.Index(utf16Offset: protectedEnd, in: text)
    let prefix = String(text[..<boundary])
    var tail = String(text[boundary...])
    if let opening = tail.range(of: #"`+"#, options: .regularExpression) {
      let marker = String(tail[opening])
      if opening.upperBound == tail.endIndex { tail.removeSubrange(opening) }
      else { tail += marker }
      return prefix + tail
    }
    if let opening = tail.range(of: "\\(", options: .backwards), !tail[opening.upperBound...].contains("\\)") {
      tail.removeSubrange(opening.lowerBound...)
    }
    if let partial = tail.range(of: #"!?\[([^\]\n]*)(?:\](?:\([^\)\n]*)?)?$"#, options: .regularExpression) {
      let raw = String(tail[partial])
      let label = raw.dropFirst(raw.hasPrefix("!") ? 2 : 1).prefix(while: { $0 != "]" })
      tail.replaceSubrange(partial, with: raw.hasPrefix("!") || raw.hasPrefix("[image image_id=") ? "" : String(label))
    }
    for marker in ["**", "~~"] {
      guard tail.components(separatedBy: marker).count % 2 == 0,
        let opening = tail.range(of: marker, options: .backwards) else { continue }
      if tail[opening.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { tail.removeSubrange(opening) }
      else { tail += marker }
    }
    return prefix + tail
  }
}
