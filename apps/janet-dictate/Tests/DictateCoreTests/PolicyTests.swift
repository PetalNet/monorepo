import XCTest
@testable import DictateCore

final class PasteboardPolicyTests: XCTestCase {
	func testRestoresWhenNobodyTouchedTheClipboard() {
		XCTAssertEqual(
			PasteboardPolicy.restoreDecision(ownChangeCount: 7, currentChangeCount: 7, hadPreviousContents: true),
			.restore
		)
	}

	func testLeavesClipboardAloneWhenUserCopiedMeanwhile() {
		XCTAssertEqual(
			PasteboardPolicy.restoreDecision(ownChangeCount: 7, currentChangeCount: 8, hadPreviousContents: true),
			.leave
		)
		XCTAssertEqual(
			PasteboardPolicy.restoreDecision(ownChangeCount: 7, currentChangeCount: 8, hadPreviousContents: false),
			.leave
		)
	}

	func testClearsDictatedTextWhenThereWasNothingToRestore() {
		XCTAssertEqual(
			PasteboardPolicy.restoreDecision(ownChangeCount: 3, currentChangeCount: 3, hadPreviousContents: false),
			.clear
		)
	}
}

final class PasteGateTests: XCTestCase {
	func testSameAppAndNoSecureInputPastes() {
		XCTAssertEqual(PasteboardPolicy.pasteTarget(pidAtRelease: 42, pidNow: 42, secureInput: false), .paste)
	}

	func testChangedFocusLeavesTheTextOnTheClipboard() {
		XCTAssertEqual(
			PasteboardPolicy.pasteTarget(pidAtRelease: 42, pidNow: 77, secureInput: false),
			.clipboardOnly(.focusChanged)
		)
		XCTAssertEqual(
			PasteboardPolicy.pasteTarget(pidAtRelease: 42, pidNow: nil, secureInput: false),
			.clipboardOnly(.focusChanged)
		)
	}

	func testSecureInputBlocksThePaste() {
		XCTAssertEqual(
			PasteboardPolicy.pasteTarget(pidAtRelease: 42, pidNow: 42, secureInput: true),
			.clipboardOnly(.secureInput)
		)
	}
}

final class RestoreMarkerTests: XCTestCase {
	func testRestoredItemsAreMarkedTransient() {
		XCTAssertEqual(
			PasteboardPolicy.restoreMarkers(savedItemTypes: [["public.utf8-plain-text"]]),
			[PasteboardPolicy.transientType]
		)
	}

	func testConcealedMarkerSurvivesRestore() {
		XCTAssertEqual(
			PasteboardPolicy.restoreMarkers(savedItemTypes: [["public.utf8-plain-text"], [PasteboardPolicy.concealedType]]),
			[PasteboardPolicy.transientType, PasteboardPolicy.concealedType]
		)
	}
}

final class TextCleanupTests: XCTestCase {
	func testCollapsesWhitespaceAndTrims() {
		XCTAssertEqual(TextCleanup.clean("  hello \n\t world  "), "hello world")
	}

	func testStripsControlCharacters() {
		XCTAssertEqual(TextCleanup.clean("hel\u{7}lo"), "hel lo")
	}

	func testNothingSpeakableIsNil() {
		XCTAssertNil(TextCleanup.clean(""))
		XCTAssertNil(TextCleanup.clean("  \n "))
		XCTAssertNil(TextCleanup.clean(" . ... "))
	}

	func testKeepsPunctuationAndDigits() {
		XCTAssertEqual(TextCleanup.clean("Set a timer for 25 minutes."), "Set a timer for 25 minutes.")
	}
}

final class WordErrorRateTests: XCTestCase {
	func testNormalizerMatchesBenchmark() {
		XCTAssertEqual(WordErrorRate.normalize("Let's order two pizzas."), ["lets", "order", "2", "pizzas"])
		XCTAssertEqual(WordErrorRate.normalize("twenty five minutes"), ["25", "minutes"])
		XCTAssertEqual(WordErrorRate.normalize("six forty five"), ["645"])
		XCTAssertEqual(WordErrorRate.normalize("6:45 PM"), ["645", "pm"])
		XCTAssertEqual(WordErrorRate.normalize("St. Louis"), ["saint", "louis"])
		XCTAssertEqual(WordErrorRate.normalize("well-known"), ["well", "known"])
	}

	func testEditDistance() {
		XCTAssertEqual(WordErrorRate.editDistance(["a", "b", "c"], ["a", "c"]), 1)
		XCTAssertEqual(WordErrorRate.editDistance(["a", "b"], ["x", "y", "z"]), 3)
		XCTAssertEqual(WordErrorRate.editDistance([], ["a"]), 1)
	}

	func testScore() {
		let result = WordErrorRate.score(reference: "Turn off the lights.", heard: "turn of the light")
		XCTAssertEqual(result.errors, 2)
		XCTAssertEqual(result.words, 4)
	}
}
