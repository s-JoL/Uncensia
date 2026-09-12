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
    private var scannedCount = 0
    public init() {}
    public mutating func append(_ data: Data) throws -> [ServerEvent] {
        bytes.append(data)
        var events: [ServerEvent] = []
        while let boundary = nextBoundary() {
            let frame = bytes[..<boundary.lowerBound]
            bytes.removeSubrange(..<boundary.upperBound)
            scannedCount = 0
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

    private mutating func nextBoundary() -> Range<Data.Index>? {
        // Only revisit the three bytes that could begin a split delimiter.
        // Large tool-result frames must not rescan their full JSON per chunk.
        let start = bytes.index(bytes.startIndex, offsetBy: max(0, scannedCount - 3))
        let range = start..<bytes.endIndex
        let lf = bytes.range(of: Data([0x0A, 0x0A]), in: range)
        let crlf = bytes.range(of: Data([0x0D, 0x0A, 0x0D, 0x0A]), in: range)
        scannedCount = bytes.count
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

    /// Buffer on the stream actor, before entering the UI actor. The first
    /// delta and control events arrive immediately; token bursts share a turn.
    public func followBatches(runID: String, after: Int) -> AsyncThrowingStream<[ServerEvent], Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                let batcher = RunEventBatcher(continuation: continuation)
                do {
                    for try await event in self.follow(runID: runID, after: after) {
                        try Task.checkCancellation()
                        await batcher.append(event)
                    }
                    await batcher.finish()
                } catch {
                    await batcher.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

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

actor RunEventBatcher {
    private let continuation: AsyncThrowingStream<[ServerEvent], Error>.Continuation
    private var pending: [ServerEvent] = []
    private var flushTask: Task<Void, Never>?
    private var lastDelivery: ContinuousClock.Instant?
    private var hasDeliveredDelta = false
    private var hasFinished = false
    private let interval: Duration = .milliseconds(50)

    init(continuation: AsyncThrowingStream<[ServerEvent], Error>.Continuation) {
        self.continuation = continuation
    }

    func append(_ event: ServerEvent) {
        guard !hasFinished else { return }
        pending.append(event)
        let delta = event.data["assistantMessageEvent"]["type"].stringValue ?? ""
        let coalescible = event.type == "message.delta" && ["text_delta", "thinking_delta"].contains(delta)
        let elapsed = lastDelivery.map { $0.duration(to: .now) } ?? interval
        let firstDelta = coalescible && !hasDeliveredDelta
        if coalescible { hasDeliveredDelta = true }
        if event.type == "message.end" { hasDeliveredDelta = false }
        if !coalescible || firstDelta || elapsed >= interval || pending.count >= 64 {
            flush()
        } else if flushTask == nil {
            flushTask = Task {
                do { try await Task.sleep(for: interval - elapsed) } catch { return }
                flush()
            }
        }
    }

    func finish(throwing error: Error? = nil) {
        guard !hasFinished else { return }
        hasFinished = true
        flush()
        continuation.finish(throwing: error)
    }

    private func flush() {
        flushTask?.cancel(); flushTask = nil
        guard !pending.isEmpty else { return }
        continuation.yield(pending)
        pending.removeAll(keepingCapacity: true)
        lastDelivery = .now
    }
}
