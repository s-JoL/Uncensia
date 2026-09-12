import XCTest

@testable import Uncensia

final class ChatManagementTests: XCTestCase {
  func testFixtureBackedManagementMutationContracts() async throws {
    guard ProcessInfo.processInfo.environment["UNCENSIA_IOS_FIXTURE"] == "1" else {
      throw XCTSkip("Set UNCENSIA_IOS_FIXTURE=1 while the isolated fixture is running")
    }
    let environment = ProcessInfo.processInfo.environment
    let server = URL(string: environment["UNCENSIA_SERVER_URL"] ?? "http://127.0.0.1:18093")!
    let anonymous = APIClient(server: server)
    do { _ = try await anonymous.request("GET", "/health") } catch {
      throw XCTSkip("The isolated iOS fixture is not available")
    }
    let auth = try await anonymous.request(
      "POST", "/auth/token",
      body: .object([
        "accessCode": .string(environment["UNCENSIA_ACCESS_CODE"] ?? "IOS-CI-ACCEPTANCE"), "deviceName": .string("ChatManagementTests"),
      ]))
    let token = try XCTUnwrap(auth["token"].stringValue)
    let api = APIClient(server: server, token: { token })
    let bootstrap = try await api.request("GET", "/bootstrap")
    let modelID =
      bootstrap["defaults"]["defaultModelId"].stringValue ?? bootstrap["defaultModelId"].stringValue
      ?? ""
    XCTAssertFalse(modelID.isEmpty)
    var cleanup: [String] = []
    var caught: Error?
    var operation = "create conversation"
    do {
      let marker = "native-management-\(UUID().uuidString)"
      let created = try await api.request(
        "POST", "/conversations",
        body: .object(["modelId": .string(modelID), "title": .string(marker)]))
      let id = try XCTUnwrap(created["id"].stringValue)
      cleanup.append(id)
      let role = RoleplayDraft(
        .object([
          "enabled": .bool(true), "character": .string("角色"), "persona": .string("我"),
          "world": .string("世界"), "scene": .string("场景"), "style": .string("文风"),
          "examples": .string("对白"),
        ]))
      let visual = VisualDraft(
        .object([
          "enabled": .bool(true), "description": .string("视觉圣经"), "references": .array([]),
          "lastImageId": .null, "lastPrompt": .string(""),
        ]))
      operation = "save roleplay and visual context"
      _ = try await api.request(
        "PATCH", "/conversations/\(id)",
        body: .object(["roleplay": role.json, "visualContinuity": visual.json]))
      let detail = try await api.request("GET", "/conversations/\(id)")
      XCTAssertEqual(detail["roleplay"], role.json)
      XCTAssertEqual(detail["visualContinuity"], visual.json)
      operation = "create future task"
      let task = try await api.request(
        "POST", "/conversations/\(id)/background-tasks",
        body: .object([
          "prompt": .string("fixture future task"), "modelId": .string(modelID),
          "runAt": .integer(Int(Date().addingTimeInterval(120).timeIntervalSince1970 * 1000)),
        ]))
      let taskID = try XCTUnwrap(task["id"].stringValue)
      operation = "cancel future task"
      let cancelled = try await api.request("DELETE", "/background-tasks/\(taskID)")
      XCTAssertEqual(cancelled["status"].stringValue, "cancelled")
      operation = "create and settle run"
      let run = try await api.request(
        "POST", "/conversations/\(id)/runs",
        body: .object(["text": .string(marker), "attachments": .array([])]),
        headers: ["Idempotency-Key": UUID().uuidString])
      let runID = try XCTUnwrap(run["runId"].stringValue)
      for _ in 0..<100 {
        let state = try await api.request("GET", "/runs/\(runID)")["status"].stringValue
        if ["completed", "failed", "cancelled"].contains(state ?? "") { break }
        try await Task.sleep(for: .milliseconds(100))
      }
      let search = try await api.request(
        "GET", "/conversations/search?q=\(urlPart(marker))&limit=20")
      XCTAssertTrue(
        (search["items"].arrayValue ?? []).contains { $0["conversationId"].stringValue == id })
      operation = "fork conversation tree"
      let tree = try await api.request("GET", "/conversations/\(id)/tree")
      let entryID = try XCTUnwrap((tree["entries"].arrayValue ?? []).first?["id"].stringValue)
      let fork = try await api.request(
        "POST", "/conversations/\(id)/fork", body: .object(["entryId": .string(entryID)]))
      let forkID = try XCTUnwrap(fork["id"].stringValue)
      cleanup.append(forkID)
      let forkDetail = try await api.request("GET", "/conversations/\(forkID)")
      XCTAssertEqual(forkDetail["id"].stringValue, forkID)
    } catch { caught = NSError(domain: "ChatManagementContract", code: 1, userInfo: [NSLocalizedDescriptionKey: "\(operation): \(error)", NSUnderlyingErrorKey: error]) }
    for id in cleanup.reversed() { _ = try? await api.request("DELETE", "/conversations/\(id)") }
    if let caught { throw caught }
  }

  func testRoleplayRoundTripIncludesEnableAndAllSixFields() {
    let input: JSONValue = .object([
      "enabled": .bool(true), "character": .string("c"), "persona": .string("p"),
      "world": .string("w"), "scene": .string("s"), "style": .string("v"), "examples": .string("e"),
    ])
    XCTAssertEqual(RoleplayDraft(input).json, input)
  }

  func testVisualRoundTripPreservesServerManagedAndFixedReferences() {
    let input: JSONValue = .object([
      "enabled": .bool(true), "description": .string("bible"),
      "references": .array([
        .object(["imageId": .string("im-1"), "role": .string("subject"), "label": .string("hero")])
      ]), "lastImageId": .string("im-2"), "lastPrompt": .string("rain"),
    ])
    XCTAssertEqual(VisualDraft(input).json, input)
  }

  func testCharacterCardExtractsSupportedTextAndReportsUnsupportedFeatures() throws {
    let source =
      #"{"spec":"chara_card_v2","spec_version":"2.0","data":{"name":"Mira","description":"{{char}} desc","personality":"kind","scenario":"room","first_mes":"hello","mes_example":"example","creator_notes":"note","system_prompt":"special","post_history_instructions":"","alternate_greetings":[],"tags":[],"creator":"me","character_version":"1","extensions":{"x":true},"character_book":{}}}"#
    let card = try CardPreview.parse(source)
    XCTAssertEqual(card.character, "Mira\n\nMira desc\n\nkind")
    XCTAssertEqual(card.scene, "room")
    XCTAssertEqual(card.examples, "example")
    XCTAssertEqual(card.notices.count, 4)
  }

  func testCharacterCardRejectsWrongSpecAndOversizeInput() {
    XCTAssertThrowsError(try CardPreview.parse(#"{"spec":"v1"}"#))
    XCTAssertThrowsError(
      try CardPreview.parse(String(repeating: "x", count: CardPreview.limit + 1)))
  }

  func testTreeActivePathWalksParentsFromLeaf() {
    let tree: JSONValue = .object([
      "leafId": .string("c"),
      "entries": .array([
        .object(["id": .string("a"), "parentId": .null]),
        .object(["id": .string("b"), "parentId": .string("a")]),
        .object(["id": .string("c"), "parentId": .string("b")]),
        .object(["id": .string("old"), "parentId": .string("a")]),
      ]),
    ])
    XCTAssertEqual(treeActiveIDs(tree), Set(["a", "b", "c"]))
  }

  func testChineseStatusAndURLHelpers() {
    XCTAssertEqual(taskStatus("pending"), uncensiaText("等待中"))
    XCTAssertEqual(roleLabel("user"), uncensiaText("你"))
    XCTAssertEqual(urlPart("a&b"), "a%26b")
  }
}
