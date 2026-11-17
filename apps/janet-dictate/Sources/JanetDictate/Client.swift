import DictateCore
import Foundation

/// Talks to the resident agent. Returns nil when no agent is listening.
enum Client {
	static let notRunningMessage = """
		janet-dictate: agent is not running, or its control socket is off.
		Start it with --control-socket, or run: defaults write dev.petalnet.janet-dictate controlSocket -bool true
		"""

	static func send(_ request: Request, timeout: Int = 60) -> Response? {
		signal(SIGPIPE, SIG_IGN)
		let fd = socket(AF_UNIX, SOCK_STREAM, 0)
		guard fd >= 0 else { return nil }
		defer { close(fd) }
		guard var address = try? Paths.socketAddress() else { return nil }
		let connected = withUnsafePointer(to: &address) {
			$0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
				connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
			}
		}
		guard connected == 0 else { return nil }
		Sock.configure(fd, receiveSeconds: timeout, sendSeconds: 5)
		guard let data = try? Wire.encode(request), Sock.writeAll(fd, data) else {
			return .error("could not send the request")
		}
		var buffer = Data()
		var chunk = [UInt8](repeating: 0, count: 4096)
		while Wire.firstLine(in: buffer) == nil {
			let count = read(fd, &chunk, chunk.count)
			if count <= 0 { break }
			buffer.append(chunk, count: count)
		}
		guard let line = Wire.firstLine(in: buffer),
			let response = try? Wire.decode(Response.self, from: line)
		else { return .error("no reply from the agent") }
		return response
	}

	/// Runs one command and returns the process exit code.
	static func run(_ request: Request) -> Int32 {
		guard let response = send(request) else {
			FileHandle.standardError.write(Data((notRunningMessage + "\n").utf8))
			return ExitCode.agentNotRunning
		}
		switch response.status {
		case .ok:
			if let text = response.text { print(text) } else if let message = response.message, request.verb == .status {
				print(message)
			}
		case .empty:
			break
		case .error:
			FileHandle.standardError.write(Data("janet-dictate: \(response.message ?? "error")\n".utf8))
		}
		return ExitCode.forResponse(response)
	}
}
