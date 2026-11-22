export function nextCatalogNumber({
	typeId,
	varietyId,
	relics,
	ranges,
}: {
	typeId: number;
	varietyId: number;
	relics: ReadonlyArray<{
		typeId: number | null;
		varietyId: number | null;
		indexNumber: number | null;
	}>;
	ranges: ReadonlyArray<{
		typeId: number;
		varietyId: number;
		startIndex: number | null;
		endIndex: number | null;
	}>;
}) {
	return (
		Math.max(
			-1,
			...relics
				.filter((r) => r.typeId === typeId && r.varietyId === varietyId)
				.map((r) => r.indexNumber ?? -1),
			...ranges
				.filter(
					(r) =>
						r.typeId === typeId &&
						r.varietyId === varietyId &&
						r.startIndex !== null &&
						r.endIndex !== null,
				)
				.map((r) => r.endIndex ?? -1),
		) + 1
	);
}
