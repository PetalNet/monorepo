import Foundation

/// A global hotkey: a virtual key code plus Carbon modifier flags.
public struct KeySpec: Equatable, Sendable {
	public static let cmd: UInt32 = 0x100
	public static let shift: UInt32 = 0x200
	public static let option: UInt32 = 0x800
	public static let control: UInt32 = 0x1000

	public static let `default` = KeySpec(keyCode: 80, modifiers: 0)

	public let keyCode: UInt32
	public let modifiers: UInt32

	public init(keyCode: UInt32, modifiers: UInt32) {
		self.keyCode = keyCode
		self.modifiers = modifiers
	}

	public enum ParseError: Error, Equatable {
		case empty
		case unknownKey(String)
		case unknownModifier(String)
	}

	static let keyCodes: [String: UInt32] = [
		"f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98,
		"f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111, "f13": 105,
		"f14": 107, "f15": 113, "f16": 106, "f17": 64, "f18": 79, "f19": 80,
		"f20": 90,
		"space": 49, "return": 36, "tab": 48, "escape": 53, "grave": 50,
		"a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8,
		"v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
		"o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45,
		"m": 46,
	]

	static let modifierFlags: [String: UInt32] = [
		"cmd": cmd, "command": cmd, "shift": shift, "opt": option,
		"option": option, "alt": option, "ctrl": control, "control": control,
	]

	/// Parses `f19`, `ctrl+opt+space`, or `keycode:80`. Case-insensitive.
	public static func parse(_ text: String) throws -> KeySpec {
		let parts = text.lowercased()
			.split(separator: "+", omittingEmptySubsequences: false)
			.map { $0.trimmingCharacters(in: .whitespaces) }
		guard let last = parts.last, !last.isEmpty else { throw ParseError.empty }
		var modifiers: UInt32 = 0
		for part in parts.dropLast() {
			guard let flag = modifierFlags[part] else {
				throw ParseError.unknownModifier(part)
			}
			modifiers |= flag
		}
		if last.hasPrefix("keycode:"), let code = UInt32(last.dropFirst(8)) {
			return KeySpec(keyCode: code, modifiers: modifiers)
		}
		guard let code = keyCodes[last] else { throw ParseError.unknownKey(last) }
		return KeySpec(keyCode: code, modifiers: modifiers)
	}
}
