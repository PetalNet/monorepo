import AppKit
import DictateCore
import Foundation

/// A recording that is capturing: the microphone and the transcription it feeds.
final class LiveSession: Cancellable, @unchecked Sendable {
	let recorder: Recorder
	let transcription: Transcription

	init(recorder: Recorder, transcription: Transcription) {
		self.recorder = recorder
		self.transcription = transcription
	}

	func cancel() {
		recorder.stop()
		transcription.cancel()
	}
}

struct AgentConfig {
	var key: KeySpec
	var controlSocket: Bool
	var maxSeconds: Int
	var retention: Retention
}

/// Hands out each reply at most once, so a file descriptor is never closed twice.
private final class Once: @unchecked Sendable {
	private let lock = NSLock()
	private var used = false
	func take() -> Bool {
		lock.lock()
		defer { lock.unlock() }
		if used { return false }
		used = true
		return true
	}
}

/// The resident agent: hotkey and socket in, one recording at a time.
/// Everything is event-driven; with no events the process does nothing. The only timers are
/// one-shot waits created per recording and cancelled when it ends.
@MainActor
final class Agent {
	/// One start request and its outcome. Each start has its own token, task and session.
	private final class Pending {
		let token: Int
		var start: Task<String?, Never>?
		/// True once capture is running; limit timers and device changes only apply then.
		var started = false
		init(token: Int) { self.token = token }
	}

	private static let holdSeconds = 30

	private let config: AgentConfig
	private var machine = DictationMachine()
	private let ledger = SessionLedger<LiveSession>()
	private let inserter = Inserter()
	private var current: Pending?
	private var limitTask: Task<Void, Never>?
	private var held: Task<Response, Never>?
	private var heldSession: LiveSession?
	private var holdExpiry: Task<Void, Never>?
	private var lastReleaseToTextMs: Int?
	private var hotkey: Hotkey?
	private var listener: DispatchSourceRead?
	private var signalSources: [DispatchSourceSignal] = []

	init(config: AgentConfig) { self.config = config }

	func run() throws -> Never {
		signal(SIGPIPE, SIG_IGN)
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
		try hotkey.register(config.key)
		self.hotkey = hotkey
		if config.controlSocket {
			try listen()
		} else {
			unlink(Paths.socket)  // a stale file from an earlier run; no live agent owns it
		}
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
			case .holding: state = "holding"
			}
			let latency = lastReleaseToTextMs.map { ", last release-to-text \($0) ms" } ?? ""
			reply(.ok(message: state + latency))
		case .start:
			perform(machine.handle(.socketStart), reply: reply)
		case .stop:
			perform(machine.handle(.socketStop(print: request.print)), reply: reply)
		case .cancel:
			let action = machine.handle(.socketCancel)
			if action == .none { reply(.ok(message: "nothing to cancel")) } else { perform(action, reply: reply) }
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
		case .stopAndHold:
			hold()
		case .deliverHeld(let paste):
			deliverHeld(paste: paste, reply: reply)
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
		let token = ledger.begin()
		let pending = Pending(token: token)
		current = pending
		let recorder = Recorder(onConfigurationChange: { [weak self] in
			Task { @MainActor in self?.forcedEnd(token: token) }
		})
		let retention = config.retention
		pending.start = Task { @MainActor in
			do {
				try await Recorder.ensureAuthorized()
				let transcription = try recorder.start(retention: retention)
				guard ledger.succeed(token, LiveSession(recorder: recorder, transcription: transcription)) else {
					// Cancelled while starting: the session was torn down; no "recording" reply.
					reply?(.error("cancelled before recording started"))
					return "cancelled"
				}
				pending.started = true
				armLimit(token: token)
				reply?(.ok(message: "recording"))
				return nil
			} catch {
				ledger.fail(token)
				let message = "\(error)"
				// Only this recording's failure may reset the machine, and only while it is
				// still waiting for it; a key already released is reported by `finish`.
				if current?.token == token, machine.state != .finishing {
					current = nil
					_ = machine.handle(.socketCancel)
					if let reply { reply(.error(message)) } else { Notifier.post(title: "Dictation failed", body: message) }
				} else {
					reply?(.error(message))
				}
				return message
			}
		}
	}

	private func armLimit(token: Int) {
		limitTask?.cancel()
		let seconds = config.maxSeconds
		limitTask = Task { @MainActor in
			try? await Task.sleep(for: .seconds(seconds))
			guard !Task.isCancelled else { return }
			forcedEnd(token: token)
		}
	}

	/// The length cap fired or the input device changed.
	private func forcedEnd(token: Int) {
		guard let pending = current, pending.token == token, pending.started else { return }
		perform(machine.handle(.forcedEnd), reply: nil)
	}

	private func discard() {
		if let pending = current {
			ledger.discard(pending.token)
			current = nil
		}
		limitTask?.cancel()
		holdExpiry?.cancel()
		held?.cancel()
		heldSession?.cancel()
		held = nil
		heldSession = nil
		holdExpiry = nil
	}

	/// Stops capture and waits for the final text.
	private func collect(_ live: LiveSession, released: ContinuousClock.Instant) async -> Response {
		live.recorder.stop()
		do {
			let raw = try await live.transcription.finish()
			lastReleaseToTextMs = Int(FileTranscriber.milliseconds(ContinuousClock.now - released))
			if let text = TextCleanup.clean(raw) { return .ok(text: text) }
			return .empty
		} catch {
			live.cancel()
			return .error("transcription failed: \(error)")
		}
	}

	private func finish(paste: Bool, reply: ((Response) -> Void)?) {
		guard let pending = current else {
			_ = machine.handle(.finished)
			reply?(.error("no recording"))
			return
		}
		current = nil
		limitTask?.cancel()
		let released = ContinuousClock.now
		let pid = Inserter.frontmostPid()
		Task { @MainActor in
			var response: Response
			if let startError = await pending.start?.value {
				response = .error(startError)
			} else if let live = ledger.take(pending.token) {
				response = await collect(live, released: released)
			} else {
				response = .error("no recording")
			}
			_ = machine.handle(.finished)
			conclude(response, paste: paste, pid: pid, reply: reply)
		}
	}

	private func conclude(_ response: Response, paste: Bool, pid: Int32?, reply: ((Response) -> Void)?) {
		var response = response
		if paste, response.status == .ok, let text = response.text {
			inserter.insert(text, targetPid: pid)
			response = .ok()
		}
		if response.status == .error, reply == nil {
			Notifier.post(title: "Dictation failed", body: response.message ?? "unknown error")
		}
		reply?(response)
	}

	/// A socket recording hit its cap: finish it now, keep the text for a later `stop`.
	private func hold() {
		guard let pending = current, let live = ledger.take(pending.token) else {
			discard()
			_ = machine.handle(.socketCancel)
			return
		}
		current = nil
		limitTask?.cancel()
		heldSession = live
		let released = ContinuousClock.now
		held = Task { @MainActor in await collect(live, released: released) }
		holdExpiry = Task { @MainActor in
			try? await Task.sleep(for: .seconds(Self.holdSeconds))
			guard !Task.isCancelled else { return }
			perform(machine.handle(.holdExpired), reply: nil)
		}
	}

	private func deliverHeld(paste: Bool, reply: ((Response) -> Void)?) {
		holdExpiry?.cancel()
		holdExpiry = nil
		guard let task = held else {
			_ = machine.handle(.finished)
			reply?(.error("no recording"))
			return
		}
		held = nil
		heldSession = nil
		let pid = Inserter.frontmostPid()
		Task { @MainActor in
			let response = await task.value
			_ = machine.handle(.finished)
			conclude(response, paste: paste, pid: pid, reply: reply)
		}
	}

	// MARK: Socket

	private func listen() throws {
		var address = try Paths.socketAddress()
		unlink(Paths.socket)
		let fd = socket(AF_UNIX, SOCK_STREAM, 0)
		guard fd >= 0 else { throw Hotkey.HotkeyError.failed("socket()") }
		let bound = withUnsafePointer(to: &address) {
			$0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
				bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
			}
		}
		guard bound == 0, Darwin.listen(fd, 4) == 0 else { throw Hotkey.HotkeyError.failed("bind \(Paths.socket)") }
		guard chmod(Paths.socket, 0o600) == 0 else { throw Paths.PathError.permissions(Paths.socket) }
		let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .main)
		source.setEventHandler { [weak self] in
			let client = accept(fd, nil, nil)
			guard client >= 0 else { return }
			guard let agent = self else {
				close(client)
				return
			}
			DispatchQueue.global().async { agent.serve(client) }
		}
		source.setCancelHandler { close(fd) }
		source.resume()
		listener = source
	}

	/// Reads one request line, runs it on the main actor, writes one response line.
	/// A client that disconnects early only costs us a failed write.
	private nonisolated func serve(_ client: Int32) {
		Sock.configure(client, receiveSeconds: 5, sendSeconds: 2)
		var uid: uid_t = 0
		var gid: gid_t = 0
		guard getpeereid(client, &uid, &gid) == 0, uid == geteuid() else {
			close(client)
			return
		}
		var buffer = Data()
		var chunk = [UInt8](repeating: 0, count: 1024)
		while Wire.firstLine(in: buffer) == nil, buffer.count < 65536 {
			let count = read(client, &chunk, chunk.count)
			if count <= 0 { break }
			buffer.append(chunk, count: count)
		}
		let once = Once()
		let send: @Sendable (Response) -> Void = { response in
			guard once.take() else { return }
			DispatchQueue.global().async {
				if let data = try? Wire.encode(response) { Sock.writeAll(client, data) }
				close(client)
			}
		}
		switch Wire.parseRequest(Wire.firstLine(in: buffer)) {
		case .failure(let response):
			send(response)
		case .success(let request):
			Task { @MainActor in self.handle(request, reply: send) }
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
