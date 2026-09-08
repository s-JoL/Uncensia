import XCTest

@testable import Uncensia

final class SettingsProtocolTests: XCTestCase {
  override func setUp() {
    super.setUp()
    SettingsURLProtocol.handler = nil
  }

  func testStepUpHeadersAndBodyReachSecurityRoute() async throws {
    let client = makeClient { request in
      XCTAssertEqual(request.url?.path, "/v1/security/access-code")
      XCTAssertEqual(request.value(forHTTPHeaderField: "x-uncensia-access-code"), "current-code")
      XCTAssertEqual(request.value(forHTTPHeaderField: "x-uncensia-totp"), "123456")
      let body = try JSONDecoder().decode(JSONValue.self, from: try requestBody(request))
      XCTAssertEqual(body["value"].stringValue, "replacement-code")
      return (200, .object(["totpEnabled": .bool(true)]))
    }
    let result = try await client.request(
      "PUT", "/security/access-code", body: .object(["value": .string("replacement-code")]),
      headers: ["x-uncensia-access-code": "current-code", "x-uncensia-totp": "123456"])
    XCTAssertEqual(result["totpEnabled"].boolValue, true)
  }

  func testSkillRevisionConflictPreservesServerError() async throws {
    let client = makeClient { request in
      XCTAssertEqual(request.url?.path, "/v1/skills/local")
      let body = try JSONDecoder().decode(JSONValue.self, from: try requestBody(request))
      XCTAssertEqual(body["revision"].stringValue, "old-revision")
      return (
        409,
        .object([
          "error": .object([
            "code": .string("conflict"), "message": .string("Skill changed on disk"),
          ])
        ])
      )
    }
    do {
      _ = try await client.request(
        "PATCH", "/skills/local",
        body: .object(["content": .string("updated"), "revision": .string("old-revision")]))
      XCTFail("Expected conflict")
    } catch let error as APIError {
      XCTAssertEqual(error.status, 409)
      XCTAssertEqual(error.code, "conflict")
    }
  }

  func testModelValidationErrorAndDefaultRoute() async throws {
    var call = 0
    let client = makeClient { request in
      call += 1
      if call == 1 {
        XCTAssertEqual(request.url?.path, "/v1/models")
        return (
          400,
          .object([
            "error": .object([
              "code": .string("invalid_request"),
              "message": .string("contextWindow must be an integer >= 1024"),
            ])
          ])
        )
      }
      XCTAssertEqual(request.url?.path, "/v1/models/default")
      let body = try JSONDecoder().decode(JSONValue.self, from: try requestBody(request))
      XCTAssertEqual(body["modelId"].stringValue, "chat-one")
      return (200, .object(["defaultModelId": .string("chat-one")]))
    }
    do {
      _ = try await client.request("POST", "/models", body: .object(["contextWindow": .number(12)]))
      XCTFail("Expected validation error")
    } catch let error as APIError { XCTAssertEqual(error.status, 400) }
    let result = try await client.request(
      "PUT", "/models/default", body: .object(["modelId": .string("chat-one")]))
    XCTAssertEqual(result["defaultModelId"].stringValue, "chat-one")
  }

  func testInvalidNonEmptyModelJSONNeverBecomesDestructiveNull() throws {
    XCTAssertThrowsError(try parseOptionalJSONObject("{broken", field: "生成参数 JSON"))
    XCTAssertThrowsError(try parseOptionalJSONObject("[]", field: "兼容参数 JSON"))
    XCTAssertEqual(try parseOptionalJSONObject("   ", field: "生成参数 JSON"), .null)
    XCTAssertEqual(
      try parseOptionalJSONObject(#"{"preserve":true}"#, field: "兼容参数 JSON"),
      .object(["preserve": .bool(true)]))
  }

  func testInvalidNumericTextIsRejectedRatherThanDefaulted() throws {
    XCTAssertThrowsError(try optionalNumber("twelve", field: "温度"))
    XCTAssertThrowsError(try optionalNumber("nan", field: "价格"))
    XCTAssertNil(try optionalNumber("", field: "温度"))
    XCTAssertEqual(try optionalNumber("0.7", field: "温度"), 0.7)
  }

  private func makeClient(_ handler: @escaping (URLRequest) throws -> (Int, JSONValue)) -> APIClient
  {
    SettingsURLProtocol.handler = handler
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [SettingsURLProtocol.self]
    return APIClient(
      server: URL(string: "https://uncensia.test")!, session: URLSession(configuration: configuration))
  }
}

private func requestBody(_ request: URLRequest) throws -> Data {
  if let body = request.httpBody { return body }
  guard let stream = request.httpBodyStream else { return Data() }
  stream.open()
  defer { stream.close() }
  var result = Data()
  var buffer = [UInt8](repeating: 0, count: 4096)
  while stream.hasBytesAvailable {
    let count = stream.read(&buffer, maxLength: buffer.count)
    if count < 0 { throw stream.streamError ?? URLError(.cannotDecodeContentData) }
    if count == 0 { break }
    result.append(buffer, count: count)
  }
  return result
}

private final class SettingsURLProtocol: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var handler: ((URLRequest) throws -> (Int, JSONValue))?
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    do {
      let (status, body) = try XCTUnwrap(Self.handler)(request)
      let response = HTTPURLResponse(
        url: request.url!, statusCode: status, httpVersion: nil,
        headerFields: ["Content-Type": "application/json"])!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: try JSONEncoder().encode(body))
      client?.urlProtocolDidFinishLoading(self)
    } catch { client?.urlProtocol(self, didFailWithError: error) }
  }
  override func stopLoading() {}
}
