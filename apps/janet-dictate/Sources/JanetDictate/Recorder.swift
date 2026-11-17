import AVFoundation
import Foundation

/// Owns the microphone only between `start` and `stop`. The engine is created per recording
/// and released afterwards, so nothing holds the input device while idle.
final class Recorder {
	private var engine: AVAudioEngine?

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
	func start() throws -> Transcription {
		let engine = AVAudioEngine()
		let input = engine.inputNode
		let format = input.outputFormat(forBus: 0)
		guard format.sampleRate > 0, format.channelCount > 0 else {
			throw MicError.failed("no input device")
		}
		let transcription = Transcription(sourceFormat: format)
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
		self.engine = engine
		return transcription
	}

	func stop() {
		guard let engine else { return }
		engine.inputNode.removeTap(onBus: 0)
		engine.stop()
		self.engine = nil
	}
}
