// Custom adapter-node entry: serves the SvelteKit app AND proxies the fleet-terminal
// websocket (#547). WebSockets can't be a SvelteKit +server endpoint, so the proxy lives
// here at the HTTP-upgrade layer. It bridges ttyd's framed protocol (1-byte command prefix)
// to a RAW byte stream for the ghostty-web client.
//
// SECURITY — this is a shell into the live agent session (root-equivalent), so TWO independent
// gates, neither sufficient alone (per adversarial review):
//   GATE 1  x-term-proxy-secret — injected ONLY by Traefik (customRequestHeaders), so a direct
//           off-Traefik request to :8896 (host loopback / bridge IP 172.16.46.2 / host-net
//           container) can't reach the proxy even WITH a spoofed x-authentik-username. Checked first.
//   GATE 2  ttyd itself requires a credential (AuthToken = TERM_WS_SECRET); a direct ws to the
//           ttyd container's bridge port (172.16.46.{3,4}) is denied — the proxy isn't the only
//           network path to those ports, so they can't be an unauthenticated shell.
//   Identity: x-authentik-username (Traefik forward-auth). rw=ADMIN, ro=ALLOW. Fail-closed.
//   Audit: every session -> term_audit; rw keystrokes -> term_audit_input (batched).
import http from "node:http";

import Database from "better-sqlite3";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 8896;
const ALLOW = (process.env.ALLOW || "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
const ADMIN = (process.env.TERM_ADMIN || "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
const WS_SECRET = process.env.TERM_WS_SECRET || ""; // ttyd -c credential password (username is 'term')
// ttyd's credential = base64("term:<secret>"); it's required BOTH as the Basic upgrade header
// (no header -> ttyd drops the ws) AND as the init-frame AuthToken (empty token -> no shell).
// Verified empirically against ttyd 1.7.7 (no header => socket hang up; header+token => shell).
const WS_AUTH = WS_SECRET ? Buffer.from("term:" + WS_SECRET).toString("base64") : "";
const PROXY_SECRET = process.env.TERM_PROXY_SECRET || ""; // Traefik-injected header gate
const MAX_WS = Number(process.env.TERM_MAX_WS || 8);
const IDLE_MS = Number(process.env.TERM_IDLE_MS || 30 * 60 * 1000);
const TTYD = {
	ro: process.env.TTYD_RO || "ws://tasks-ttyd-ro:7681/ws",
	rw: process.env.TTYD_RW || "ws://tasks-ttyd-rw:7682/ws",
};

// --- audit store (own sqlite handle; the SvelteKit app reads it via db.js, same file) ---
const audit = (() => {
	try {
		const db = new Database(process.env.TASKS_DB_PATH || "/data/tasks.db");

		db.pragma("journal_mode = WAL");

		db.exec(`
      CREATE TABLE IF NOT EXISTS term_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT, mode TEXT,
        connect_ts INTEGER, disconnect_ts INTEGER, client_ip TEXT, user_agent TEXT);
      CREATE TABLE IF NOT EXISTS term_audit_input (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER, ts INTEGER, data TEXT);`);

		const ins = db.prepare(
			"INSERT INTO term_audit (user,mode,connect_ts,client_ip,user_agent) VALUES (?,?,?,?,?)",
		);
		const cls = db.prepare("UPDATE term_audit SET disconnect_ts=? WHERE id=?");
		const inp = db.prepare("INSERT INTO term_audit_input (session_id,ts,data) VALUES (?,?,?)");

		return {
			open: (user, mode, ip, ua) =>
				ins.run(user, mode, Date.now(), ip || "", ua || "").lastInsertRowid,
			close: (id) => {
				try {
					if (id) cls.run(Date.now(), id);
				} catch {}
			},
			input: (id, data) => {
				try {
					if (id && data) inp.run(id, Date.now(), data);
				} catch {}
			},
		};
	} catch (e) {
		console.error("term audit init failed (continuing without audit):", e.message);

		return { open: () => null, close: () => {}, input: () => {} };
	}
})();

// resilient bootstrap: dynamic-import the built handler so a load failure logs cleanly
// instead of an opaque crash-loop of the live tracker.
let handler;

try {
	({ handler } = await import("./build/handler.js"));
} catch (e) {
	console.error("FATAL: failed to load SvelteKit build handler — not starting:", e);
	process.exit(1);
}

const server = http.createServer(handler);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
let liveWs = 0;

function deny(socket, code, msg) {
	try {
		socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);
	} catch {}

	socket.destroy();
}

server.on("upgrade", (req, socket, head) => {
	let url;

	try {
		url = new URL(req.url, "http://x");
	} catch {
		return socket.destroy();
	}

	const m = url.pathname.match(/^\/api\/fleet\/term\/(ro|rw)$/);

	if (!m) return; // not a terminal ws — no other upgrade route

	const mode = m[1];

	// GATE 1: Traefik-injected secret. Blocks any off-Traefik direct hit to :8896, so a spoofed
	// x-authentik-username on loopback/bridge can't reach the proxy.
	if (!PROXY_SECRET || req.headers["x-term-proxy-secret"] !== PROXY_SECRET)
		return deny(socket, 403, "Forbidden");

	// GATE 2 (identity): rw demands ADMIN; ro demands an ALLOW user (any authed if no ALLOW). Fail-closed.
	const user = String(req.headers["x-authentik-username"] || "");
	const ok = mode === "rw" ? ADMIN.includes(user) : ALLOW.length ? ALLOW.includes(user) : !!user;

	if (!ok) return deny(socket, 403, "Forbidden");

	if (liveWs >= MAX_WS) return deny(socket, 503, "Service Unavailable");

	const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")
		.split(",")[0]
		.trim();
	const ua = String(req.headers["user-agent"] || "").slice(0, 300);

	wss.handleUpgrade(req, socket, head, (client) => bridge(client, mode, user, ip, ua));
});

const TTYD_OUTPUT = 0x30; // ttyd server->client: terminal output
const TTYD_INPUT = Buffer.from("0"); // client->ttyd: stdin
const TTYD_RESIZE = "1"; // client->ttyd: resize

function bridge(client, mode, user, ip, ua) {
	liveWs++;
	const auditId = audit.open(user, mode, ip, ua);
	let inbuf = ""; // batch rw keystrokes; flush periodically + on close (don't hammer the DB)
	const flush = () => {
		if (inbuf) {
			audit.input(auditId, inbuf);
			inbuf = "";
		}
	};

	const flushTimer = setInterval(flush, 2000);

	// ttyd needs the 'tty' subprotocol (no subprotocol -> no shell), the Basic auth header (no
	// header -> ttyd drops the ws), AND the matching AuthToken in the init frame below. All three.
	const upstream = new WebSocket(TTYD[mode], ["tty"], {
		perMessageDeflate: false,
		headers: WS_AUTH ? { Authorization: "Basic " + WS_AUTH } : {},
	});
	let upOpen = false;
	let idleTimer = setTimeout(() => {
		try {
			client.close(4408, "idle");
		} catch {}
	}, IDLE_MS);
	const bump = () => {
		clearTimeout(idleTimer);

		idleTimer = setTimeout(() => {
			try {
				client.close(4408, "idle");
			} catch {}
		}, IDLE_MS);
	};

	const ping = setInterval(() => {
		if (client.readyState === WebSocket.OPEN) client.ping();
	}, 30000);

	upstream.on("open", () => {
		upOpen = true;
		upstream.send(Buffer.from(JSON.stringify({ AuthToken: WS_AUTH, columns: 120, rows: 32 }))); // binary init frame
	});

	upstream.on("message", (data) => {
		const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

		if (buf.length && buf[0] === TTYD_OUTPUT && client.readyState === WebSocket.OPEN)
			client.send(buf.subarray(1));
	});

	client.on("message", (data, isBinary) => {
		if (!upOpen) return;

		bump();

		if (isBinary) {
			if (mode === "rw") {
				// ro NEVER forwards input (server-side gate on top of ttyd attach -r)
				const b = Buffer.isBuffer(data) ? data : Buffer.from(data);

				upstream.send(Buffer.concat([TTYD_INPUT, b]));
				inbuf += b.toString("utf8"); // accountability: keystroke capture (intentionally records sensitive input)

				if (inbuf.length > 4096) flush();
			}
		} else {
			try {
				const j = JSON.parse(data.toString());

				if (
					j?.type === "resize" &&
					Number.isInteger(j.cols) &&
					j.cols >= 1 &&
					j.cols <= 1000 &&
					Number.isInteger(j.rows) &&
					j.rows >= 1 &&
					j.rows <= 1000
				) {
					upstream.send(TTYD_RESIZE + JSON.stringify({ columns: j.cols, rows: j.rows }));
				}
			} catch {
				/* ignore malformed control frames */
			}
		}
	});

	let closed = false;
	const close = () => {
		if (closed) return;

		closed = true;
		clearTimeout(idleTimer);
		clearInterval(ping);
		clearInterval(flushTimer);
		flush();
		audit.close(auditId);
		liveWs = Math.max(0, liveWs - 1);

		try {
			client.close();
		} catch {}

		try {
			upstream.close();
		} catch {}
	};

	client.on("close", close);
	client.on("error", close);
	upstream.on("close", close);

	upstream.on("error", () => {
		if (client.readyState === WebSocket.OPEN) client.close(1011);

		close();
	});
}

server.listen(PORT, () =>
	console.log(`tasks (svelte handler + fleet-term ws proxy) listening on :${PORT}`),
);
