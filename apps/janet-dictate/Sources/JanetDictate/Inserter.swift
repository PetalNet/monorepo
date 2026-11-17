import AppKit
import ApplicationServices
import CoreGraphics
import DictateCore
import Foundation

/// Puts text into the focused app: transient clipboard write, Cmd+V, then restore.
@MainActor
final class Inserter {
	private static let transientType = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")
	private static let concealedType = NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")
	private static let restoreDelay: TimeInterval = 0.3

	private var warnedAboutAccessibility = false

	func insert(_ text: String) {
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

		Self.postPaste()
		DispatchQueue.main.asyncAfter(deadline: .now() + Self.restoreDelay) {
			let board = NSPasteboard.general
			switch PasteboardPolicy.restoreDecision(
				ownChangeCount: ownCount,
				currentChangeCount: board.changeCount,
				hadPreviousContents: !saved.isEmpty
			) {
			case .restore:
				board.clearContents()
				for item in saved {
					let restored = NSPasteboardItem()
					for (type, data) in item { restored.setData(data, forType: type) }
					board.writeObjects([restored])
				}
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
