import Foundation
@preconcurrency import UserNotifications

enum Notifier {
	/// Posts a banner. Asks for permission the first time, which is also when macOS shows its prompt.
	/// Outside an .app bundle the notification center is unavailable, so the message goes to stderr.
	static func post(title: String, body: String) {
		guard Bundle.main.bundleIdentifier != nil else {
			FileHandle.standardError.write(Data("janet-dictate: \(title): \(body)\n".utf8))
			return
		}
		let center = UNUserNotificationCenter.current()
		center.requestAuthorization(options: [.alert]) { granted, _ in
			let center = UNUserNotificationCenter.current()
			guard granted else {
				FileHandle.standardError.write(Data("janet-dictate: \(title): \(body)\n".utf8))
				return
			}
			let content = UNMutableNotificationContent()
			content.title = title
			content.body = body
			center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
		}
	}
}
