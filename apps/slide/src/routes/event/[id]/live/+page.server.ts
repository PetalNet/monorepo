import { error, redirect } from "@sveltejs/kit";
import { prisma } from "$lib/server/db";
import type { PageServerLoad, Actions } from "./$types";
import { nanoid } from "nanoid";

export const load: PageServerLoad = async ({ params, locals, url }) => {
  const event = await prisma.event.findUnique({
    where: { id: params.id },
    include: {
      host: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
      categories: {
        orderBy: { order: "asc" },
      },
      groups: {
        where: {
          status: "submitted",
        },
        include: {
          members: {
            include: {
              user: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                },
              },
            },
          },
        },
      },
      presentationOrder: {
        include: {
          group: {
            include: {
              members: {
                include: {
                  user: {
                    select: {
                      id: true,
                      name: true,
                    },
                  },
                },
              },
            },
          },
        },
        orderBy: {
          position: "asc",
        },
      },
      judges: true,
    },
  });

  if (!event) {
    throw error(404, "Event not found");
  }

  // Get ordered groups
  let orderedGroups = event.presentationOrder.map((po) => po.group);
  if (orderedGroups.length === 0) {
    orderedGroups = event.groups;
  }

  const isHost = locals.user && event.hostId === locals.user.id;

  // Check for voting session cookie
  const sessionCode = url.searchParams.get("session");
  let votingSession = null;

  if (sessionCode && !locals.user) {
    votingSession = await prisma.votingSession.findUnique({
      where: { sessionCode },
    });

    if (votingSession && votingSession.eventId === event.id) {
      await prisma.votingSession.update({
        where: { id: votingSession.id },
        data: { lastActive: new Date() },
      });
    }
  }

  // If event is still in setup and host is viewing, transition to live
  if (event.status === "setup" && isHost) {
    await prisma.event.update({
      where: { id: event.id },
      data: {
        status: "live",
      },
    });
    event.status = "live";
  }

  return {
    event,
    orderedGroups,
    isHost: !!isHost,
    votingSession,
    currentUser: locals.user,
  };
};

export const actions: Actions = {
  createVotingSession: async ({ request, params }) => {
    const data = await request.formData();
    const displayName = data.get("displayName") as string;

    if (!displayName || displayName.trim().length === 0) {
      return { error: "Display name is required" };
    }

    const sessionCode = nanoid(10);

    const session = await prisma.votingSession.create({
      data: {
        eventId: params.id,
        displayName: displayName.trim(),
        sessionCode,
      },
    });

    return { success: true, sessionCode: session.sessionCode };
  },

  submitVote: async ({ request, params, locals, url }) => {
    const data = await request.formData();
    const groupId = data.get("groupId") as string;
    const ratingsJson = data.get("ratings") as string;
    const sessionCode = url.searchParams.get("session");

    if (!groupId || !ratingsJson) {
      return { error: "Missing required data" };
    }

    const ratings = JSON.parse(ratingsJson) as {
      categoryId: string;
      stars: number;
    }[];

    // Determine who is voting
    let votingSessionId = null;
    let userId = null;

    if (sessionCode) {
      const session = await prisma.votingSession.findUnique({
        where: { sessionCode },
      });
      if (!session || session.eventId !== params.id) {
        return { error: "Invalid session" };
      }
      votingSessionId = session.id;
    } else if (locals.user) {
      userId = locals.user.id;
    } else {
      return { error: "Not authenticated" };
    }

    // Check if already voted for this group
    const existingVote = await prisma.vote.findFirst({
      where: {
        eventId: params.id,
        groupId,
        ...(votingSessionId ? { votingSessionId } : { userId }),
      },
    });

    if (existingVote) {
      // Update existing ratings
      await prisma.rating.deleteMany({
        where: { voteId: existingVote.id },
      });

      await prisma.rating.createMany({
        data: ratings.map((r) => ({
          voteId: existingVote.id,
          categoryId: r.categoryId,
          stars: r.stars,
        })),
      });
    } else {
      // Create new vote with ratings
      const vote = await prisma.vote.create({
        data: {
          eventId: params.id,
          groupId,
          votingSessionId,
          userId,
        },
      });

      await prisma.rating.createMany({
        data: ratings.map((r) => ({
          voteId: vote.id,
          categoryId: r.categoryId,
          stars: r.stars,
        })),
      });
    }

    return { success: true };
  },

  setCurrentPresentation: async ({ request, params, locals }) => {
    if (!locals.user) {
      return { error: "Not authenticated" };
    }

    const data = await request.formData();
    const groupId = data.get("groupId") as string;

    const event = await prisma.event.findUnique({
      where: { id: params.id },
    });

    if (!event || event.hostId !== locals.user.id) {
      return { error: "Unauthorized" };
    }

    await prisma.event.update({
      where: { id: params.id },
      data: { currentPresentationId: groupId || null },
    });

    return { success: true };
  },
};
