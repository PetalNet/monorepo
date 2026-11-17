import XCTest
@testable import DictateCore

final class CommandTests: XCTestCase {
	func testNoArgumentsRunsAgent() throws {
		XCTAssertEqual(try CommandParser.parse([]), .agent(key: nil))
	}

	func testLeadingKeyOptionRunsAgentWithKey() throws {
		XCTAssertEqual(try CommandParser.parse(["--key", "f18"]), .agent(key: "f18"))
		XCTAssertEqual(try CommandParser.parse(["agent", "--key=f17"]), .agent(key: "f17"))
	}

	func testStopPrintFlag() throws {
		XCTAssertEqual(try CommandParser.parse(["stop", "--print"]), .stop(print: true))
		XCTAssertEqual(try CommandParser.parse(["stop"]), .stop(print: false))
	}

	func testStartCancelStatus() throws {
		XCTAssertEqual(try CommandParser.parse(["start"]), .start)
		XCTAssertEqual(try CommandParser.parse(["cancel"]), .cancel)
		XCTAssertEqual(try CommandParser.parse(["status"]), .status)
	}

	func testTranscribeNeedsFile() throws {
		XCTAssertEqual(try CommandParser.parse(["transcribe", "a.wav"]), .transcribe(path: "a.wav"))
		XCTAssertThrowsError(try CommandParser.parse(["transcribe"])) {
			XCTAssertEqual($0 as? CommandParseError, .missingArgument("FILE.wav"))
		}
	}

	func testBenchForms() throws {
		XCTAssertEqual(
			try CommandParser.parse(["--bench", "d", "--realtime"]),
			.bench(directory: "d", realtime: true)
		)
		XCTAssertEqual(try CommandParser.parse(["bench", "d"]), .bench(directory: "d", realtime: false))
	}

	func testRejectsUnknownThings() {
		XCTAssertThrowsError(try CommandParser.parse(["dance"])) {
			XCTAssertEqual($0 as? CommandParseError, .unknownCommand("dance"))
		}
		XCTAssertThrowsError(try CommandParser.parse(["stop", "--loud"]))
		XCTAssertThrowsError(try CommandParser.parse(["start", "now"]))
		XCTAssertThrowsError(try CommandParser.parse(["--key"])) {
			XCTAssertEqual($0 as? CommandParseError, .missingValue("--key"))
		}
	}

	func testKeyPrecedenceArgumentThenDefaultsThenF19() throws {
		XCTAssertEqual(try CommandParser.resolveKey(argument: "f18", defaultsValue: "f17").keyCode, 79)
		XCTAssertEqual(try CommandParser.resolveKey(argument: nil, defaultsValue: "f17").keyCode, 64)
		XCTAssertEqual(try CommandParser.resolveKey(argument: nil, defaultsValue: nil), KeySpec(keyCode: 80, modifiers: 0))
		XCTAssertEqual(try CommandParser.resolveKey(argument: nil, defaultsValue: ""), .default)
	}

	func testKeySpecParsing() throws {
		XCTAssertEqual(try KeySpec.parse("F19"), KeySpec(keyCode: 80, modifiers: 0))
		XCTAssertEqual(
			try KeySpec.parse("ctrl+opt+Space"),
			KeySpec(keyCode: 49, modifiers: KeySpec.control | KeySpec.option)
		)
		XCTAssertEqual(try KeySpec.parse("keycode:96").keyCode, 96)
		XCTAssertThrowsError(try KeySpec.parse("hyper+f1")) {
			XCTAssertEqual($0 as? KeySpec.ParseError, .unknownModifier("hyper"))
		}
		XCTAssertThrowsError(try KeySpec.parse("f99")) {
			XCTAssertEqual($0 as? KeySpec.ParseError, .unknownKey("f99"))
		}
		XCTAssertThrowsError(try KeySpec.parse(""))
	}
}
