import AVFoundation
import DictateCore
import Foundation
import Speech

struct EngineError: Error, CustomStringConvertible {
	let description: String
}

/// Wraps a non-Sendable buffer so it can cross into the pump task.
struct SendableBuffer: @unchecked Sendable {
	let buffer: AVAudioPCMBuffer
}

enum Engine {
	/// How long the system keeps the speech model loaded after a session ends.
	/// `whileInUse` unloads it as soon as we finish, which keeps idle memory lowest.
	static var retention: SpeechAnalyzer.Options.ModelRetention = .whileInUse

	static func locale() async -> Locale {
		if let supported = await SpeechTranscriber.supportedLocale(equivalentTo: Locale.current) {
			return supported
		}
		return Locale(identifier: "en_US")
	}

	/// Makes sure the on-device model for `locale` is installed, downloading it from Apple if not.
	static func ensureAssets(transcriber: SpeechTranscriber) async throws {
		let status = await AssetInventory.status(forModules: [transcriber])
		guard status < .installed else { return }
		guard status != .unsupported else { throw EngineError(description: "speech model unsupported for this locale") }
		FileHandle.standardError.write(Data("janet-dictate: downloading the speech model\n".utf8))
		if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
			try await request.downloadAndInstall()
		}
	}
}

/// One utterance: raw audio buffers in, final text out.
/// Setup (model load, analyzer start) runs while audio is already being queued, so the
/// first words are never lost and release-to-text only pays for the tail.
final class Transcription: @unchecked Sendable {
	private let rawStream: AsyncStream<SendableBuffer>
	private let rawContinuation: AsyncStream<SendableBuffer>.Continuation
	private var pump: Task<String, Error>!
	private let sourceFormat: AVAudioFormat

	init(sourceFormat: AVAudioFormat) {
		self.sourceFormat = sourceFormat
		(rawStream, rawContinuation) = AsyncStream.makeStream(of: SendableBuffer.self, bufferingPolicy: .unbounded)
		let stream = rawStream
		pump = Task { [sourceFormat] in
			try await Self.run(stream: stream, sourceFormat: sourceFormat)
		}
	}

	func feed(_ buffer: AVAudioPCMBuffer) {
		rawContinuation.yield(SendableBuffer(buffer: buffer))
	}

	/// Ends the audio and returns the final text (possibly empty).
	func finish() async throws -> String {
		rawContinuation.finish()
		return try await pump.value
	}

	func cancel() {
		rawContinuation.finish()
		pump.cancel()
	}

	private static func run(stream: AsyncStream<SendableBuffer>, sourceFormat: AVAudioFormat) async throws -> String {
		let transcriber = SpeechTranscriber(locale: await Engine.locale(), preset: .transcription)
		try await Engine.ensureAssets(transcriber: transcriber)
		guard let target = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
			throw EngineError(description: "no compatible audio format")
		}
		let options = SpeechAnalyzer.Options(priority: .userInitiated, modelRetention: Engine.retention)
		let analyzer = SpeechAnalyzer(modules: [transcriber], options: options)
		try await analyzer.prepareToAnalyze(in: target)

		let (inputs, inputContinuation) = AsyncStream.makeStream(of: AnalyzerInput.self, bufferingPolicy: .unbounded)
		let collector = Task { () throws -> String in
			var text = ""
			for try await result in transcriber.results {
				text += String(result.text.characters)
				text += " "
			}
			return text
		}
		try await analyzer.start(inputSequence: inputs)

		let converter = AVAudioConverter(from: sourceFormat, to: target)
		for await item in stream {
			if let converted = convert(item.buffer, with: converter, to: target) {
				inputContinuation.yield(AnalyzerInput(buffer: converted))
			}
		}
		inputContinuation.finish()
		if Task.isCancelled {
			await analyzer.cancelAndFinishNow()
			collector.cancel()
			throw CancellationError()
		}
		try await analyzer.finalizeAndFinishThroughEndOfInput()
		return try await collector.value
	}

	private static func convert(
		_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter?, to target: AVAudioFormat
	) -> AVAudioPCMBuffer? {
		guard let converter else { return buffer }
		let ratio = target.sampleRate / buffer.format.sampleRate
		let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 64
		guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return nil }
		var supplied = false
		var error: NSError?
		let status = converter.convert(to: out, error: &error) { _, inputStatus in
			if supplied {
				inputStatus.pointee = .noDataNow
				return nil
			}
			supplied = true
			inputStatus.pointee = .haveData
			return buffer
		}
		guard status != .error, out.frameLength > 0 else { return nil }
		return out
	}
}

enum FileTranscriber {
	struct Timing {
		var text: String
		/// From the first audio handed over to the final text.
		var totalMs: Double
		/// From the last audio handed over to the final text (what a user waits after release).
		var tailMs: Double
		var audioSeconds: Double
	}

	/// Pushes a WAV through the same `Transcription` path the microphone uses.
	/// `realtime` paces the buffers like a live microphone.
	static func transcribe(path: String, realtime: Bool) async throws -> Timing {
		let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
		let format = file.processingFormat
		let chunk = AVAudioFrameCount(format.sampleRate / 10)
		let seconds = Double(file.length) / format.sampleRate
		let clock = ContinuousClock()
		let start = clock.now
		let transcription = Transcription(sourceFormat: format)
		while file.framePosition < file.length {
			guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: chunk) else { break }
			try file.read(into: buffer, frameCount: chunk)
			if buffer.frameLength == 0 { break }
			transcription.feed(buffer)
			if realtime { try await Task.sleep(for: .milliseconds(100)) }
		}
		let tailStart = clock.now
		let raw = try await transcription.finish()
		let end = clock.now
		return Timing(
			text: TextCleanup.clean(raw) ?? "",
			totalMs: milliseconds(end - start),
			tailMs: milliseconds(end - tailStart),
			audioSeconds: seconds
		)
	}

	static func milliseconds(_ duration: Duration) -> Double {
		let parts = duration.components
		return Double(parts.seconds) * 1000 + Double(parts.attoseconds) / 1e15
	}
}
