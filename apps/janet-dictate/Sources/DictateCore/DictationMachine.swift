import Foundation

/// The press/release state machine. Pure: events in, one action out.
public struct DictationMachine: Equatable, Sendable {
	/// A press shorter than this is a bump, not dictation.
	public static let minimumHold: TimeInterval = 0.15

	public enum Source: Equatable, Sendable { case hotkey, socket }

	public enum State: Equatable, Sendable {
		case idle
		case recording(Source, since: TimeInterval)
		case finishing
		/// A socket recording hit its limit; the transcript waits for `stop`.
		case holding
	}

	public enum Event: Equatable, Sendable {
		case keyDown(at: TimeInterval)
		case keyUp(at: TimeInterval)
		case socketStart
		case socketStop(print: Bool)
		case socketCancel
		/// The recording hit its length cap, or the input device changed.
		case forcedEnd
		/// A held transcript was never collected.
		case holdExpired
		/// The transcript is in and delivered (or failed); the agent is free again.
		case finished
	}

	public enum Action: Equatable, Sendable {
		case none
		case startRecording
		case stopAndPaste
		case stopAndReturnText
		/// Finish now and keep the transcript for a later `stop`.
		case stopAndHold
		case deliverHeld(paste: Bool)
		case discard
		case rejectBusy
		case rejectNotRecording
	}

	public private(set) var state: State = .idle

	public init() {}

	public mutating func handle(_ event: Event) -> Action {
		switch (state, event) {
		case (.idle, .keyDown(let time)):
			state = .recording(.hotkey, since: time)
			return .startRecording
		case (.idle, .socketStart):
			state = .recording(.socket, since: 0)
			return .startRecording
		case (.recording(.hotkey, let since), .keyUp(let time)):
			if time - since < Self.minimumHold {
				state = .idle
				return .discard
			}
			state = .finishing
			return .stopAndPaste
		case (.recording(.hotkey, _), .forcedEnd):
			state = .finishing
			return .stopAndPaste
		case (.recording(.socket, _), .forcedEnd):
			state = .holding
			return .stopAndHold
		case (.holding, .socketStop(let printText)):
			state = .finishing
			return .deliverHeld(paste: !printText)
		case (.holding, .socketCancel), (.holding, .holdExpired):
			state = .idle
			return .discard
		case (.holding, .socketStart):
			return .rejectBusy
		case (.recording, .socketStop(let printText)):
			state = .finishing
			return printText ? .stopAndReturnText : .stopAndPaste
		case (.recording, .socketCancel):
			state = .idle
			return .discard
		case (.recording, .socketStart), (.finishing, .socketStart):
			return .rejectBusy
		case (.idle, .socketStop), (.finishing, .socketStop):
			return .rejectNotRecording
		case (.finishing, .finished):
			state = .idle
			return .none
		default:
			return .none
		}
	}
}
