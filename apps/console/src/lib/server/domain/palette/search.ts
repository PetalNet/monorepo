export type PaletteObjectKind = "agent" | "task" | "library" | "host" | "statistic";

export interface PaletteCandidate {
	id: string;
	kind: PaletteObjectKind;
	label: string;
	description: string;
	href: string;
	keywords?: readonly string[];
	meta?: string;
}

export interface PaletteResult extends Omit<PaletteCandidate, "keywords"> {
	score: number;
}

function normalize(value: string): string {
	return value
		.toLocaleLowerCase()
		.normalize("NFKD")
		.replaceAll(/\p{Diacritic}/gu, "");
}

/**
 * Deterministic fuzzy score for operational object names. It rewards exact words and compact
 * subsequences, while refusing weak matches so a short query never floods the launcher.
 */
function fuzzyScore(query: string, candidate: PaletteCandidate): number | null {
	const needle = normalize(query.trim());
	if (!needle) return 0;
	const primary = normalize(candidate.label);
	const haystack = normalize(
		[candidate.label, candidate.description, candidate.meta, ...(candidate.keywords ?? [])]
			.filter(Boolean)
			.join(" "),
	);
	const terms = needle.split(/\s+/).filter(Boolean);
	if (terms.some((term) => !haystack.includes(term))) {
		let cursor = 0;
		let first = -1;
		let last = -1;
		for (const character of needle.replaceAll(" ", "")) {
			cursor = haystack.indexOf(character, cursor);
			if (cursor < 0) return null;
			if (first < 0) first = cursor;
			last = cursor;
			cursor += 1;
		}
		const span = Math.max(1, last - first + 1);
		const score = 56 - span - first * 0.15;
		return score >= 16 ? score : null;
	}

	let score = 80;
	if (primary === needle) score += 120;
	else if (primary.startsWith(needle)) score += 80;
	else if (primary.includes(needle)) score += 48;
	for (const term of terms) {
		if (primary.split(/[^a-z0-9]+/).includes(term)) score += 24;
		else if (primary.includes(term)) score += 12;
	}
	return score;
}

export function rankPaletteCandidates(
	query: string,
	candidates: readonly PaletteCandidate[],
	limit = 24,
): PaletteResult[] {
	return candidates
		.flatMap((candidate) => {
			const score = fuzzyScore(query, candidate);
			return score === null ? [] : [{ ...candidate, score }];
		})
		.toSorted(
			(left, right) =>
				right.score - left.score ||
				left.label.localeCompare(right.label) ||
				left.id.localeCompare(right.id),
		)
		.slice(0, Math.min(Math.max(1, Math.floor(limit)), 32))
		.map(({ keywords: _keywords, ...result }) => result);
}
