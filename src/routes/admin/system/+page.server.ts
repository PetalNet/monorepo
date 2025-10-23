import type { PageServerLoad } from './$types';
import os from 'os';
import { prisma } from '$lib/server/db';

export const load: PageServerLoad = async () => {
	const uptime = process.uptime();
	const memoryUsage = process.memoryUsage();
	const systemMemory = {
		total: os.totalmem(),
		free: os.freemem()
	};

	// Get database stats
	const activeConnections = prisma.$queryRawUnsafe<Array<{ connections: number }>>(
		`SELECT COUNT(*) as connections FROM pragma_database_list`
	).catch(() => [{ connections: 1 }]);

	return {
		process: {
			uptime,
			memory: memoryUsage,
			pid: process.pid,
			nodeVersion: process.version,
			platform: process.platform,
			arch: process.arch
		},
		system: {
			memory: systemMemory,
			cpus: os.cpus().length,
			hostname: os.hostname(),
			type: os.type(),
			release: os.release(),
			loadavg: os.loadavg()
		},
		environment: {
			nodeEnv: process.env.NODE_ENV || 'development',
			port: process.env.PORT || '3001',
			databaseUrl: process.env.DATABASE_URL?.replace(/:[^:@]+@/, ':***@') || 'Not set'
		}
	};
};
