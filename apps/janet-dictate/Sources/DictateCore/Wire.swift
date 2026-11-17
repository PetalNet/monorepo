import Foundation

/// One request line and one response line, both JSON, over the agent's Unix socket.
public struct Request: Codable, Equatable, Sendable {
	public enum Verb: String, Codable, Sendable {
		case start, stop, cancel, status
	}

	public var verb: Verb
	/// Only meaningful for `stop`: return the text instead of pasting it.
	public var print: Bool

	public init(verb: Verb, print: Bool = false) {
		self.verb = verb
		self.print = print
	}
}

public struct Response: Codable, Equatable, Sendable {
	public enum Status: String, Codable, Sendable {
		case ok
		/// The recording finished but no speech was heard.
		case empty
		case error
	}

	public var status: Status
	public var text: String?
	public var message: String?

	public init(status: Status, text: String? = nil, message: String? = nil) {
		self.status = status
		self.text = text
		self.message = message
	}

	public static func ok(text: String? = nil, message: String? = nil) -> Response {
		Response(status: .ok, text: text, message: message)
	}

	public static let empty = Response(status: .empty)

	public static func error(_ message: String) -> Response {
		Response(status: .error, message: message)
	}
}

public enum ExitCode {
	public static let ok: Int32 = 0
	public static let failure: Int32 = 1
	public static let usage: Int32 = 2
	public static let agentNotRunning: Int32 = 3
	public static let noSpeech: Int32 = 4

	public static func forResponse(_ response: Response) -> Int32 {
		switch response.status {
		case .ok: ok
		case .empty: noSpeech
		case .error: failure
		}
	}
}

public enum Wire {
	public static func encode<T: Encodable>(_ value: T) throws -> Data {
		let encoder = JSONEncoder()
		encoder.outputFormatting = [.sortedKeys]
		return try encoder.encode(value) + Data([0x0A])
	}

	/// Decodes one line; a trailing newline is accepted.
	public static func decode<T: Decodable>(_ type: T.Type, from line: Data) throws -> T {
		try JSONDecoder().decode(type, from: line)
	}

	/// Returns the first complete line in `buffer` without its newline, or nil if none yet.
	public static func firstLine(in buffer: Data) -> Data? {
		guard let newline = buffer.firstIndex(of: 0x0A) else { return nil }
		return buffer[buffer.startIndex..<newline]
	}
}
