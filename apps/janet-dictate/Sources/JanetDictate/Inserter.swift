import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import DictateCore
import Foundation

/// Puts text into the focused app: transient clipboard write, Cmd+V, then restore.
@MainActor
final class Inserter {
	private static let transientType = NSPasteboard.PasteboardType(PasteboardPolicy.transientType)
	private static let concealedType = NSPasteboard.PasteboardType(PasteboardPolicy.concealedType)
	/// The target app may read the pasteboard well after the keystroke lands.
	private static let restoreDelay: TimeInterval = 1.0

	private var warnedAboutAccessibility = false

	static func frontmostPid() -> Int32? {
		NSWorkspace.shared.frontmostApplication?.processIdentifier
	}

	/// `targetPid` is the frontmost app when the key was released; the paste only goes out if
	/// that app still has focus.
	func insert(_ text: String, targetPid: Int32?) {
		let pasteboard = NSPasteboard.general
		let saved = Self.snapshot(of: pasteboard)

		pasteboard.clearContents()
		pasteboard.declareTypes([.string, Self.transientType, Self.concealedType], owner: nil)
		pasteboard.setString(text, forType: .string)
		pasteboard.setData(Data(), forType: Self.transientType)
		pasteboard.setData(Data(), forType: Self.concealedType)
		let ownCount = pasteboard.changeCount

		guard AXIsProcessTrusted() else {
			// Keep the text where the user can paste it by hand.
			if !warnedAboutAccessibility {
				warnedAboutAccessibility = true
				Notifier.post(
					title: "Dictation copied",
					body: "Allow janet-dictate under Accessibility to paste automatically. The text is on your clipboard."
				)
				let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
				_ = AXIsProcessTrustedWithOptions(options)
			}
			return
		}

		switch PasteboardPolicy.pasteTarget(
			pidAtRelease: targetPid, pidNow: Self.frontmostPid(), secureInput: IsSecureEventInputEnabled()
		) {
		case .clipboardOnly(let reason):
			let why = reason == .secureInput ? "A secure text field is active." : "The focused app changed."
			Notifier.post(title: "Dictation copied", body: "\(why) The text is on your clipboard, not pasted.")
			return
		case .paste:
			break
		}

		Self.postPaste()
		DispatchQueue.main.asyncAfter(deadline: .now() + Self.restoreDelay) {
			let board = NSPasteboard.general
			switch PasteboardPolicy.restoreDecision(
				ownChangeCount: ownCount,
				currentChangeCount: board.changeCount,
				hadPreviousContents: !saved.isEmpty
			) {
			case .restore:
				let markers = PasteboardPolicy.restoreMarkers(savedItemTypes: saved.map { $0.keys.map(\.rawValue) })
				board.clearContents()
				let items = saved.map { item -> NSPasteboardItem in
					let restored = NSPasteboardItem()
					for (type, data) in item { restored.setData(data, forType: type) }
					for marker in markers { restored.setData(Data(), forType: NSPasteboard.PasteboardType(marker)) }
					return restored
				}
				board.writeObjects(items)
			case .clear:
				board.clearContents()
			case .leave:
				break
			}
		}
	}

	private static func snapshot(of pasteboard: NSPasteboard) -> [[NSPasteboard.PasteboardType: Data]] {
		(pasteboard.pasteboardItems ?? []).map { item in
			var copy: [NSPasteboard.PasteboardType: Data] = [:]
			for type in item.types {
				if let data = item.data(forType: type) { copy[type] = data }
			}
			return copy
		}
	}

	private static func postPaste() {
		let source = CGEventSource(stateID: .combinedSessionState)
		let vKey: CGKeyCode = 9
		for isDown in [true, false] {
			let event = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: isDown)
			event?.flags = .maskCommand
			event?.post(tap: .cghidEventTap)
		}
	}
}
