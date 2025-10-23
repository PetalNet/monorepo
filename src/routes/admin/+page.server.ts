import type { PageServerLoad } from './$types';
import { prisma } from '$lib/server/db';
import { promises as fs } from 'fs';
import os from 'os';

export const load: PageServerLoad = async () => {
	// Get database stats
	const userCount = await prisma.user.count();
	const eventCount = await prisma.event.count();
	const groupCount = await prisma.group.count();
	const voteCount = await prisma.vote.count();

	// Get recent users
	const recentUsers = await prisma.user.findMany({
		take: 5,
		orderBy: { createdAt: 'desc' },
		select: {
			id: true,
			email: true,
			name: true,
			createdAt: true
		}
	});

	// Get active events
	const activeEvents = await prisma.event.findMany({
		where: {
			status: { in: ['setup', 'live', 'voting'] }
		},
		take: 5,
		orderBy: { updatedAt: 'desc' },
		select: {
			id: true,
			name: true,
			status: true,
			updatedAt: true,
			_count: {
				select: {
					groups: true,
					votes: true
				}
			}
		}
	});

	// Get storage info
	let dbSize = 0;
	try {
		const dbPath = process.env.DATABASE_URL?.replace('file:', '') || './prisma/dev.db';
		const stats = await fs.stat(dbPath);
		dbSize = stats.size;
	} catch (error) {
		console.error('Error reading database size:', error);
	}

	// Get system info
	const uptime = process.uptime();
	const memoryUsage = process.memoryUsage();
	const systemMemory = {
		total: os.totalmem(),
		free: os.freemem()
	};

	return {
		stats: {
			users: userCount,
			events: eventCount,
			groups: groupCount,
			votes: voteCount
		},
		recentUsers,
		activeEvents,
		storage: {
			database: dbSize
		},
		system: {
			uptime: Math.floor(uptime),
			memory: {
				process: memoryUsage,
				system: systemMemory
			},
			nodeVersion: process.version,
			platform: process.platform
		}
	};
};
