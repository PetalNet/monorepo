import Foundation

public enum Command: Equatable, Sendable {
	/// Run the resident agent. `key` is the raw `--key` value, if given.
	case agent(key: String?)
	case start
	/// `print == true` returns the text to the caller; otherwise the agent pastes it.
	case stop(print: Bool)
	case cancel
	case status
	case transcribe(path: String)
	case bench(directory: String, realtime: Bool)
	case help
}

public enum CommandParseError: Error, Equatable, CustomStringConvertible {
	case unknownCommand(String)
	case unknownOption(String)
	case missingValue(String)
	case missingArgument(String)

	public var description: String {
		switch self {
		case .unknownCommand(let name): "unknown command: \(name)"
		case .unknownOption(let name): "unknown option: \(name)"
		case .missingValue(let name): "\(name) needs a value"
		case .missingArgument(let name): "missing argument: \(name)"
		}
	}
}

public enum CommandParser {
	public static let usage = """
	usage: janet-dictate [command]

	  agent [--key KEY]        run the resident agent (default with no command)
	  start                    ask the agent to begin recording
	  stop [--print]           end the recording; paste, or print with --print
	  cancel                   discard the recording
	  status                   print the agent state
	  transcribe FILE.wav      transcribe a file, print JSON
	  --bench DIR [--realtime] transcribe DIR/*.wav, print WER and latency JSON

	KEY is f19, ctrl+opt+space, keycode:80, and so on.
	exit codes: 0 ok, 1 error, 2 usage, 3 agent not running, 4 no speech heard
	"""

	public static func parse(_ arguments: [String]) throws -> Command {
		var args = arguments
		guard let first = args.first else { return .agent(key: nil) }
		// A leading option means the agent, so `open -a ... --args --key f18` works.
		if first == "-h" || first == "--help" || first == "help" { return .help }
		if first == "--bench" {
			args.removeFirst()
			return try parseBench(args)
		}
		if first.hasPrefix("-") { return .agent(key: try parseAgentOptions(args)) }
		args.removeFirst()
		switch first {
		case "agent":
			return .agent(key: try parseAgentOptions(args))
		case "start":
			try rejectExtra(args)
			return .start
		case "stop":
			var printText = false
			for arg in args {
				guard arg == "--print" else { throw CommandParseError.unknownOption(arg) }
				printText = true
			}
			return .stop(print: printText)
		case "cancel":
			try rejectExtra(args)
			return .cancel
		case "status":
			try rejectExtra(args)
			return .status
		case "transcribe":
			guard let path = args.first else { throw CommandParseError.missingArgument("FILE.wav") }
			try rejectExtra(Array(args.dropFirst()))
			return .transcribe(path: path)
		case "bench":
			return try parseBench(args)
		default:
			throw CommandParseError.unknownCommand(first)
		}
	}

	private static func parseAgentOptions(_ args: [String]) throws -> String? {
		var key: String?
		var index = 0
		while index < args.count {
			let arg = args[index]
			if arg == "--key" {
				guard index + 1 < args.count else { throw CommandParseError.missingValue("--key") }
				key = args[index + 1]
				index += 2
			} else if arg.hasPrefix("--key=") {
				key = String(arg.dropFirst(6))
				index += 1
			} else if arg.hasPrefix("-psn_") {
				index += 1  // LaunchServices passes this on old launches
			} else {
				throw CommandParseError.unknownOption(arg)
			}
		}
		return key
	}

	private static func parseBench(_ args: [String]) throws -> Command {
		var directory: String?
		var realtime = false
		for arg in args {
			if arg == "--realtime" {
				realtime = true
			} else if arg.hasPrefix("-") {
				throw CommandParseError.unknownOption(arg)
			} else if directory == nil {
				directory = arg
			} else {
				throw CommandParseError.unknownOption(arg)
			}
		}
		guard let directory else { throw CommandParseError.missingArgument("DIR") }
		return .bench(directory: directory, realtime: realtime)
	}

	private static func rejectExtra(_ args: [String]) throws {
		if let extra = args.first { throw CommandParseError.unknownOption(extra) }
	}

	/// The key to bind: `--key`, else the `key` defaults value, else F19.
	public static func resolveKey(argument: String?, defaultsValue: String?) throws -> KeySpec {
		if let argument { return try KeySpec.parse(argument) }
		if let defaultsValue, !defaultsValue.isEmpty { return try KeySpec.parse(defaultsValue) }
		return .default
	}
}
