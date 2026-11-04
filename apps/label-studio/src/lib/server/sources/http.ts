import http from "node:http";
import https from "node:https";

export type HttpResult =
	| { kind: "ok"; body: unknown }
	| { kind: "status"; status: number }
	| { kind: "unreachable" }
	| { kind: "untrusted" }
	| { kind: "unreadable" };

const TLS_ERROR = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/;

const MAX_BYTES = 16 * 1024 * 1024;

/**
 * GET a JSON document. `insecureTls` turns off certificate checks for this one request (a
 * self-signed lab appliance), never process-wide.
 */
export function getJson(
	url: string,
	options: { headers: Record<string, string>; insecureTls: boolean; timeoutMs: number },
): Promise<HttpResult> {
	const target = new URL(url);
	const client = target.protocol === "https:" ? https : http;

	return new Promise((resolve) => {
		const request = client.get(
			target,
			{
				headers: { accept: "application/json", ...options.headers },
				timeout: options.timeoutMs,
				...(target.protocol === "https:" && options.insecureTls
					? { rejectUnauthorized: false }
					: {}),
			},
			(response) => {
				const status = response.statusCode ?? 0;

				if (status < 200 || status >= 300) {
					response.resume();
					resolve({ kind: "status", status });

					return;
				}

				const chunks: Buffer[] = [];
				let size = 0;

				response.on("data", (chunk: Buffer) => {
					size += chunk.length;

					if (size > MAX_BYTES) {
						request.destroy();
						resolve({ kind: "unreadable" });

						return;
					}

					chunks.push(chunk);
				});

				response.on("end", () => {
					try {
						resolve({ kind: "ok", body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
					} catch {
						resolve({ kind: "unreadable" });
					}
				});

				response.on("error", () => {
					resolve({ kind: "unreachable" });
				});
			},
		);

		request.on("timeout", () => {
			request.destroy();
		});

		request.on("error", (error: NodeJS.ErrnoException) => {
			resolve({ kind: TLS_ERROR.test(error.code ?? "") ? "untrusted" : "unreachable" });
		});
	});
}
