import XCTest
@testable import DictateCore

private final class FakeSession: Cancellable {
	var cancelCount = 0
	func cancel() { cancelCount += 1 }
}

final class SessionLedgerTests: XCTestCase {
	func testDiscardingTheFirstOfTwoOverlappingStartsDoesNotCancelTheSecond() {
		let ledger = SessionLedger<FakeSession>()
		let first = ledger.begin()
		let second = ledger.begin()
		ledger.discard(first)

		let firstSession = FakeSession()
		let secondSession = FakeSession()
		XCTAssertFalse(ledger.succeed(first, firstSession))
		XCTAssertTrue(ledger.succeed(second, secondSession))

		XCTAssertEqual(firstSession.cancelCount, 1)
		XCTAssertEqual(secondSession.cancelCount, 0)
		XCTAssertTrue(ledger.take(second) === secondSession)
	}

	func testDiscardingALiveSessionCancelsOnlyThatSession() {
		let ledger = SessionLedger<FakeSession>()
		let first = ledger.begin()
		let second = ledger.begin()
		let a = FakeSession()
		let b = FakeSession()
		ledger.succeed(first, a)
		ledger.succeed(second, b)
		ledger.discard(first)
		XCTAssertEqual(a.cancelCount, 1)
		XCTAssertEqual(b.cancelCount, 0)
		XCTAssertEqual(ledger.liveCount, 1)
	}

	func testFailedStartLeavesNoLiveSession() {
		let ledger = SessionLedger<FakeSession>()
		let token = ledger.begin()
		ledger.fail(token)
		XCTAssertEqual(ledger.liveCount, 0)
		XCTAssertNil(ledger.take(token))
		// A session that still shows up for the failed start is torn down, never kept.
		let late = FakeSession()
		XCTAssertFalse(ledger.succeed(token, late))
		XCTAssertEqual(late.cancelCount, 1)
		XCTAssertEqual(ledger.liveCount, 0)
	}

	func testAStartThatFailedDoesNotBlockANewOne() {
		let ledger = SessionLedger<FakeSession>()
		ledger.fail(ledger.begin())
		let session = FakeSession()
		XCTAssertTrue(ledger.succeed(ledger.begin(), session))
		XCTAssertEqual(ledger.liveCount, 1)
		XCTAssertEqual(session.cancelCount, 0)
	}

	func testAnAbandonedSessionIsAlwaysCancelled() {
		let ledger = SessionLedger<FakeSession>()
		// Discarded before it arrives.
		let early = ledger.begin()
		ledger.discard(early)
		let arrives = FakeSession()
		ledger.succeed(early, arrives)
		XCTAssertEqual(arrives.cancelCount, 1)
		// Succeeding for a token nobody knows.
		let stray = FakeSession()
		XCTAssertFalse(ledger.succeed(999, stray))
		XCTAssertEqual(stray.cancelCount, 1)
		XCTAssertEqual(ledger.liveCount, 0)
	}

	func testTakeHandsOverOwnershipOnce() {
		let ledger = SessionLedger<FakeSession>()
		let token = ledger.begin()
		let session = FakeSession()
		ledger.succeed(token, session)
		XCTAssertTrue(ledger.take(token) === session)
		XCTAssertNil(ledger.take(token))
		ledger.discard(token)
		XCTAssertEqual(session.cancelCount, 0)
	}
}
