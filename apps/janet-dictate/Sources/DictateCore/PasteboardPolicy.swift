import Foundation

public enum PasteboardRestore: Equatable, Sendable {
	/// Put the saved contents back.
	case restore
	/// We had nothing to save; remove the dictated text.
	case clear
	/// Something else wrote to the clipboard meanwhile; touch nothing.
	case leave
}

public enum PasteboardPolicy {
	/// Decide what to do with the clipboard after the paste keystroke has been delivered.
	/// `ownChangeCount` is the count right after we wrote the text.
	public static func restoreDecision(
		ownChangeCount: Int,
		currentChangeCount: Int,
		hadPreviousContents: Bool
	) -> PasteboardRestore {
		guard ownChangeCount == currentChangeCount else { return .leave }
		return hadPreviousContents ? .restore : .clear
	}
}
