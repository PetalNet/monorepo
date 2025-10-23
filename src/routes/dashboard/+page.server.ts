import { redirect } from "@sveltejs/kit";
import { prisma } from "$lib/server/db";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ parent }) => {
  const { user } = await parent();

  if (!user) {
    throw redirect(303, "/auth/login");
  }

  // Get user's hosted events
  const hostedEvents = await prisma.event.findMany({
    where: { hostId: user.id },
    select: {
      id: true,
      name: true,
      theme: true,
      description: true,
      joinCode: true,
      status: true,
      currentPresentationId: true,
      createdAt: true,
      submissionDeadline: true,
      groups: true,
      categories: true,
    },
    orderBy: { createdAt: "desc" },
  });

  // Get user's group memberships
  const groupMemberships = await prisma.groupMember.findMany({
    where: { userId: user.id },
    include: {
      group: {
        include: {
          event: {
            select: {
              id: true,
              name: true,
              joinCode: true,
              status: true,
              currentPresentationId: true,
              submissionDeadline: true,
              timezone: true,
            },
          },
          members: {
            include: {
              user: true,
            },
          },
        },
      },
    },
    orderBy: { joinedAt: "desc" },
  });

  return {
    hostedEvents,
    groupMemberships,
  };
};
