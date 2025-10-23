import type { PageServerLoad } from "./$types";
import { prisma } from "$lib/server/db";

export const load: PageServerLoad = async () => {
  const events = await prisma.event.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      host: {
        select: {
          name: true,
          email: true,
        },
      },
      _count: {
        select: {
          groups: true,
          votes: true,
          judges: true,
        },
      },
    },
  });

  return { events };
};
