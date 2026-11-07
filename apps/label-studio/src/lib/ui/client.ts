/** Typed calls to the app's own /api. Failures throw an Error carrying the server's human message. */
import type {
	HistoryEntry,
	Job,
	PrintRequest,
	SourceId,
	SourceInfo,
	SourceRows,
	StatusResponse,
	TemplateInput,
} from "$lib/api";
import type { Template } from "$lib/doc";

/** The message to show for a failed call: the server's own words, else `fallback`. */
export function errorText(error: unknown, fallback: string): string {
	return error instanceof Error && error.message !== "" ? error.message : fallback;
}

async function errorMessage(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as unknown;

		if (
			typeof body === "object" &&
			body !== null &&
			"error" in body &&
			typeof body.error === "string"
		) {
			return body.error;
		}
	} catch {
		// Not JSON: fall through to the status line.
	}

	return response.status >= 500
		? "The server had a problem. Try again."
		: `Request failed (${String(response.status)})`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	let response: Response;

	try {
		response = await fetch(path, {
			...init,
			headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
		});
	} catch {
		throw new Error("Cannot reach Label Studio. Check the connection.");
	}

	if (!response.ok) {
		throw new Error(await errorMessage(response));
	}

	if (response.status === 204) {
		return undefined as T;
	}

	return (await response.json()) as T;
}

const json = (method: string, body: unknown): RequestInit => ({
	method,
	body: JSON.stringify(body),
});

export const api = {
	status: (signal?: AbortSignal) => request<StatusResponse>("/api/status", { signal }),
	templates: async () => (await request<{ templates: Template[] }>("/api/templates")).templates,
	createTemplate: async (input: TemplateInput) =>
		(await request<{ template: Template }>("/api/templates", json("POST", input))).template,
	updateTemplate: async (id: string, input: TemplateInput) =>
		(
			await request<{ template: Template }>(
				`/api/templates/${encodeURIComponent(id)}`,
				json("PUT", input),
			)
		).template,
	deleteTemplate: async (id: string) => {
		await request<unknown>(`/api/templates/${encodeURIComponent(id)}`, { method: "DELETE" });
	},
	print: async (body: PrintRequest) =>
		(await request<{ job: Job }>("/api/print", json("POST", body))).job,
	job: async (id: string, signal?: AbortSignal) =>
		(await request<{ job: Job }>(`/api/jobs/${encodeURIComponent(id)}`, { signal })).job,
	history: async (limit = 50, before?: string) => {
		const query = new URLSearchParams({ limit: String(limit) });

		if (before !== undefined) {
			query.set("before", before);
		}

		return (await request<{ entries: HistoryEntry[] }>(`/api/history?${query.toString()}`)).entries;
	},
	reprint: async (id: string) =>
		(
			await request<{ job: Job }>(`/api/history/${encodeURIComponent(id)}/reprint`, {
				method: "POST",
			})
		).job,
	sources: async () => (await request<{ sources: SourceInfo[] }>("/api/sources")).sources,
	sourceRows: (id: SourceId) => request<SourceRows>(`/api/sources/${id}`),
};

export const historyPage = (id: string, page = 0): string =>
	`/api/history/${encodeURIComponent(id)}/pages/${String(page)}.png`;
