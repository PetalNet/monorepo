import AVFoundation
import DictateCore
import Foundation

/// Owns the microphone only between `start` and `stop`. One instance per recording; the
/// engine is released afterwards, so nothing holds the input device while idle.
final class Recorder: @unchecked Sendable {
	private var engine: AVAudioEngine?
	private var observer: NSObjectProtocol?
	private let onConfigurationChange: @Sendable () -> Void

	/// `onConfigurationChange` fires if the input device changes mid-recording.
	init(onConfigurationChange: @escaping @Sendable () -> Void) {
		self.onConfigurationChange = onConfigurationChange
	}

	enum MicError: Error, CustomStringConvertible {
		case denied
		case failed(String)
		var description: String {
			switch self {
			case .denied: "microphone access is denied; allow janet-dictate in System Settings > Privacy & Security > Microphone"
			case .failed(let reason): "could not start the microphone: \(reason)"
			}
		}
	}

	static func ensureAuthorized() async throws {
		switch AVCaptureDevice.authorizationStatus(for: .audio) {
		case .authorized: return
		case .notDetermined:
			if await AVCaptureDevice.requestAccess(for: .audio) { return }
			throw MicError.denied
		default: throw MicError.denied
		}
	}

	/// Starts capture and returns the transcription that is receiving it.
	func start(retention: Retention) throws -> Transcription {
		let engine = AVAudioEngine()
		let input = engine.inputNode
		let format = input.outputFormat(forBus: 0)
		guard format.sampleRate > 0, format.channelCount > 0 else {
			throw MicError.failed("no input device")
		}
		let transcription = Transcription(sourceFormat: format, retention: retention)
		input.installTap(onBus: 0, bufferSize: 2048, format: format) { buffer, _ in
			transcription.feed(buffer)
		}
		do {
			try engine.start()
		} catch {
			input.removeTap(onBus: 0)
			transcription.cancel()
			throw MicError.failed(error.localizedDescription)
		}
		let change = onConfigurationChange
		observer = NotificationCenter.default.addObserver(
			forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
		) { _ in change() }
		self.engine = engine
		return transcription
	}

	func stop() {
		if let observer { NotificationCenter.default.removeObserver(observer) }
		observer = nil
		guard let engine else { return }
		engine.inputNode.removeTap(onBus: 0)
		engine.stop()
		self.engine = nil
	}
}
