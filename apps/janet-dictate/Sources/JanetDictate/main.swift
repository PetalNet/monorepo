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

if let value = ProcessInfo.processInfo.environment["JANET_DICTATE_RETENTION"] {
	switch value {
	case "lingering": Engine.retention = .lingering
	case "process": Engine.retention = .processLifetime
	default: Engine.retention = .whileInUse
	}
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
case .agent(let keyArgument):
	let defaultsValue = UserDefaults.standard.string(forKey: "key")
	let key: KeySpec
	do { key = try CommandParser.resolveKey(argument: keyArgument, defaultsValue: defaultsValue) } catch { fail("bad key: \(error)", code: ExitCode.usage) }
	MainActor.assumeIsolated {
		// Held for the life of the process: the hotkey and socket handlers only keep weak references.
		let agent = Agent()
		do { try agent.run(key: key) } catch { fail("\(error)") }
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
		let timing = try await FileTranscriber.transcribe(path: path, realtime: false)
		let object: [String: Any] = [
			"text": timing.text, "ms": Int(timing.totalMs.rounded()), "audio_s": (timing.audioSeconds * 100).rounded() / 100,
		]
		let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
		print(String(decoding: data, as: UTF8.self))
	}
case .bench(let directory, let realtime):
	blocking { try await Bench.run(directory: directory, realtime: realtime) }
}
