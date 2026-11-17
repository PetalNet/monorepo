import Foundation

public enum Retention: String, CaseIterable, Sendable {
	/// The system unloads the speech model as soon as a session ends. Lowest idle memory.
	case whileInUse
	/// The system keeps the model loaded for a short while after use.
	case lingering
	case processLifetime
}

public struct AgentOptions: Equatable, Sendable {
	/// Raw `--key` value.
	public var key: String?
	public var controlSocket: Bool
	public var maxSeconds: Int?
	public var retention: Retention?

	public init(key: String? = nil, controlSocket: Bool = false, maxSeconds: Int? = nil, retention: Retention? = nil) {
		self.key = key
		self.controlSocket = controlSocket
		self.maxSeconds = maxSeconds
		self.retention = retention
	}
}

public enum Command: Equatable, Sendable {
	case agent(AgentOptions)
	case start
	/// `print == true` returns the text to the caller; otherwise the agent pastes it.
	case stop(print: Bool)
	case cancel
	case status
	case transcribe(path: String)
	case bench(directory: String, realtime: Bool, retention: Retention?)
	case help
}

public enum CommandParseError: Error, Equatable, CustomStringConvertible {
	case unknownCommand(String)
	case unknownOption(String)
	case missingValue(String)
	case invalidValue(option: String, value: String)
	case missingArgument(String)

	public var description: String {
		switch self {
		case .unknownCommand(let name): "unknown command: \(name)"
		case .unknownOption(let name): "unknown option: \(name)"
		case .missingValue(let name): "\(name) needs a value"
		case .invalidValue(let option, let value): "bad value for \(option): \(value)"
		case .missingArgument(let name): "missing argument: \(name)"
		}
	}
}

public enum CommandParser {
	public static let defaultMaxSeconds = 120
	public static let maxSecondsRange = 5...3600

	public static let usage = """
	usage: janet-dictate [command]

	  agent [options]          run the resident agent (default with no command)
	      --key KEY            hotkey, default f19 (also: defaults write ... key)
	      --control-socket     enable start/stop/cancel/status for scripts (off by default;
	                           also: defaults write ... controlSocket -bool true)
	      --max-seconds N      stop a recording after N seconds, default 120
	      --retention MODE     whileInUse (default), lingering or processLifetime
	  start                    ask the agent to begin recording
	  stop [--print]           end the recording; paste, or print with --print
	  cancel                   discard the recording
	  status                   print the agent state
	  transcribe FILE.wav      transcribe a file, print JSON
	  --bench DIR [--realtime] [--retention MODE]
	                           transcribe DIR/*.wav, print WER and latency JSON

	KEY is f19, ctrl+opt+space, keycode:80, and so on.
	exit codes: 0 ok, 1 error, 2 usage, 3 agent not running or control socket off, 4 no speech heard
	"""

	public static func parse(_ arguments: [String]) throws -> Command {
		var args = arguments
		guard let first = args.first else { return .agent(AgentOptions()) }
		// A leading option means the agent, so `open -a ... --args --key f18` works.
		if first == "-h" || first == "--help" || first == "help" { return .help }
		if first == "--bench" {
			args.removeFirst()
			return try parseBench(args)
		}
		if first.hasPrefix("-") { return .agent(try parseAgentOptions(args)) }
		args.removeFirst()
		switch first {
		case "agent":
			return .agent(try parseAgentOptions(args))
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

	private static func value(of option: String, in args: [String], at index: Int) throws -> String {
		guard index + 1 < args.count else { throw CommandParseError.missingValue(option) }
		return args[index + 1]
	}

	private static func parseRetention(_ text: String) throws -> Retention {
		guard let retention = Retention(rawValue: text) else {
			throw CommandParseError.invalidValue(option: "--retention", value: text)
		}
		return retention
	}

	private static func parseAgentOptions(_ args: [String]) throws -> AgentOptions {
		var options = AgentOptions()
		var index = 0
		while index < args.count {
			let arg = args[index]
			var step = 1
			if arg == "--key" {
				options.key = try value(of: arg, in: args, at: index)
				step = 2
			} else if arg.hasPrefix("--key=") {
				options.key = String(arg.dropFirst(6))
			} else if arg == "--control-socket" {
				options.controlSocket = true
			} else if arg == "--max-seconds" {
				let text = try value(of: arg, in: args, at: index)
				guard let seconds = Int(text), maxSecondsRange.contains(seconds) else {
					throw CommandParseError.invalidValue(option: arg, value: text)
				}
				options.maxSeconds = seconds
				step = 2
			} else if arg == "--retention" {
				options.retention = try parseRetention(try value(of: arg, in: args, at: index))
				step = 2
			} else if arg.hasPrefix("-psn_") {
				// LaunchServices passes this on old launches
			} else {
				throw CommandParseError.unknownOption(arg)
			}
			index += step
		}
		return options
	}

	private static func parseBench(_ args: [String]) throws -> Command {
		var directory: String?
		var realtime = false
		var retention: Retention?
		var index = 0
		while index < args.count {
			let arg = args[index]
			if arg == "--realtime" {
				realtime = true
			} else if arg == "--retention" {
				retention = try parseRetention(try value(of: arg, in: args, at: index))
				index += 1
			} else if arg.hasPrefix("-") || directory != nil {
				throw CommandParseError.unknownOption(arg)
			} else {
				directory = arg
			}
			index += 1
		}
		guard let directory else { throw CommandParseError.missingArgument("DIR") }
		return .bench(directory: directory, realtime: realtime, retention: retention)
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

	/// Control socket is off unless the flag or the defaults key turns it on.
	public static func resolveControlSocket(flag: Bool, defaultsValue: Bool?) -> Bool {
		flag || defaultsValue == true
	}

	public static func resolveMaxSeconds(argument: Int?, defaultsValue: Int?) -> Int {
		if let argument { return argument }
		if let defaultsValue, maxSecondsRange.contains(defaultsValue) { return defaultsValue }
		return defaultMaxSeconds
	}

	public static func resolveRetention(argument: Retention?, defaultsValue: String?) -> Retention {
		argument ?? defaultsValue.flatMap(Retention.init(rawValue:)) ?? .whileInUse
	}
}
