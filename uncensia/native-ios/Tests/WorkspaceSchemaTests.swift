import XCTest
@testable import Uncensia

final class WorkspaceSchemaTests: XCTestCase {
    func testNestedRequiredAndNumericBounds() {
        let schema: JSONValue = .object([
            "type": .string("object"), "required": .array([.string("size"), .string("frames")]),
            "properties": .object([
                "size": .object(["type": .string("integer"), "minimum": .number(256), "maximum": .number(2048)]),
                "frames": .object(["type": .string("array"), "maxItems": .number(2), "items": .object(["type": .string("object"), "required": .array([.string("prompt")]), "properties": .object(["prompt": .object(["type": .string("string"), "minLength": .number(1)])])])])
            ])
        ])
        XCTAssertTrue(validateStudioValue(.object(["size": .number(1024), "frames": .array([.object(["prompt": .string("one")])])]), against: schema))
        XCTAssertFalse(validateStudioValue(.object(["size": .number(128), "frames": .array([])]), against: schema))
        XCTAssertFalse(validateStudioValue(.object(["size": .number(1024), "frames": .array([.object(["prompt": .string("")])])]), against: schema))
    }

    func testEnumsRequireExactWireType() {
        let schema: JSONValue = .object(["type": .string("number"), "enum": .array([.number(1), .number(2)])])
        XCTAssertTrue(validateStudioValue(.number(2), against: schema))
        XCTAssertFalse(validateStudioValue(.string("2"), against: schema))
    }
}
