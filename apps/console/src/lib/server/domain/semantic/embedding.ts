import { createHash } from "node:crypto";

const EMBEDDING_DIMENSIONS = 384;
export const EMBEDDING_MODEL = "feature-hash-v1";

/**
 * Hermetic local text embedding based on signed feature hashing. Namespace pieces, words, and
 * character trigrams share a normalized vector, giving the semantic corpus useful lexical and
 * near-token retrieval without an external model or network dependency.
 */
export function embedText(text: string): number[] {
	const normalized = text.toLowerCase().normalize("NFKC");
	const words = normalized.split(/[^a-z0-9]+/).filter(Boolean);
	const features = [...words];
	for (const word of words) {
		const padded = `^${word}$`;
		for (let i = 0; i + 3 <= padded.length; i += 1) features.push(padded.slice(i, i + 3));
	}
	const vector = Array<number>(EMBEDDING_DIMENSIONS).fill(0);
	for (const feature of features) {
		const digest = createHash("sha256").update(feature).digest();
		const index = digest.readUInt16BE(0) % EMBEDDING_DIMENSIONS;
		vector[index] = (vector[index] ?? 0) + (digest[2] & 1 ? 1 : -1);
	}
	const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
	if (norm === 0) return vector;
	return vector.map((value) => Number((value / norm).toFixed(8)));
}

export function vectorLiteral(vector: readonly number[]): string {
	if (vector.length !== EMBEDDING_DIMENSIONS || vector.some((value) => !Number.isFinite(value)))
		throw new Error("invalid embedding vector");
	return `[${vector.join(",")}]`;
}
