import DictateCore
import Foundation
import Speech

func fail(_ message: String, code: Int32 = ExitCode.failure) -> Never {
	FileHandle.standardError.write(Data("janet-dictate: \(message)\n".utf8))
	exit(code)
}

/// Runs async work from the synchronous top level and exits with its result.
func blocking(_ work: @escaping @Sendable () async throws -> Void) -> Never {
	Task {
		do {
			try await work()
			exit(0)
		} catch {
			fail("\(error)")
		}
	}
	dispatchMain()
}

let command: Command
do {
	command = try CommandParser.parse(Array(CommandLine.arguments.dropFirst()))
} catch {
	FileHandle.standardError.write(Data("janet-dictate: \(error)\n\(CommandParser.usage)\n".utf8))
	exit(ExitCode.usage)
}

switch command {
case .help:
	print(CommandParser.usage)
case .agent(let options):
	let defaults = UserDefaults.standard
	let key: KeySpec
	do {
		key = try CommandParser.resolveKey(argument: options.key, defaultsValue: defaults.string(forKey: "key"))
	} catch { fail("bad key: \(error)", code: ExitCode.usage) }
	let config = AgentConfig(
		key: key,
		controlSocket: CommandParser.resolveControlSocket(
			flag: options.controlSocket, defaultsValue: defaults.object(forKey: "controlSocket") as? Bool
		),
		maxSeconds: CommandParser.resolveMaxSeconds(
			argument: options.maxSeconds, defaultsValue: defaults.object(forKey: "maxSeconds") as? Int
		),
		retention: CommandParser.resolveRetention(
			argument: options.retention, defaultsValue: defaults.string(forKey: "retention")
		)
	)
	MainActor.assumeIsolated {
		// Held for the life of the process: the hotkey and socket handlers only keep weak references.
		let agent = Agent(config: config)
		do { try agent.run() } catch { fail("\(error)") }
	}
case .start:
	exit(Client.run(Request(verb: .start)))
case .stop(let printText):
	exit(Client.run(Request(verb: .stop, print: printText)))
case .cancel:
	exit(Client.run(Request(verb: .cancel)))
case .status:
	exit(Client.run(Request(verb: .status)))
case .transcribe(let path):
	blocking {
		let timing = try await FileTranscriber.transcribe(path: path, realtime: false, retention: .whileInUse)
		let object: [String: Any] = [
			"text": timing.text, "ms": Int(timing.totalMs.rounded()), "audio_s": (timing.audioSeconds * 100).rounded() / 100,
		]
		let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
		print(String(decoding: data, as: UTF8.self))
	}
case .bench(let directory, let realtime, let retention):
	blocking { try await Bench.run(directory: directory, realtime: realtime, retention: retention ?? .whileInUse) }
}
