import { tasksConfig } from "#lib/server/config.js";

export function load({ locals }) {
	const { people } = tasksConfig;

	return {
		user: locals.user,
		config: { people },
	};
}
