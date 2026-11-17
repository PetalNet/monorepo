import XCTest
@testable import DictateCore

final class CommandTests: XCTestCase {
	func testNoArgumentsRunsAgent() throws {
		XCTAssertEqual(try CommandParser.parse([]), .agent(AgentOptions()))
	}

	func testLeadingKeyOptionRunsAgentWithKey() throws {
		XCTAssertEqual(try CommandParser.parse(["--key", "f18"]), .agent(AgentOptions(key: "f18")))
		XCTAssertEqual(try CommandParser.parse(["agent", "--key=f17"]), .agent(AgentOptions(key: "f17")))
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
			.bench(directory: "d", realtime: true, retention: nil)
		)
		XCTAssertEqual(
			try CommandParser.parse(["bench", "d", "--retention", "lingering"]),
			.bench(directory: "d", realtime: false, retention: .lingering)
		)
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

	func testControlSocketIsOffUnlessAskedFor() throws {
		XCTAssertFalse(try agentOptions([]).controlSocket)
		XCTAssertTrue(try agentOptions(["--control-socket"]).controlSocket)
		XCTAssertFalse(CommandParser.resolveControlSocket(flag: false, defaultsValue: nil))
		XCTAssertFalse(CommandParser.resolveControlSocket(flag: false, defaultsValue: false))
		XCTAssertTrue(CommandParser.resolveControlSocket(flag: false, defaultsValue: true))
		XCTAssertTrue(CommandParser.resolveControlSocket(flag: true, defaultsValue: false))
	}

	func testMaxSecondsOptionAndDefaults() throws {
		XCTAssertEqual(try agentOptions(["--max-seconds", "30"]).maxSeconds, 30)
		XCTAssertThrowsError(try CommandParser.parse(["--max-seconds", "0"]))
		XCTAssertThrowsError(try CommandParser.parse(["--max-seconds", "soon"]))
		XCTAssertThrowsError(try CommandParser.parse(["--max-seconds"]))
		XCTAssertEqual(CommandParser.resolveMaxSeconds(argument: nil, defaultsValue: nil), 120)
		XCTAssertEqual(CommandParser.resolveMaxSeconds(argument: nil, defaultsValue: 45), 45)
		XCTAssertEqual(CommandParser.resolveMaxSeconds(argument: nil, defaultsValue: 1), 120)
		XCTAssertEqual(CommandParser.resolveMaxSeconds(argument: 20, defaultsValue: 45), 20)
	}

	func testRetentionOption() throws {
		XCTAssertEqual(try agentOptions(["--retention", "lingering"]).retention, .lingering)
		XCTAssertThrowsError(try CommandParser.parse(["--retention", "forever"])) {
			XCTAssertEqual($0 as? CommandParseError, .invalidValue(option: "--retention", value: "forever"))
		}
		XCTAssertEqual(CommandParser.resolveRetention(argument: nil, defaultsValue: nil), .whileInUse)
		XCTAssertEqual(CommandParser.resolveRetention(argument: nil, defaultsValue: "lingering"), .lingering)
		XCTAssertEqual(CommandParser.resolveRetention(argument: .whileInUse, defaultsValue: "lingering"), .whileInUse)
	}

	private func agentOptions(_ args: [String]) throws -> AgentOptions {
		guard case .agent(let options) = try CommandParser.parse(args) else {
			XCTFail("not an agent command")
			return AgentOptions()
		}
		return options
	}
}
