// boot-ping: after a fresh start or resume, start one turn that just states the restart happened.
// Without it a resumed session sits idle until someone messages her; what to do about it is hers to decide.
// Fires once per process; compactions inside the same process do not re-fire it.
import type { Register } from "claude-code";

let fired = false;

export const register: Register = (on) => {
	on("session.start", async ($, e, next) => {
		const r = await next(e);

		if (fired) return r;

		fired = true;

		const version = await $.session.version().then(
			(v) => v.version,
			() => "?",
		);
		const started = new Date().toISOString();
		let done = false;

		$.clock.every(20000, async () => {
			if (done) return;

			done = true;

			try {
				await $.prompt.submit({
					text: `[boot-ping] Session restarted at ${started} on Claude Code ${version}.`,
					asUser: true,
				});
			} catch {
				// never break the session
			}
		});

		return r;
	});
};
