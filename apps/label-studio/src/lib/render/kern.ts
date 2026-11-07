/**
 * Pair kerning read straight from a font's GPOS table. opentype.js 1.3 skips GPOS extension lookups
 * (type 9), which is where Inter and Source Serif keep their kerning, so it reports zero kerning
 * for them.
 */
export type Kerning = (left: number, right: number) => number;

const NO_KERNING: Kerning = () => 0;

type PairSubtable =
	| { format: 1; coverage: Map<number, number>; pairs: Map<number, number>[] }
	| {
			format: 2;
			coverage: Map<number, number>;
			class1: Map<number, number>;
			class2: Map<number, number>;
			class2Count: number;
			values: Int16Array;
	  };

/** Read the kerning from TTF, OTF or WOFF bytes. Fonts without GPOS pair kerning get none. */
export async function readKerning(bytes: ArrayBuffer): Promise<Kerning> {
	const gpos = await tableBytes(bytes, "GPOS");

	if (!gpos) {
		return NO_KERNING;
	}

	const lookups = parseGpos(gpos);

	if (lookups.length === 0) {
		return NO_KERNING;
	}

	return (left, right) => {
		let total = 0;

		for (const subtables of lookups) {
			for (const sub of subtables) {
				const index = sub.coverage.get(left);

				if (index === undefined) {
					continue;
				}

				if (sub.format === 1) {
					const value = sub.pairs[index].get(right);

					if (value === undefined) {
						continue;
					}

					total += value;
				} else {
					const c1 = sub.class1.get(left) ?? 0;
					const c2 = sub.class2.get(right) ?? 0;

					total += sub.values[c1 * sub.class2Count + c2];
				}

				break;
			}
		}

		return total;
	};
}

const tag = (view: DataView, offset: number): string =>
	String.fromCodePoint(
		view.getUint8(offset),
		view.getUint8(offset + 1),
		view.getUint8(offset + 2),
		view.getUint8(offset + 3),
	);

async function tableBytes(bytes: ArrayBuffer, name: string): Promise<DataView | null> {
	const view = new DataView(bytes);
	const woff = tag(view, 0) === "wOFF";
	const count = view.getUint16(woff ? 12 : 4);
	const [first, size] = woff ? [44, 20] : [12, 16];
	let record = -1;

	for (let i = 0; i < count && record < 0; i++) {
		if (tag(view, first + i * size) === name) {
			record = first + i * size;
		}
	}

	if (record < 0) {
		return null;
	}

	if (!woff) {
		return new DataView(bytes, view.getUint32(record + 8), view.getUint32(record + 12));
	}

	const offset = view.getUint32(record + 4);
	const compressed = view.getUint32(record + 8);

	if (compressed === view.getUint32(record + 12)) {
		return new DataView(bytes, offset, compressed);
	}

	const stream = new Blob([new Uint8Array(bytes, offset, compressed)])
		.stream()
		.pipeThrough(new DecompressionStream("deflate"));

	return new DataView(await new Response(stream).arrayBuffer());
}

function parseGpos(view: DataView): PairSubtable[][] {
	const featureList = view.getUint16(6);
	const lookupList = view.getUint16(8);
	const kernLookups = new Set<number>();
	const featureCount = view.getUint16(featureList);

	for (let i = 0; i < featureCount; i++) {
		const record = featureList + 2 + i * 6;

		if (tag(view, record) !== "kern") {
			continue;
		}

		const feature = featureList + view.getUint16(record + 4);
		const count = view.getUint16(feature + 2);

		for (let j = 0; j < count; j++) {
			kernLookups.add(view.getUint16(feature + 4 + j * 2));
		}
	}

	return [...kernLookups]
		.toSorted((a, b) => a - b)
		.map((index) => {
			const lookup = lookupList + view.getUint16(lookupList + 2 + index * 2);
			const type = view.getUint16(lookup);
			const count = view.getUint16(lookup + 4);
			const subtables: PairSubtable[] = [];

			for (let i = 0; i < count; i++) {
				let offset = lookup + view.getUint16(lookup + 6 + i * 2);
				let subtype = type;

				if (type === 9) {
					subtype = view.getUint16(offset + 2);
					offset += view.getUint32(offset + 4);
				}

				if (subtype === 2) {
					subtables.push(parsePairPos(view, offset));
				}
			}

			return subtables;
		})
		.filter((subtables) => subtables.length > 0);
}

const bitCount = (value: number): number => {
	let count = 0;

	for (let bits = value; bits; bits >>= 1) {
		count += bits & 1;
	}

	return count;
};

/** Byte offset of XAdvance inside a value record, or -1 when the format has none. */
const xAdvanceOffset = (format: number): number => (format & 4 ? bitCount(format & 3) * 2 : -1);

function parsePairPos(view: DataView, offset: number): PairSubtable {
	const format = view.getUint16(offset);
	const coverage = parseCoverage(view, offset + view.getUint16(offset + 2));
	const format1 = view.getUint16(offset + 4);
	const format2 = view.getUint16(offset + 6);
	const size1 = bitCount(format1) * 2;
	const size2 = bitCount(format2) * 2;
	const advance = xAdvanceOffset(format1);
	const read = (at: number): number => (advance < 0 ? 0 : view.getInt16(at + advance));

	if (format === 1) {
		const count = view.getUint16(offset + 8);
		const pairs = Array.from({ length: count }, (_, i) => {
			const set = offset + view.getUint16(offset + 10 + i * 2);
			const values = new Map<number, number>();
			const records = view.getUint16(set);

			for (let j = 0; j < records; j++) {
				const record = set + 2 + j * (2 + size1 + size2);

				values.set(view.getUint16(record), read(record + 2));
			}

			return values;
		});

		return { format: 1, coverage, pairs };
	}

	const class1 = parseClassDef(view, offset + view.getUint16(offset + 8));
	const class2 = parseClassDef(view, offset + view.getUint16(offset + 10));
	const class1Count = view.getUint16(offset + 12);
	const class2Count = view.getUint16(offset + 14);
	const values = new Int16Array(class1Count * class2Count);

	for (let i = 0; i < values.length; i++) {
		values[i] = read(offset + 16 + i * (size1 + size2));
	}

	return { format: 2, coverage, class1, class2, class2Count, values };
}

function parseCoverage(view: DataView, offset: number): Map<number, number> {
	const out = new Map<number, number>();
	const count = view.getUint16(offset + 2);

	if (view.getUint16(offset) === 1) {
		for (let i = 0; i < count; i++) {
			out.set(view.getUint16(offset + 4 + i * 2), i);
		}

		return out;
	}

	for (let i = 0; i < count; i++) {
		const range = offset + 4 + i * 6;
		const start = view.getUint16(range);
		const end = view.getUint16(range + 2);
		const first = view.getUint16(range + 4);

		for (let glyph = start; glyph <= end; glyph++) {
			out.set(glyph, first + glyph - start);
		}
	}

	return out;
}

function parseClassDef(view: DataView, offset: number): Map<number, number> {
	const out = new Map<number, number>();

	if (view.getUint16(offset) === 1) {
		const start = view.getUint16(offset + 2);
		const count = view.getUint16(offset + 4);

		for (let i = 0; i < count; i++) {
			out.set(start + i, view.getUint16(offset + 6 + i * 2));
		}

		return out;
	}

	const count = view.getUint16(offset + 2);

	for (let i = 0; i < count; i++) {
		const range = offset + 4 + i * 6;
		const end = view.getUint16(range + 2);
		const value = view.getUint16(range + 4);

		for (let glyph = view.getUint16(range); glyph <= end; glyph++) {
			out.set(glyph, value);
		}
	}

	return out;
}
