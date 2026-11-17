import Foundation

public enum PasteboardRestore: Equatable, Sendable {
	/// Put the saved contents back.
	case restore
	/// We had nothing to save; remove the dictated text.
	case clear
	/// Something else wrote to the clipboard meanwhile; touch nothing.
	case leave
}

public enum PasteTarget: Equatable, Sendable {
	case paste
	case clipboardOnly(Reason)

	public enum Reason: Equatable, Sendable {
		case focusChanged
		case secureInput
	}
}

public enum PasteboardPolicy {
	public static let transientType = "org.nspasteboard.TransientType"
	public static let concealedType = "org.nspasteboard.ConcealedType"

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

	/// Marker types to put on restored items so clipboard managers do not record the old
	/// contents a second time. A concealed marker the saved contents carried is kept.
	public static func restoreMarkers(savedItemTypes: [[String]]) -> [String] {
		let wasConcealed = savedItemTypes.contains { $0.contains(concealedType) }
		return wasConcealed ? [transientType, concealedType] : [transientType]
	}

	/// Whether the keystroke may go out: only if the app that had focus at release still has it
	/// and no secure text field is capturing keys.
	public static func pasteTarget(pidAtRelease: Int32?, pidNow: Int32?, secureInput: Bool) -> PasteTarget {
		if secureInput { return .clipboardOnly(.secureInput) }
		if pidAtRelease != pidNow { return .clipboardOnly(.focusChanged) }
		return .paste
	}
}
