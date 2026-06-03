import os from "os";

import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
	const uptime = process.uptime();
	const memoryUsage = process.memoryUsage();
	const systemMemory = {
		total: os.totalmem(),
		free: os.freemem(),
	};

	return {
		process: {
			uptime,
			memory: memoryUsage,
			pid: process.pid,
			nodeVersion: process.version,
			platform: process.platform,
			arch: process.arch,
		},
		system: {
			memory: systemMemory,
			cpus: os.cpus().length,
			hostname: os.hostname(),
			type: os.type(),
			release: os.release(),
			loadavg: os.loadavg(),
		},
		environment: {
			nodeEnv: process.env.NODE_ENV || "development",
			port: process.env.PORT || "3001",
			databaseUrl: process.env.DATABASE_URL?.replace(/:[^:@]+@/, ":***@") || "Not set",
		},
	};
};
