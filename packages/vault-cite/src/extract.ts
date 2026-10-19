import { execFile } from "node:child_process";
/* oxlint-disable eslint/no-await-in-loop -- Pages are processed sequentially to bound OCR memory and disk use. */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { CaptureError } from "./model.ts";
import type { Source } from "./model.ts";
import { decoded } from "./network.ts";
import { diskGuard } from "./store.ts";
import type { Store } from "./store.ts";

const exec = promisify(execFile);

export async function extract(source: Source, store: Store, lease: number) {
	const original = source.artifacts[0];

	if (original?.role !== "ORIGINAL") {
		throw new Error("Missing original");
	}

	const artifact =
		original.mime === "text/html"
			? source.artifacts.find((item) => item.role === "DERIVED" && item.mime === "application/pdf")
			: original;

	if (!artifact) {
		throw new CaptureError("FAILED", "No supported text extractor for this original");
	}

	const bytes = readFileSync(path.join(store.root, artifact.path));

	if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
		throw new CaptureError("FAILED", "Stored artifact checksum mismatch");
	}

	const body = decoded({
		url: source.final_url,
		status: source.http_status,
		headers: {
			"content-encoding":
				artifact.role === "ORIGINAL" ? artifact.retrieval.content_encoding : "identity",
		},
		body: bytes,
	});

	if (artifact.mime.startsWith("text/") || artifact.mime === "application/json") {
		return [{ page: 1, text: body.toString("utf8"), method: "utf8" }];
	}

	const dir = mkdtempSync(path.join(store.root, ".extract-"));
	const input = path.join(dir, "source");

	try {
		diskGuard(store.root, body.length);
		writeFileSync(input, body, { mode: 0o600 });

		if (artifact.mime === "application/gzip" && source.canonical_id.startsWith("github:")) {
			const { stdout: names } = await exec("tar", ["-tzf", input], {
				timeout: 30_000,
				maxBuffer: 2 * 1024 ** 2,
			});
			const files = names
				.split("\n")
				.filter((name) => /^[^/]+\/(?:README[^/]*|LICENSE[^/]*)$/i.test(name))
				.slice(0, 10);
			const pages = [];

			for (const name of files) {
				const { stdout: text } = await exec("tar", ["-xOzf", input, "--", name], {
					timeout: 10_000,
					maxBuffer: 1024 ** 2,
				});

				pages.push({ page: pages.length + 1, text, method: `tar:${name}` });
			}

			return pages.length > 0 ? pages : [{ page: 1, text: names, method: "tar-list" }];
		}

		if (artifact.mime !== "application/pdf") {
			throw new CaptureError("FAILED", "No supported text extractor for this original");
		}

		const { stdout: info } = await exec("pdfinfo", [input], { timeout: 10_000, maxBuffer: 65536 });

		if (original.mime === "application/pdf") {
			const title = /^Title:[ \t]*([^\s][^\r\n]*)$/m.exec(info)?.[1]?.trim();
			const author = /^Author:[ \t]*([^\s][^\r\n]*)$/m.exec(info)?.[1]?.trim();

			store.projectPdfMetadata(source, { title: title ?? null, author: author ?? null }, lease);
		}

		const count = Number(/^Pages:\s+(\d+)$/m.exec(info)?.[1]);

		if (!Number.isSafeInteger(count) || count < 1 || count > 500) {
			throw new CaptureError("FAILED", "PDF page count unavailable or exceeds 500-page limit");
		}

		const pages = [];
		const deadline = Date.now() + 10 * 60_000;
		let textBytes = 0;

		for (let page = 1; page <= count; page++) {
			if (Date.now() > deadline) {
				throw new CaptureError("FAILED", "Extraction exceeded ten-minute limit");
			}

			diskGuard(store.root, 64 * 1024 ** 2);

			const native = await exec(
				"pdftotext",
				// oxlint-disable-next-line unicorn/text-encoding-identifier-case -- Poppler names this encoding UTF-8.
				["-f", String(page), "-l", String(page), "-enc", "UTF-8", input, "-"],
				{ timeout: 30_000, maxBuffer: 2 * 1024 ** 2 },
			);
			let text = native.stdout.trim();
			let method = "pdftotext";

			if (!text) {
				const prefix = path.join(dir, "page");

				await exec(
					"pdftoppm",
					[
						"-f",
						String(page),
						"-l",
						String(page),
						"-singlefile",
						"-scale-to",
						"2400",
						"-png",
						input,
						prefix,
					],
					{ timeout: 30_000, maxBuffer: 65536 },
				);

				const ocr = await exec("tesseract", [`${prefix}.png`, "stdout", "-l", "eng"], {
					timeout: 30_000,
					maxBuffer: 2 * 1024 ** 2,
				});

				text = ocr.stdout.trim();
				method = "tesseract-eng";
				unlinkSync(`${prefix}.png`);
			}

			textBytes += Buffer.byteLength(text);

			if (textBytes > 16 * 1024 ** 2) {
				throw new CaptureError("FAILED", "Extracted text exceeds 16 MiB limit");
			}

			pages.push({ page, text, method });
		}

		return pages;
	} finally {
		rmSync(dir, { recursive: true });
	}
}
