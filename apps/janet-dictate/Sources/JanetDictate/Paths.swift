import Foundation

enum Paths {
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
		chmod(directory.path, 0o700)
	}

	static func socketAddress() -> sockaddr_un {
		var address = sockaddr_un()
		address.sun_family = sa_family_t(AF_UNIX)
		let bytes = Array(socket.utf8CString)
		withUnsafeMutableBytes(of: &address.sun_path) { raw in
			for (index, byte) in bytes.prefix(raw.count - 1).enumerated() { raw[index] = UInt8(bitPattern: byte) }
		}
		return address
	}
}
