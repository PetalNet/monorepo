import type { QueryRequest } from "./structured.ts";

export type BranchFilterValue = string | number | boolean;

/** Deterministic drill-through: preserve the stored query and add the selected dimension filter. */
export function branchQuery(
	request: QueryRequest,
	field: string,
	value: BranchFilterValue,
): QueryRequest {
	return {
		...structuredClone(request),
		where: { ...request.where, [field]: value },
	};
}
