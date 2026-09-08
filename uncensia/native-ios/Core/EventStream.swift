import Foundation

public struct ServerEvent: Sendable, Equatable {
    public let type: String
    public let data: JSONValue
    public let sequence: Int
}

/// Incremental SSE parser. It deliberately keeps partial UTF-8 bytes and only
/// emits on a blank line, which is required when a radio transition splits a frame.
public struct SSEParser: Sendable {
    private var bytes = Data()
    public init() {}
    public mutating func append(_ data: Data) throws -> [ServerEvent] {
        bytes.append(data)
        var events: [ServerEvent] = []
        while let boundary = nextBoundary() {
            let frame = bytes[..<boundary.lowerBound]
            bytes.removeSubrange(..<boundary.upperBound)
            guard let text = String(data: frame, encoding: .utf8) else { throw URLError(.cannotDecodeContentData) }
            var kind = "message"
            var dataLines: [String] = []
            for line in text.split(whereSeparator: \.isNewline) {
                if line.hasPrefix("event:") { kind = line.dropFirst(6).trimmingCharacters(in: .whitespaces) }
                if line.hasPrefix("data:") { dataLines.append(line.dropFirst(5).trimmingCharacters(in: .whitespaces)) }
            }
            let payload = dataLines.joined(separator: "\n")
            guard !payload.isEmpty, let raw = payload.data(using: .utf8), let envelope = try? JSONDecoder().decode(JSONValue.self, from: raw) else { continue }
            events.append(ServerEvent(type: kind, data: envelope["data"], sequence: envelope["seq"].intValue ?? 0))
        }
        return events
    }

    private func nextBoundary() -> Range<Data.Index>? {
        let lf = bytes.range(of: Data([0x0A, 0x0A]))
        let crlf = bytes.range(of: Data([0x0D, 0x0A, 0x0D, 0x0A]))
        switch (lf, crlf) {
        case let (a?, b?): return a.lowerBound < b.lowerBound ? a : b
        case let (a?, nil): return a
        case let (nil, b?): return b
        default: return nil
        }
    }
}

public actor RunFollower {
    private let api: APIClient
    public init(api: APIClient) { self.api = api }

    public func follow(runID: String, after initial: Int) -> AsyncThrowingStream<ServerEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                var cursor = initial, failures = 0
                let terminal = Set(["run.completed", "run.failed", "run.cancelled"])
                while !Task.isCancelled {
                    do {
                        if failures >= 2 {
                            let result = try await api.request("GET", "/runs/\(runID)/events?after=\(cursor)&mode=poll")
                            for value in result["events"].arrayValue ?? [] {
                                guard let event = Self.event(value), event.sequence > cursor else { continue }
                                cursor = event.sequence; continuation.yield(event)
                                if terminal.contains(event.type) { continuation.finish(); return }
                            }
                            if result["done"].boolValue == true {
                                let run = try await api.request("GET", "/runs/\(runID)")
                                let status = run["status"].stringValue ?? ""
                                if status == "failed" { throw APIError(status: 0, code: "run_failed", message: run["error"].stringValue ?? uncensiaText("运行失败")) }
                                if ["completed", "cancelled"].contains(status) { continuation.finish(); return }
                                throw APIError(status: 0, code: "stream_incomplete", message: uncensiaText("运行事件流提前结束"))
                            }
                            continue
                        }
                        let request = try api.eventRequest(runID: runID, after: cursor)
                        let (bytes, _) = try await api.bytes(for: request)
                        var parser = SSEParser()
                        var chunk = Data(); chunk.reserveCapacity(4096)
                        for try await byte in bytes {
                            chunk.append(byte)
                            guard chunk.count >= 4096 || byte == 0x0A else { continue }
                            let events = try parser.append(chunk)
                            chunk.removeAll(keepingCapacity: true)
                            for event in events where event.sequence > cursor {
                                cursor = event.sequence
                                continuation.yield(event)
                                if terminal.contains(event.type) { continuation.finish(); return }
                            }
                        }
                        // A non-terminal EOF is a dropped stream. Escalate to
                        // long polling after two drops instead of reconnecting forever.
                        if !chunk.isEmpty { for event in try parser.append(chunk) where event.sequence > cursor { cursor = event.sequence; continuation.yield(event) } }
                        failures += 1
                        let run = try await api.request("GET", "/runs/\(runID)")
                        let status = run["status"].stringValue ?? ""
                        if ["completed", "failed", "cancelled"].contains(status) {
                            let result = try await api.request("GET", "/runs/\(runID)/events?after=\(cursor)&mode=poll")
                            for value in result["events"].arrayValue ?? [] {
                                guard let event = Self.event(value), event.sequence > cursor else { continue }
                                cursor = event.sequence; continuation.yield(event)
                            }
                            if status == "failed" { throw APIError(status: 0, code: "run_failed", message: run["error"].stringValue ?? uncensiaText("运行失败")) }
                            continuation.finish(); return
                        }
                    } catch is CancellationError { continuation.finish(); return }
                    catch let error as APIError where error.status == 0 || (400..<500).contains(error.status) { continuation.finish(throwing: error); return }
                    catch {
                        failures += 1
                        try? await Task.sleep(for: .milliseconds(min(4000, 300 * (1 << min(failures, 3)))))
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private static func event(_ value: JSONValue) -> ServerEvent? {
        guard let type = value["type"].stringValue else { return nil }
        return ServerEvent(type: type, data: value["data"], sequence: value["seq"].intValue ?? 0)
    }
}
