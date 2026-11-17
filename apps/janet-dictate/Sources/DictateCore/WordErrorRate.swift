import Foundation

/// Word error rate with the same normalisation the Hex benchmark used, so numbers compare.
public enum WordErrorRate {
	static let numberWords: [String: String] = [
		"zero": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
		"six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10",
		"twenty": "20", "forty": "40", "fifty": "50", "second": "2nd",
	]

	static let joins: [(String, String)] = [
		("20 5", "25"), ("40 5", "45"), ("40 2", "42"), ("6 45", "645"), ("6:45", "645"),
		("let's", "lets"), ("st louis", "saint louis"), ("thank you", "thankyou"),
	]

	public static func normalize(_ text: String) -> [String] {
		var cleaned = ""
		for scalar in text.lowercased().unicodeScalars {
			let isWord = (scalar >= "a" && scalar <= "z") || (scalar >= "0" && scalar <= "9")
				|| scalar == "'" || scalar == " "
			cleaned.unicodeScalars.append(isWord ? scalar : " ")
		}
		let words = cleaned.split(separator: " ").map { numberWords[String($0)] ?? String($0) }
		var joined = words.joined(separator: " ")
		for (from, to) in joins { joined = joined.replacingOccurrences(of: from, with: to) }
		return joined.split(separator: " ").map(String.init)
	}

	public static func editDistance(_ reference: [String], _ hypothesis: [String]) -> Int {
		var row = Array(0...hypothesis.count)
		for (i, ref) in reference.enumerated() {
			var previous = row[0]
			row[0] = i + 1
			for (j, hyp) in hypothesis.enumerated() {
				let above = row[j + 1]
				row[j + 1] = min(above + 1, row[j] + 1, previous + (ref == hyp ? 0 : 1))
				previous = above
			}
		}
		return row[hypothesis.count]
	}

	/// Errors and reference word count for one utterance.
	public static func score(reference: String, heard: String) -> (errors: Int, words: Int) {
		let ref = normalize(reference)
		return (editDistance(ref, normalize(heard)), ref.count)
	}
}
