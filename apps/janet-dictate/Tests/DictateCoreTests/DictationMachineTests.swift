import XCTest
@testable import DictateCore

final class DictationMachineTests: XCTestCase {
	func testHoldAndReleasePastes() {
		var machine = DictationMachine()
		XCTAssertEqual(machine.handle(.keyDown(at: 10)), .startRecording)
		XCTAssertEqual(machine.handle(.keyUp(at: 11)), .stopAndPaste)
		XCTAssertEqual(machine.state, .finishing)
		XCTAssertEqual(machine.handle(.finished), .none)
		XCTAssertEqual(machine.state, .idle)
	}

	func testBumpShorterThanMinimumHoldIsDiscarded() {
		var machine = DictationMachine()
		_ = machine.handle(.keyDown(at: 10))
		XCTAssertEqual(machine.handle(.keyUp(at: 10.05)), .discard)
		XCTAssertEqual(machine.state, .idle)
	}

	func testKeyRepeatWhileRecordingIsIgnored() {
		var machine = DictationMachine()
		_ = machine.handle(.keyDown(at: 1))
		XCTAssertEqual(machine.handle(.keyDown(at: 1.1)), .none)
		XCTAssertEqual(machine.handle(.keyUp(at: 2)), .stopAndPaste)
	}

	func testPressWhileFinishingIsIgnoredAndDoesNotRestart() {
		var machine = DictationMachine()
		_ = machine.handle(.keyDown(at: 1))
		_ = machine.handle(.keyUp(at: 2))
		XCTAssertEqual(machine.handle(.keyDown(at: 2.1)), .none)
		XCTAssertEqual(machine.state, .finishing)
		XCTAssertEqual(machine.handle(.keyUp(at: 2.5)), .none)
	}

	func testSocketStartStopPrint() {
		var machine = DictationMachine()
		XCTAssertEqual(machine.handle(.socketStart), .startRecording)
		XCTAssertEqual(machine.handle(.socketStop(print: true)), .stopAndReturnText)
		_ = machine.handle(.finished)
		XCTAssertEqual(machine.state, .idle)
	}

	func testSocketStopWithoutPrintPastes() {
		var machine = DictationMachine()
		_ = machine.handle(.socketStart)
		XCTAssertEqual(machine.handle(.socketStop(print: false)), .stopAndPaste)
	}

	func testHotkeyReleaseDoesNotEndSocketRecording() {
		var machine = DictationMachine()
		_ = machine.handle(.socketStart)
		XCTAssertEqual(machine.handle(.keyDown(at: 1)), .none)
		XCTAssertEqual(machine.handle(.keyUp(at: 5)), .none)
		XCTAssertEqual(machine.state, .recording(.socket, since: 0))
	}

	func testSecondStartIsBusy() {
		var machine = DictationMachine()
		_ = machine.handle(.socketStart)
		XCTAssertEqual(machine.handle(.socketStart), .rejectBusy)
		_ = machine.handle(.socketStop(print: true))
		XCTAssertEqual(machine.handle(.socketStart), .rejectBusy)
	}

	func testStopWhenIdleIsRejected() {
		var machine = DictationMachine()
		XCTAssertEqual(machine.handle(.socketStop(print: true)), .rejectNotRecording)
	}

	func testCancelDiscardsAndFrees() {
		var machine = DictationMachine()
		_ = machine.handle(.keyDown(at: 1))
		XCTAssertEqual(machine.handle(.socketCancel), .discard)
		XCTAssertEqual(machine.state, .idle)
		XCTAssertEqual(machine.handle(.socketCancel), .none)
		XCTAssertEqual(machine.handle(.keyDown(at: 3)), .startRecording)
	}
}
