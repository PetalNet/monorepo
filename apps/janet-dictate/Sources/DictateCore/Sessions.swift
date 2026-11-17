import Foundation

public protocol Cancellable: AnyObject {
	func cancel()
}

/// Per-recording bookkeeping. Every start gets its own token and its own slot, so discarding
/// or failing one start can never touch another recording's session, and a session that
/// nobody will finish is always cancelled.
public final class SessionLedger<Session: Cancellable> {
	private enum Slot {
		case starting
		case live(Session)
		case discarded
	}

	private var slots: [Int: Slot] = [:]
	private var nextToken = 0

	public init() {}

	public func begin() -> Int {
		nextToken += 1
		slots[nextToken] = .starting
		return nextToken
	}

	/// The start finished. Returns false, and cancels `session`, if the start was discarded meanwhile.
	@discardableResult
	public func succeed(_ token: Int, _ session: Session) -> Bool {
		guard case .starting = slots[token] else {
			slots[token] = nil
			session.cancel()
			return false
		}
		slots[token] = .live(session)
		return true
	}

	/// The start failed; nothing is left behind.
	public func fail(_ token: Int) {
		slots[token] = nil
	}

	/// Abandons one recording: a live session is cancelled, a start still in flight is marked
	/// so its session is cancelled when it arrives.
	public func discard(_ token: Int) {
		switch slots[token] {
		case .live(let session):
			slots[token] = nil
			session.cancel()
		case .starting:
			slots[token] = .discarded
		case .discarded, nil:
			break
		}
	}

	/// Hands the live session to the caller, who must finish or cancel it.
	public func take(_ token: Int) -> Session? {
		guard case .live(let session) = slots[token] else { return nil }
		slots[token] = nil
		return session
	}

	public var liveCount: Int {
		slots.values.reduce(0) { count, slot in
			if case .live = slot { return count + 1 }
			return count
		}
	}
}
