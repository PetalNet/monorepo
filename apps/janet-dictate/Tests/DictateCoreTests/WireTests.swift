import XCTest
@testable import DictateCore

final class WireTests: XCTestCase {
	func testRequestRoundTripEndsWithNewline() throws {
		let data = try Wire.encode(Request(verb: .stop, print: true))
		XCTAssertEqual(data.last, 0x0A)
		let line = try XCTUnwrap(Wire.firstLine(in: data))
		XCTAssertEqual(try Wire.decode(Request.self, from: line), Request(verb: .stop, print: true))
	}

	func testResponseRoundTripKeepsAwkwardText() throws {
		let response = Response.ok(text: "line one\nsays \"hi\" \u{1F600}")
		let line = try XCTUnwrap(Wire.firstLine(in: Wire.encode(response)))
		XCTAssertEqual(try Wire.decode(Response.self, from: line), response)
	}

	func testEncodedTextNeverContainsRawNewline() throws {
		let data = try Wire.encode(Response.ok(text: "a\nb"))
		XCTAssertEqual(data.filter { $0 == 0x0A }.count, 1)
	}

	func testFirstLineWaitsForNewline() {
		XCTAssertNil(Wire.firstLine(in: Data("{\"verb\":\"sta".utf8)))
		XCTAssertEqual(Wire.firstLine(in: Data("abc\ndef".utf8)), Data("abc".utf8))
	}

	func testGarbageDoesNotDecode() {
		XCTAssertThrowsError(try Wire.decode(Request.self, from: Data("nope".utf8)))
		XCTAssertThrowsError(try Wire.decode(Request.self, from: Data("{\"verb\":\"explode\",\"print\":false}".utf8)))
	}

	func testExitCodes() {
		XCTAssertEqual(ExitCode.forResponse(.ok(text: "x")), 0)
		XCTAssertEqual(ExitCode.forResponse(.empty), 4)
		XCTAssertEqual(ExitCode.forResponse(.error("boom")), 1)
		XCTAssertEqual(ExitCode.agentNotRunning, 3)
	}
}
