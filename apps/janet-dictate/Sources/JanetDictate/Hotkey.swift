import Carbon.HIToolbox
import DictateCore
import Foundation

/// Global hotkey through Carbon. Delivers press and release; needs no Accessibility permission.
final class Hotkey {
	private var hotKeyRef: EventHotKeyRef?
	private var handlerRef: EventHandlerRef?
	private let onPress: () -> Void
	private let onRelease: () -> Void

	init(onPress: @escaping () -> Void, onRelease: @escaping () -> Void) {
		self.onPress = onPress
		self.onRelease = onRelease
	}

	func register(_ spec: KeySpec) throws {
		var kinds = [
			EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
			EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased)),
		]
		let status = InstallEventHandler(
			GetApplicationEventTarget(),
			{ _, event, userData in
				guard let event, let userData else { return OSStatus(eventNotHandledErr) }
				let hotkey = Unmanaged<Hotkey>.fromOpaque(userData).takeUnretainedValue()
				switch GetEventKind(event) {
				case UInt32(kEventHotKeyPressed): hotkey.onPress()
				case UInt32(kEventHotKeyReleased): hotkey.onRelease()
				default: return OSStatus(eventNotHandledErr)
				}
				return noErr
			},
			kinds.count, &kinds, Unmanaged.passUnretained(self).toOpaque(), &handlerRef
		)
		guard status == noErr else { throw HotkeyError.failed("InstallEventHandler \(status)") }
		let id = EventHotKeyID(signature: OSType(0x4A44_4B59), id: 1)
		let registered = RegisterEventHotKey(
			spec.keyCode, spec.modifiers, id, GetApplicationEventTarget(), 0, &hotKeyRef
		)
		guard registered == noErr else { throw HotkeyError.failed("RegisterEventHotKey \(registered)") }
	}

	enum HotkeyError: Error, CustomStringConvertible {
		case failed(String)
		var description: String {
			switch self { case .failed(let reason): "could not register the hotkey: \(reason)" }
		}
	}
}
