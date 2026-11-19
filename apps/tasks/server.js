// Custom adapter-node entry. Dynamic-imports the built handler so a load failure logs cleanly
// and the container exits instead of serving half an app.
import http from "node:http";

const PORT = process.env.PORT || 8896;

let handler;

try {
	({ handler } = await import("./build/handler.js"));
} catch (e) {
	console.error("FATAL: failed to load SvelteKit build handler — not starting:", e);
	process.exit(1);
}

http.createServer(handler).listen(PORT, () => console.log(`tasks (gallery) listening on :${PORT}`));
