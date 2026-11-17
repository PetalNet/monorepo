import Foundation

enum Paths {
	enum PathError: Error, CustomStringConvertible {
		case socketPathTooLong(Int, Int)
		case permissions(String)
		var description: String {
			switch self {
			case .socketPathTooLong(let length, let limit): "socket path is \(length) bytes, the limit is \(limit)"
			case .permissions(let path): "could not set permissions on \(path)"
			}
		}
	}

	static var directory: URL {
		FileManager.default.homeDirectoryForCurrentUser
			.appendingPathComponent("Library/Caches/janet-dictate", isDirectory: true)
	}

	static var socket: String { directory.appendingPathComponent("agent.sock").path }

	/// Creates the cache directory with mode 0700.
	static func prepareDirectory() throws {
		try FileManager.default.createDirectory(
			at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]
		)
		guard chmod(directory.path, 0o700) == 0 else { throw PathError.permissions(directory.path) }
	}

	static func socketAddress() throws -> sockaddr_un {
		var address = sockaddr_un()
		address.sun_family = sa_family_t(AF_UNIX)
		let bytes = Array(socket.utf8CString)
		let capacity = MemoryLayout.size(ofValue: address.sun_path)
		guard bytes.count <= capacity else { throw PathError.socketPathTooLong(bytes.count - 1, capacity - 1) }
		withUnsafeMutableBytes(of: &address.sun_path) { raw in
			for (index, byte) in bytes.enumerated() { raw[index] = UInt8(bitPattern: byte) }
		}
		return address
	}
}

/// Socket helpers that survive a peer that vanishes.
enum Sock {
	static func configure(_ fd: Int32, receiveSeconds: Int, sendSeconds: Int) {
		var one: Int32 = 1
		setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
		var receive = timeval(tv_sec: receiveSeconds, tv_usec: 0)
		setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &receive, socklen_t(MemoryLayout<timeval>.size))
		var send = timeval(tv_sec: sendSeconds, tv_usec: 0)
		setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &send, socklen_t(MemoryLayout<timeval>.size))
	}

	/// Writes all of `data`, retrying partial writes. Returns false if the peer is gone or stalled.
	@discardableResult
	static func writeAll(_ fd: Int32, _ data: Data) -> Bool {
		var offset = 0
		while offset < data.count {
			let written = data.withUnsafeBytes { raw in
				write(fd, raw.baseAddress! + offset, data.count - offset)
			}
			if written < 0 {
				if errno == EINTR { continue }
				return false
			}
			offset += written
		}
		return true
	}
}
