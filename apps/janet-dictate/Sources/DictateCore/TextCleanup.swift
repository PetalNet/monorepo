import Foundation

public enum TextCleanup {
	/// Tidies a raw transcript. Returns nil when nothing speakable is left.
	public static func clean(_ raw: String) -> String? {
		let withoutControls = String(
			raw.unicodeScalars.map { scalar -> Character in
				CharacterSet.controlCharacters.contains(scalar) && !CharacterSet.newlines.contains(scalar)
					? " " : Character(scalar)
			}
		)
		let collapsed = withoutControls
			.split(whereSeparator: { $0.isWhitespace || $0.isNewline })
			.joined(separator: " ")
		guard collapsed.contains(where: { $0.isLetter || $0.isNumber }) else { return nil }
		return collapsed
	}
}
