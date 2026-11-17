import DictateCore
import Foundation

enum Bench {
	/// Transcribes every WAV in `directory` in one process. `refs.txt` (one line per file, in
	/// numeric file order) enables the word error rate. The first file is run once uncounted.
	static func run(directory: String, realtime: Bool) async throws {
		let url = URL(fileURLWithPath: directory)
		let files = try FileManager.default.contentsOfDirectory(atPath: directory)
			.filter { $0.hasSuffix(".wav") }
			.sorted { (Int($0.dropLast(4)) ?? 0) < (Int($1.dropLast(4)) ?? 0) }
		guard let first = files.first else { throw EngineError(description: "no .wav files in \(directory)") }
		let refs = (try? String(contentsOf: url.appendingPathComponent("refs.txt"), encoding: .utf8))?
			.split(separator: "\n").map(String.init)

		_ = try await FileTranscriber.transcribe(path: url.appendingPathComponent(first).path, realtime: false)

		var rows: [[String: Any]] = []
		var latencies: [Double] = []
		var errors = 0
		var words = 0
		for (index, name) in files.enumerated() {
			let timing = try await FileTranscriber.transcribe(
				path: url.appendingPathComponent(name).path, realtime: realtime
			)
			let measured = realtime ? timing.tailMs : timing.totalMs
			latencies.append(measured)
			var row: [String: Any] = [
				"file": name, "audio_s": round(timing.audioSeconds * 100) / 100,
				"ms": Int(measured.rounded()), "heard": timing.text,
			]
			if let refs, index < refs.count {
				let score = WordErrorRate.score(reference: refs[index], heard: timing.text)
				errors += score.errors
				words += score.words
				row["errors"] = score.errors
				row["words"] = score.words
				row["expected"] = refs[index]
			}
			rows.append(row)
		}
		let sorted = latencies.sorted()
		var summary: [String: Any] = [
			"utterances": files.count,
			"measures": realtime ? "release-to-text (audio paced at real time, ms after last audio)" : "whole file in, text out (ms)",
			"latency_ms": [
				"median": Int(sorted[sorted.count / 2].rounded()),
				"p90": Int(sorted[Int(Double(sorted.count) * 0.9)].rounded()),
				"max": Int((sorted.last ?? 0).rounded()),
				"min": Int((sorted.first ?? 0).rounded()),
			],
			"retention": "\(Engine.retention)",
			"rows": rows,
		]
		if words > 0 { summary["wer_percent"] = round(10000 * Double(errors) / Double(words)) / 100 }
		let data = try JSONSerialization.data(withJSONObject: summary, options: [.prettyPrinted, .sortedKeys])
		print(String(decoding: data, as: UTF8.self))
	}
}
