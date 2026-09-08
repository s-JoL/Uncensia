import Foundation

public struct APIError: Error, LocalizedError, Sendable {
    public let status: Int
    public let code: String
    public let message: String
    public var errorDescription: String? { message }
}

public final class APIClient: Sendable {
    public let server: URL
    private let session: URLSession
    private let token: @Sendable () -> String?
    private let tokenUpdated: (@Sendable (String) throws -> Void)?

    public init(server: URL, session: URLSession = .shared, token: @escaping @Sendable () -> String? = { nil }, tokenUpdated: (@Sendable (String) throws -> Void)? = nil) {
        self.server = server
        self.session = session
        self.token = token
        self.tokenUpdated = tokenUpdated
    }

    public func request(_ method: String, _ path: String, body: JSONValue? = nil) async throws -> JSONValue {
        try await request(method, path, body: body, headers: [:])
    }

    public func request(_ method: String, _ path: String, body: JSONValue? = nil, headers: [String: String]) async throws -> JSONValue {
        var request = try urlRequest(method, path)
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: request)
        try adoptAndValidate(response, data: data)
        guard !data.isEmpty else { return .null }
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }

    public func upload(data: Data, filename: String, mimeType: String) async throws -> JSONValue {
        let boundary = "Uncensia-\(UUID().uuidString)"
        var request = try urlRequest("POST", "/files")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        var body = Data()
        body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(filename.replacingOccurrences(of: "\"", with: ""))\"\r\nContent-Type: \(mimeType)\r\n\r\n".data(using: .utf8)!)
        body.append(data)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        request.httpBody = body
        let (responseData, response) = try await session.data(for: request)
        try adoptAndValidate(response, data: responseData)
        return try JSONDecoder().decode(JSONValue.self, from: responseData)
    }

    public func download(_ path: String) async throws -> Data {
        let request = try urlRequest("GET", path)
        let (data, response) = try await session.data(for: request)
        try adoptAndValidate(response, data: data)
        return data
    }

    public func eventRequest(runID: String, after: Int, poll: Bool = false) throws -> URLRequest {
        try urlRequest("GET", "/runs/\(runID)/events?after=\(after)\(poll ? "&mode=poll" : "")")
    }

    public func data(for request: URLRequest) async throws -> (Data, URLResponse) { try await session.data(for: request) }

    public func bytes(for request: URLRequest) async throws -> (URLSession.AsyncBytes, URLResponse) {
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw URLError(.badServerResponse) }
        if let rotated = http.value(forHTTPHeaderField: "x-uncensia-token"), !rotated.isEmpty { try tokenUpdated?(rotated) }
        return (bytes, response)
    }

    func urlRequest(_ method: String, _ path: String) throws -> URLRequest {
        guard var components = URLComponents(url: server, resolvingAgainstBaseURL: false) else { throw URLError(.badURL) }
        var base = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if base == "v1" || base.hasSuffix("/v1") { base.removeLast(2); base = base.trimmingCharacters(in: CharacterSet(charactersIn: "/")) }
        let pieces = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        var routePath = String(pieces[0])
        if !routePath.hasPrefix("/") { routePath = "/" + routePath }
        if routePath == "/v1" { routePath = "" }
        else if routePath.hasPrefix("/v1/") { routePath.removeFirst(3) }
        components.path = (base.isEmpty ? "" : "/\(base)") + "/v1" + routePath
        components.percentEncodedQuery = pieces.count == 2 ? String(pieces[1]) : nil
        guard let url = components.url else { throw URLError(.badURL) }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 35
        if let token = token(), !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            if tokenUpdated != nil { request.setValue("1", forHTTPHeaderField: "x-uncensia-token-rotation") }
        }
        return request
    }

    private func adoptAndValidate(_ response: URLResponse, data: Data) throws {
        guard let response = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        if let rotated = response.value(forHTTPHeaderField: "x-uncensia-token"), !rotated.isEmpty { try tokenUpdated?(rotated) }
        guard (200..<300).contains(response.statusCode) else {
            let json = try? JSONDecoder().decode(JSONValue.self, from: data)
            throw APIError(status: response.statusCode, code: json?["error"]["code"].stringValue ?? "error", message: json?["error"]["message"].stringValue ?? "Request failed (\(response.statusCode))")
        }
    }
}
