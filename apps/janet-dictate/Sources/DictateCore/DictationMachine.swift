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
	}

	public enum Event: Equatable, Sendable {
		case keyDown(at: TimeInterval)
		case keyUp(at: TimeInterval)
		case socketStart
		case socketStop(print: Bool)
		case socketCancel
		/// The transcript is in and delivered (or failed); the agent is free again.
		case finished
	}

	public enum Action: Equatable, Sendable {
		case none
		case startRecording
		case stopAndPaste
		case stopAndReturnText
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
