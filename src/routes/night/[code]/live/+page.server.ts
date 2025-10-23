import { error } from "@sveltejs/kit";
import { prisma } from "$lib/server/db";
import type { PageServerLoad, Actions } from "./$types";
import { nanoid } from "nanoid";

export const load: PageServerLoad = async ({ params, locals, url }) => {
  const event = await prisma.event.findUnique({
    where: { joinCode: params.code },
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

  // Get all active voting sessions for this event
  const votingSessions = await prisma.votingSession.findMany({
    where: {
      eventId: event.id,
      lastActive: {
        gte: new Date(Date.now() - 5 * 60 * 1000), // Active in last 5 minutes
      },
    },
    orderBy: {
      createdAt: "asc",
    },
  });

  // Get all participants (event members)
  const participants = await prisma.groupMember.findMany({
    where: {
      group: {
        eventId: event.id,
      },
    },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
    },
    distinct: ["userId"],
  });

  // Get total votes for current presentation (only count complete votes with all categories)
  let currentPresentationVotes = 0;
  let totalPotentialVoters = 0;

  if (event.currentPresentationId) {
    const categoryCount = event.categories.length;

    // Get all votes for this presentation
    const votes = await prisma.vote.findMany({
      where: {
        eventId: event.id,
        groupId: event.currentPresentationId,
      },
      include: {
        ratings: true,
      },
    });

    // Only count votes that have ratings for ALL categories
    currentPresentationVotes = votes.filter(
      (vote) => vote.ratings.length === categoryCount
    ).length;
  }

  // Total potential voters = logged in users + temp voters
  totalPotentialVoters = participants.length + votingSessions.length;

  // Get existing votes for current user/session
  let existingVotes: Record<string, Record<string, number>> = {};

  for (const group of orderedGroups) {
    const vote = await prisma.vote.findFirst({
      where: {
        eventId: event.id,
        groupId: group.id,
        ...(votingSession
          ? { votingSessionId: votingSession.id }
          : locals.user
          ? { userId: locals.user.id }
          : {}),
      },
      include: {
        ratings: true,
      },
    });

    if (vote) {
      existingVotes[group.id] = {};
      for (const rating of vote.ratings) {
        existingVotes[group.id][rating.categoryId] = rating.stars;
      }
    }
  }

  // Calculate winners (only if event status is completed or we have votes)
  let topPresentations: {
    first: any[];
    second: any[];
    third: any[];
  } = { first: [], second: [], third: [] };
  let categoryWinners: any[] = [];
  let fullLeaderboard: any[] = [];

  if (orderedGroups.length > 0) {
    const groupScores = await Promise.all(
      orderedGroups.map(async (group) => {
        const votes = await prisma.vote.findMany({
          where: {
            eventId: event.id,
            groupId: group.id,
          },
          include: {
            ratings: true,
          },
        });

        // Only count complete votes
        const completeVotes = votes.filter(
          (vote) => vote.ratings.length === event.categories.length
        );

        // Calculate total score (sum of all ratings)
        const totalScore = completeVotes.reduce((sum, vote) => {
          return (
            sum +
            vote.ratings.reduce(
              (ratingSum, rating) => ratingSum + rating.stars,
              0
            )
          );
        }, 0);

        // Calculate average score
        const averageScore =
          completeVotes.length > 0 ? totalScore / completeVotes.length : 0;

        // Calculate category scores
        const categoryScores: Record<string, number> = {};
        for (const category of event.categories) {
          const categoryRatings = completeVotes.flatMap((vote) =>
            vote.ratings.filter((r) => r.categoryId === category.id)
          );
          const categoryAvg =
            categoryRatings.length > 0
              ? categoryRatings.reduce((sum, r) => sum + r.stars, 0) /
                categoryRatings.length
              : 0;
          categoryScores[category.id] = categoryAvg;
        }

        return {
          group,
          totalScore,
          averageScore,
          voteCount: completeVotes.length,
          categoryScores,
        };
      })
    );

    // Sort by total score descending (instead of average), then by vote count
    const sortedGroups = groupScores.sort((a, b) => {
      if (b.totalScore !== a.totalScore) {
        return b.totalScore - a.totalScore;
      }
      return b.voteCount - a.voteCount;
    });

    fullLeaderboard = sortedGroups;

    // Calculate podium positions with ties
    // Get top 3 unique scores (based on total score)
    const uniqueScores = [...new Set(sortedGroups.map((g) => g.totalScore))]
      .sort((a, b) => b - a)
      .slice(0, 3);

    // Build podium with all teams at each position
    const firstPlace = sortedGroups.filter(
      (g) => g.totalScore === uniqueScores[0]
    );
    const secondPlace = uniqueScores[1]
      ? sortedGroups.filter((g) => g.totalScore === uniqueScores[1])
      : [];
    const thirdPlace = uniqueScores[2]
      ? sortedGroups.filter((g) => g.totalScore === uniqueScores[2])
      : [];

    topPresentations = {
      first: firstPlace,
      second: secondPlace,
      third: thirdPlace,
    };

    // Calculate category winners (handle ties)
    categoryWinners = event.categories.map((category) => {
      // Find the highest score for this category
      const highestScore = Math.max(
        ...groupScores.map((g) => g.categoryScores[category.id] || 0)
      );

      // Find all teams with the highest score (handles ties)
      const winners = groupScores.filter(
        (g) => (g.categoryScores[category.id] || 0) === highestScore
      );

      return {
        category,
        winners: winners.map((w) => ({
          group: w.group,
          score: w.categoryScores[category.id],
        })),
        isTie: winners.length > 1,
      };
    });
  }

  return {
    event,
    orderedGroups,
    isHost: !!isHost,
    votingSession,
    votingSessions,
    participants,
    currentUser: locals.user,
    currentPresentationVotes,
    totalPotentialVoters,
    existingVotes,
    topPresentations,
    categoryWinners,
    fullLeaderboard,
  };
};

export const actions: Actions = {
  createVotingSession: async ({ request, params }) => {
    const data = await request.formData();
    const displayName = data.get("displayName") as string;

    if (!displayName || displayName.trim().length === 0) {
      return { error: "Display name is required" };
    }

    const event = await prisma.event.findUnique({
      where: { joinCode: params.code },
    });

    if (!event) {
      return { error: "Event not found" };
    }

    const sessionCode = nanoid(10);

    const session = await prisma.votingSession.create({
      data: {
        eventId: event.id,
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

    const event = await prisma.event.findUnique({
      where: { joinCode: params.code },
    });

    if (!event) {
      return { error: "Event not found" };
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
      if (!session || session.eventId !== event.id) {
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
        eventId: event.id,
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
          eventId: event.id,
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
      where: { joinCode: params.code },
    });

    if (!event || event.hostId !== locals.user.id) {
      return { error: "Unauthorized" };
    }

    await prisma.event.update({
      where: { id: event.id },
      data: { currentPresentationId: groupId || null },
    });

    return { success: true };
  },

  removeParticipant: async ({ request, params, locals }) => {
    if (!locals.user) {
      return { error: "Not authenticated" };
    }

    const data = await request.formData();
    const userId = data.get("userId") as string;

    const event = await prisma.event.findUnique({
      where: { joinCode: params.code },
    });

    if (!event || event.hostId !== locals.user.id) {
      return { error: "Unauthorized" };
    }

    // Remove user from all groups in this event
    await prisma.groupMember.deleteMany({
      where: {
        userId,
        group: {
          eventId: event.id,
        },
      },
    });

    return { success: true };
  },

  reorderPresentations: async ({ request, params, locals }) => {
    if (!locals.user) {
      return { error: "Not authenticated" };
    }

    const data = await request.formData();
    const orderJson = data.get("order") as string;
    const order = JSON.parse(orderJson) as string[];

    const event = await prisma.event.findUnique({
      where: { joinCode: params.code },
    });

    if (!event || event.hostId !== locals.user.id) {
      return { error: "Unauthorized" };
    }

    // Delete existing order
    await prisma.presentationOrder.deleteMany({
      where: { eventId: event.id },
    });

    // Create new order
    await prisma.presentationOrder.createMany({
      data: order.map((groupId, index) => ({
        eventId: event.id,
        groupId,
        position: index,
      })),
    });

    return { success: true };
  },

  removeVotingSession: async ({ request, params, locals }) => {
    if (!locals.user) {
      return { error: "Not authenticated" };
    }

    const data = await request.formData();
    const sessionId = data.get("sessionId") as string;

    const event = await prisma.event.findUnique({
      where: { joinCode: params.code },
    });

    if (!event || event.hostId !== locals.user.id) {
      return { error: "Unauthorized" };
    }

    // Delete votes first, then session
    await prisma.vote.deleteMany({
      where: { votingSessionId: sessionId },
    });

    await prisma.$executeRaw`DELETE FROM VotingSession WHERE id = ${sessionId}`;

    return { success: true };
  },

  autoSaveRating: async ({ request, params, locals, url }) => {
    const data = await request.formData();
    const groupId = data.get("groupId") as string;
    const categoryId = data.get("categoryId") as string;
    const stars = parseInt(data.get("stars") as string);
    const sessionCode = url.searchParams.get("session");

    if (!groupId || !categoryId || isNaN(stars)) {
      return { error: "Missing required data" };
    }

    const event = await prisma.event.findUnique({
      where: { joinCode: params.code },
      include: { categories: true },
    });

    if (!event) {
      return { error: "Event not found" };
    }

    // Determine who is voting
    let votingSessionId = null;
    let userId = null;

    if (sessionCode) {
      const session = (await prisma.$queryRaw`
        SELECT * FROM VotingSession WHERE sessionCode = ${sessionCode} LIMIT 1
      `) as any[];
      if (!session[0] || session[0].eventId !== event.id) {
        return { error: "Invalid session" };
      }
      votingSessionId = session[0].id;
    } else if (locals.user) {
      userId = locals.user.id;
    } else {
      return { error: "Not authenticated" };
    }

    // Find or create vote
    const existingVote = await prisma.vote.findFirst({
      where: {
        eventId: event.id,
        groupId,
        ...(votingSessionId ? { votingSessionId } : { userId }),
      },
      include: { ratings: true },
    });

    let voteId: string;

    if (existingVote) {
      voteId = existingVote.id;
    } else {
      // Create new vote
      const voteData: any = {
        eventId: event.id,
        groupId,
        judgeId: null,
      };

      if (votingSessionId) {
        voteData.votingSessionId = votingSessionId;
      } else {
        voteData.userId = userId;
      }

      const vote = await prisma.vote.create({
        data: voteData,
      });
      voteId = vote.id;
    }

    // Upsert the rating for this category
    const existingRating = await prisma.rating.findUnique({
      where: {
        voteId_categoryId: {
          voteId,
          categoryId,
        },
      },
    });

    if (existingRating) {
      await prisma.rating.update({
        where: { id: existingRating.id },
        data: { stars },
      });
    } else {
      await prisma.rating.create({
        data: {
          voteId,
          categoryId,
          stars,
        },
      });
    }

    return { success: true };
  },

  resetVotes: async ({ request, params, locals }) => {
    if (!locals.user) {
      return { error: "Not authenticated" };
    }

    const event = await prisma.event.findUnique({
      where: { joinCode: params.code },
    });

    if (!event || event.hostId !== locals.user.id) {
      return { error: "Unauthorized" };
    }

    // Delete all votes and ratings for this event
    await prisma.rating.deleteMany({
      where: {
        vote: {
          eventId: event.id,
        },
      },
    });

    await prisma.vote.deleteMany({
      where: {
        eventId: event.id,
      },
    });

    return { success: true };
  },

  showWinners: async ({ params, locals }) => {
    if (!locals.user) {
      return { error: "Not authenticated" };
    }

    const event = await prisma.event.findUnique({
      where: { joinCode: params.code },
    });

    if (!event || event.hostId !== locals.user.id) {
      return { error: "Unauthorized" };
    }

    // Update event status to completed and clear current presentation
    await prisma.event.update({
      where: { id: event.id },
      data: {
        status: "completed",
        currentPresentationId: null,
        winnersRevealStep: 0,
      },
    });

    return { success: true };
  },

  revealWinner: async ({ request, params, locals }) => {
    if (!locals.user) {
      return { error: "Not authenticated" };
    }

    const event = await prisma.event.findUnique({
      where: { joinCode: params.code },
    });

    if (!event || event.hostId !== locals.user.id) {
      return { error: "Unauthorized" };
    }

    const formData = await request.formData();
    const step = Number(formData.get("step"));

    // Update the reveal step
    await prisma.event.update({
      where: { id: event.id },
      data: { winnersRevealStep: step },
    });

    return { success: true };
  },

  backToPresentations: async ({ params, locals }) => {
    if (!locals.user) {
      return { error: "Not authenticated" };
    }

    const event = await prisma.event.findUnique({
      where: { joinCode: params.code },
    });

    if (!event || event.hostId !== locals.user.id) {
      return { error: "Unauthorized" };
    }

    // Reset event status back to active
    await prisma.event.update({
      where: { id: event.id },
      data: {
        status: "active",
      },
    });

    return { success: true };
  },

  triggerConfetti: async ({ params }) => {
    const event = await prisma.event.findUnique({
      where: { joinCode: params.code },
    });

    if (!event) {
      return { error: "Event not found" };
    }

    // Increment confetti counter (ensures each trigger is unique)
    await prisma.event.update({
      where: { id: event.id },
      data: {
        confettiTriggeredAt: new Date(),
        confettiCount: (event as any).confettiCount + 1,
      },
    });

    return { success: true };
  },

  startTimer: async ({ request, params, locals }) => {
    if (!locals.user) {
      return { error: "Not authenticated" };
    }

    const data = await request.formData();
    const minutes = parseInt(data.get("minutes") as string);

    if (isNaN(minutes) || minutes <= 0) {
      return { error: "Invalid duration" };
    }

    const event = await prisma.event.findUnique({
      where: { joinCode: params.code },
    });

    if (!event || event.hostId !== locals.user.id) {
      return { error: "Unauthorized" };
    }

    // Use server time as the source of truth
    await prisma.event.update({
      where: { id: event.id },
      data: {
        timerStartedAt: new Date(),
        timerDuration: minutes * 60, // Convert minutes to seconds
        timerPausedAt: null,
        timerPausedRemaining: null,
      } as any,
    });

    return { success: true };
  },

  pauseTimer: async ({ params, locals }) => {
    if (!locals.user) {
      return { error: "Not authenticated" };
    }

    const event = await prisma.event.findUnique({
      where: { joinCode: params.code },
    });

    if (!event || event.hostId !== locals.user.id) {
      return { error: "Unauthorized" };
    }

    if (!(event as any).timerStartedAt || (event as any).timerPausedAt) {
      return { error: "Timer is not running" };
    }

    // Calculate remaining time
    const elapsed = Math.floor(
      (Date.now() - new Date((event as any).timerStartedAt).getTime()) / 1000
    );
    const remaining = Math.max(
      0,
      ((event as any).timerDuration || 0) - elapsed
    );

    await prisma.event.update({
      where: { id: event.id },
      data: {
        timerPausedAt: new Date(),
        timerPausedRemaining: remaining,
      } as any,
    });

    return { success: true };
  },

  resumeTimer: async ({ params, locals }) => {
    if (!locals.user) {
      return { error: "Not authenticated" };
    }

    const event = await prisma.event.findUnique({
      where: { joinCode: params.code },
    });

    if (!event || event.hostId !== locals.user.id) {
      return { error: "Unauthorized" };
    }

    if (
      !(event as any).timerPausedAt ||
      (event as any).timerPausedRemaining === null
    ) {
      return { error: "Timer is not paused" };
    }

    // Resume with remaining time
    await prisma.event.update({
      where: { id: event.id },
      data: {
        timerStartedAt: new Date(),
        timerDuration: (event as any).timerPausedRemaining,
        timerPausedAt: null,
        timerPausedRemaining: null,
      } as any,
    });

    return { success: true };
  },

  stopTimer: async ({ params, locals }) => {
    if (!locals.user) {
      return { error: "Not authenticated" };
    }

    const event = await prisma.event.findUnique({
      where: { joinCode: params.code },
    });

    if (!event || event.hostId !== locals.user.id) {
      return { error: "Unauthorized" };
    }

    await prisma.event.update({
      where: { id: event.id },
      data: {
        timerStartedAt: null,
        timerDuration: null,
        timerPausedAt: null,
        timerPausedRemaining: null,
      } as any,
    });

    return { success: true };
  },
};
