import AppKit
import DictateCore
import Foundation

/// The resident agent: hotkey and socket in, one recording at a time.
/// Everything is event-driven; with no events the process does nothing.
@MainActor
final class Agent {
	private var machine = DictationMachine()
	private let recorder = Recorder()
	private let inserter = Inserter()
	private var transcription: Transcription?
	private var startTask: Task<Void, Never>?
	private var startError: String?
	private var lastReleaseToTextMs: Int?
	private var hotkey: Hotkey?
	private var listener: DispatchSourceRead?
	private var signalSources: [DispatchSourceSignal] = []

	func run(key: KeySpec) throws -> Never {
		try Paths.prepareDirectory()
		if Client.send(Request(verb: .status), timeout: 2) != nil {
			FileHandle.standardError.write(Data("janet-dictate: an agent is already running\n".utf8))
			exit(0)
		}
		let app = NSApplication.shared
		app.setActivationPolicy(.accessory)

		let hotkey = Hotkey(
			onPress: { [weak self] in Task { @MainActor in self?.hotkeyEvent(down: true) } },
			onRelease: { [weak self] in Task { @MainActor in self?.hotkeyEvent(down: false) } }
		)
		try hotkey.register(key)
		self.hotkey = hotkey
		try listen()
		installSignalHandlers()
		app.run()
		exit(0)
	}

	// MARK: Events

	private func hotkeyEvent(down: Bool) {
		let now = ProcessInfo.processInfo.systemUptime
		perform(machine.handle(down ? .keyDown(at: now) : .keyUp(at: now)), reply: nil)
	}

	private func handle(_ request: Request, reply: @escaping (Response) -> Void) {
		switch request.verb {
		case .status:
			let state: String
			switch machine.state {
			case .idle: state = "idle"
			case .recording: state = "recording"
			case .finishing: state = "finishing"
			}
			let latency = lastReleaseToTextMs.map { ", last release-to-text \($0) ms" } ?? ""
			reply(.ok(message: state + latency))
		case .start:
			perform(machine.handle(.socketStart), reply: reply)
		case .stop:
			perform(machine.handle(.socketStop(print: request.print)), reply: reply)
		case .cancel:
			let action = machine.handle(.socketCancel)
			perform(action, reply: reply)
			if action == .none { reply(.ok(message: "nothing to cancel")) }
		}
	}

	private func perform(_ action: DictationMachine.Action, reply: ((Response) -> Void)?) {
		switch action {
		case .none:
			break
		case .startRecording:
			begin(reply: reply)
		case .stopAndPaste:
			finish(paste: true, reply: reply)
		case .stopAndReturnText:
			finish(paste: false, reply: reply)
		case .discard:
			discard()
			reply?(.ok(message: "cancelled"))
		case .rejectBusy:
			reply?(.error("already recording or finishing"))
		case .rejectNotRecording:
			reply?(.error("not recording"))
		}
	}

	// MARK: Recording

	private func begin(reply: ((Response) -> Void)?) {
		startError = nil
		startTask = Task { @MainActor in
			do {
				try await Recorder.ensureAuthorized()
				transcription = try recorder.start()
				reply?(.ok(message: "recording"))
			} catch {
				startError = "\(error)"
				_ = machine.handle(.socketCancel)
				if let reply { reply(.error("\(error)")) } else { Notifier.post(title: "Dictation failed", body: "\(error)") }
			}
		}
	}

	private func discard() {
		let pending = startTask
		let live = transcription
		transcription = nil
		Task { @MainActor in
			await pending?.value
			recorder.stop()
			live?.cancel()
			transcription?.cancel()
			transcription = nil
		}
	}

	private func finish(paste: Bool, reply: ((Response) -> Void)?) {
		let pending = startTask
		let released = ContinuousClock.now
		Task { @MainActor in
			await pending?.value
			recorder.stop()
			let live = transcription
			transcription = nil
			var response: Response
			if let startError {
				response = .error(startError)
			} else if let live {
				do {
					let raw = try await live.finish()
					lastReleaseToTextMs = Int(FileTranscriber.milliseconds(ContinuousClock.now - released))
					if let text = TextCleanup.clean(raw) {
						if paste { inserter.insert(text) }
						response = .ok(text: paste ? nil : text)
					} else {
						response = .empty
					}
				} catch {
					response = .error("transcription failed: \(error)")
				}
			} else {
				response = .error("no recording")
			}
			_ = machine.handle(.finished)
			if response.status == .error, reply == nil {
				Notifier.post(title: "Dictation failed", body: response.message ?? "unknown error")
			}
			reply?(response)
		}
	}

	// MARK: Socket

	private func listen() throws {
		unlink(Paths.socket)
		let fd = socket(AF_UNIX, SOCK_STREAM, 0)
		guard fd >= 0 else { throw Hotkey.HotkeyError.failed("socket()") }
		var address = Paths.socketAddress()
		let bound = withUnsafePointer(to: &address) {
			$0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
				bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
			}
		}
		guard bound == 0, Darwin.listen(fd, 4) == 0 else { throw Hotkey.HotkeyError.failed("bind \(Paths.socket)") }
		chmod(Paths.socket, 0o600)
		let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .main)
		source.setEventHandler { [weak self] in
			let client = accept(fd, nil, nil)
			guard client >= 0 else { return }
			DispatchQueue.global().async { self?.serve(client) }
		}
		source.setCancelHandler { close(fd) }
		source.resume()
		listener = source
	}

	/// Reads one request line, runs it on the main actor, writes one response line.
	private nonisolated func serve(_ client: Int32) {
		var tv = timeval(tv_sec: 5, tv_usec: 0)
		setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
		var buffer = Data()
		var chunk = [UInt8](repeating: 0, count: 1024)
		while Wire.firstLine(in: buffer) == nil, buffer.count < 65536 {
			let count = read(client, &chunk, chunk.count)
			if count <= 0 { break }
			buffer.append(chunk, count: count)
		}
		guard let line = Wire.firstLine(in: buffer), let request = try? Wire.decode(Request.self, from: line) else {
			close(client)
			return
		}
		Task { @MainActor in
			self.handle(request) { response in
				if let data = try? Wire.encode(response) {
					_ = data.withUnsafeBytes { write(client, $0.baseAddress, $0.count) }
				}
				close(client)
			}
		}
	}

	private func installSignalHandlers() {
		for sig in [SIGTERM, SIGINT] {
			signal(sig, SIG_IGN)
			let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
			source.setEventHandler {
				unlink(Paths.socket)
				exit(0)
			}
			source.resume()
			signalSources.append(source)
		}
	}
}
