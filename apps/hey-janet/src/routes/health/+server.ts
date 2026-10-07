import { statfs } from "node:fs/promises";

import { root } from "#lib/server/store.ts";
export async function GET() {
	try {
		const disk = await statfs(root());
		return Response.json(
			{ ok: disk.bavail * disk.bsize >= 100_000_000 },
			{ status: disk.bavail * disk.bsize >= 100_000_000 ? 200 : 503 },
		);
	} catch {
		return Response.json({ ok: false }, { status: 503 });
	}
}
