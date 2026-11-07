/**
 * The HTTP contract between the browser, agents and the server routes under /api. Request bodies
 * are JSON; errors are `{ error: string }` with a 4xx/5xx status and a message a person can act on
 * ("Cover open", not "HTTP 400").
 */
import type { LabelDoc, TapeGeometry, Template, TemplateField, Vars } from "$lib/doc";

/** GET /api/status */
export type PrinterState =
	| { state: "ready"; tape: TapeGeometry }
	/** The printer answered but cannot print: "No tape", "Cover open", "Wrong tape"… */
	| { state: "error"; message: string; tape: TapeGeometry | null }
	/** The print daemon or the printer is unreachable. */
	| { state: "offline"; message: string };

export interface StatusResponse {
	printer: PrinterState;
	queue: { pending: number; current: Job | null };
}

/** A design is either an inline document or a stored template, by id or name. */
export type DesignRef = { doc: LabelDoc } | { template: string };

/**
 * Variables for one label (`vars`) or one label per row (`rows`). Each row is merged over `vars`,
 * which is merged over the template's field defaults.
 */
export type RenderRequest = DesignRef & { vars?: Vars; rows?: Vars[] };

/** POST /api/render. `GET`-style single PNG: POST /api/render.png with the same body. */
export interface RenderResponse {
	tape: TapeGeometry;
	pages: RenderedPage[];
}

export interface RenderedPage {
	/** Data:image/png;base64 of the exact 128-dot-high printer raster. */
	png: string;
	lengthDots: number;
	lengthMm: number;
	vars: Vars;
	warnings: string[];
}

/** POST /api/print → 202 { job } */
export type PrintRequest = RenderRequest & {
	copies?: number;
	/** Cut after every label (default true). False runs the batch as one strip. */
	cut?: boolean;
	/** Skip the final feed and cut, saving tape before the next job (default false). */
	chain?: boolean;
	/** Render, queue and record the job, but do not send it to the printer. */
	dryRun?: boolean;
	/** Shown in the queue and history; defaults to the template name or first text. */
	title?: string;
};

export type JobStatus = "queued" | "printing" | "done" | "failed";

export interface Job {
	id: string;
	historyId: string;
	title: string;
	status: JobStatus;
	error?: string;
	pages: number;
	copies: number;
	lengthMm: number;
	dryRun: boolean;
	createdAt: string;
	finishedAt?: string;
}

/** GET /api/jobs → { jobs }, GET /api/jobs/:id → { job } */
export interface JobResponse {
	job: Job;
}

/**
 * GET /api/history?limit=&before= → { entries } GET /api/history/:id → { entry } GET
 * /api/history/:id/pages/:n.png → the stored raster POST /api/history/:id/reprint → 202 { job }
 */
export interface HistoryEntry {
	id: string;
	createdAt: string;
	title: string;
	templateId: string | null;
	doc: LabelDoc;
	rows: Vars[];
	tapeMm: number;
	pages: number;
	copies: number;
	lengthMm: number;
	cut: boolean;
	chain: boolean;
	dryRun: boolean;
	status: JobStatus;
	error?: string;
}

/**
 * GET /api/templates → { templates } POST /api/templates (TemplateInput) → 201 { template }
 * GET|PUT|DELETE /api/templates/:id; built-ins are read-only (PUT/DELETE → 409).
 */
export interface TemplateInput {
	name: string;
	category: Template["category"];
	description: string;
	doc: LabelDoc;
	fields: TemplateField[];
}

export type SourceId = "proxmox" | "truenas" | "hass";

/** GET /api/sources → { sources } */
export interface SourceInfo {
	id: SourceId;
	label: string;
	/** False when its environment configuration is missing; the UI explains how to set it. */
	configured: boolean;
}

/** GET /api/sources/:id → SourceRows, or 502 { error } when the source fails. */
export interface SourceRows {
	columns: { key: string; label: string }[];
	rows: Vars[];
	fetchedAt: string;
}
