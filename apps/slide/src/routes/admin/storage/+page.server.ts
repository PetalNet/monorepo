import type { PageServerLoad } from "./$types";
import { promises as fs } from "fs";
import { prisma } from "$lib/server/db";

export const load: PageServerLoad = async () => {
  // Get database file size
  let dbSize = 0;
  let dbPath = "";
  try {
    dbPath =
      process.env.DATABASE_URL?.replace("file:", "") || "./prisma/dev.db";
    const stats = await fs.stat(dbPath);
    dbSize = stats.size;
  } catch (error) {
    console.error("Error reading database size:", error);
  }

  // Get record counts
  const counts = {
    users: await prisma.user.count(),
    events: await prisma.event.count(),
    groups: await prisma.group.count(),
    votes: await prisma.vote.count(),
    sessions: await prisma.session.count(),
    judges: await prisma.judge.count(),
    categories: await prisma.category.count(),
    ratings: await prisma.rating.count(),
  };

  // Calculate estimated sizes (rough approximation)
  const avgRecordSize = 1024; // 1KB average per record
  const totalRecords = Object.values(counts).reduce((a, b) => a + b, 0);
  const estimatedDataSize = totalRecords * avgRecordSize;

  return {
    database: {
      path: dbPath,
      size: dbSize,
      recordCounts: counts,
      totalRecords,
      estimatedDataSize,
      overhead: dbSize - estimatedDataSize,
    },
  };
};
