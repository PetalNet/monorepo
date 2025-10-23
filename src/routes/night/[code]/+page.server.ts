import { error, fail, redirect } from "@sveltejs/kit";
import { prisma } from "$lib/server/db";
import { nanoid } from "nanoid";
import type { PageServerLoad, Actions } from "./$types";

export const load: PageServerLoad = async ({ params, locals }) => {
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
      judges: true,
      _count: {
        select: {
          groups: true,
          categories: true,
        },
      },
    },
  });

  if (!event) {
    throw error(404, "Event not found");
  }

  // Check if user is the host
  const isHost = locals.user ? event.hostId === locals.user.id : false;

  // Check if deadline has passed (in event's timezone)
  const deadlinePassed =
    event.submissionDeadline && new Date() > new Date(event.submissionDeadline);

  // Check if user is already in a group
  let userGroups: any[] = [];
  if (locals.user) {
    const memberships = await prisma.groupMember.findMany({
      where: {
        userId: locals.user.id,
        group: {
          eventId: event.id,
        },
      },
      include: {
        group: {
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
      },
    });

    userGroups = memberships;
  }

  return {
    event,
    userGroups,
    user: locals.user,
    isHost,
    deadlinePassed,
  };
};

export const actions: Actions = {
  createGroup: async ({ request, params, locals }) => {
    if (!locals.user) {
      return fail(401, { error: "You must be logged in to create a group" });
    }

    const event = await prisma.event.findUnique({
      where: { joinCode: params.code },
    });

    if (!event) {
      return fail(404, { error: "Event not found" });
    }

    if ((event as any).submissionsClosed) {
      return fail(400, { error: "Submissions are closed for this event" });
    }

    // Check if deadline has passed
    if (
      event.submissionDeadline &&
      new Date() > new Date(event.submissionDeadline)
    ) {
      return fail(400, { error: "The submission deadline has passed" });
    }

    const data = await request.formData();
    const name = data.get("name") as string;
    const emoji = data.get("emoji") as string;

    if (!name) {
      return fail(400, { error: "Presentation name is required" });
    }

    // Generate unique invite code
    const inviteCode = nanoid(8).toUpperCase();

    // Create group with user as leader
    const group = await prisma.group.create({
      data: {
        name,
        emoji: emoji || "📊",
        presentationType: "other" as string, // Default value
        inviteCode: inviteCode,
        eventId: event.id,
        members: {
          create: {
            userId: locals.user.id,
            isLeader: true,
          },
        },
      },
    });

    return { success: true, groupId: group.id };
  },

  joinGroup: async ({ request, params, locals }) => {
    if (!locals.user) {
      return fail(401, { error: "You must be logged in to join a group" });
    }

    const event = await prisma.event.findUnique({
      where: { joinCode: params.code },
    });

    if (!event) {
      return fail(404, { error: "Event not found" });
    }

    if ((event as any).submissionsClosed) {
      return fail(400, { error: "Submissions are closed for this event" });
    }

    // Check if deadline has passed
    if (
      event.submissionDeadline &&
      new Date() > new Date(event.submissionDeadline)
    ) {
      return fail(400, { error: "The submission deadline has passed" });
    }

    const data = await request.formData();
    const inviteCode = (data.get("inviteCode") as string)?.toUpperCase();

    if (!inviteCode) {
      return fail(400, { error: "Invite code is required" });
    }

    // Find group by invite code
    const group = await prisma.group.findUnique({
      where: { inviteCode } as any,
    });

    if (!group || group.eventId !== event.id) {
      return fail(404, { error: "Invalid invite code for this event" });
    }

    // Check if user is already in this specific group
    const existingMembership = await prisma.groupMember.findFirst({
      where: {
        userId: locals.user.id,
        groupId: group.id,
      },
    });

    if (existingMembership) {
      return fail(400, { error: "You are already in this group" });
    }

    // Add user to group
    await prisma.groupMember.create({
      data: {
        userId: locals.user.id,
        groupId: group.id,
        isLeader: false,
      },
    });

    return { success: true };
  },

  submitPresentation: async ({ request, params, locals }) => {
    if (!locals.user) {
      return fail(401, { error: "You must be logged in to submit" });
    }

    const event = await prisma.event.findUnique({
      where: { joinCode: params.code },
    });

    if (!event) {
      return fail(404, { error: "Event not found" });
    }

    const data = await request.formData();
    const submissionLink = data.get("submissionLink") as string;
    const groupId = data.get("groupId") as string;

    if (!groupId) {
      return fail(400, { error: "Group ID is required" });
    }

    // Find user's group membership - any member can submit
    const membership = await prisma.groupMember.findFirst({
      where: {
        userId: locals.user.id,
        groupId: groupId,
      },
    });

    if (!membership) {
      return fail(403, {
        error: "You must be a member of this group to submit",
      });
    }

    // Update group with submission
    await prisma.group.update({
      where: { id: groupId },
      data: {
        submissionLink: submissionLink || null,
        status: "submitted",
        submittedAt: new Date(),
      },
    });

    return { success: true };
  },

  removeMember: async ({ request, params, locals }) => {
    if (!locals.user) {
      return fail(401, { error: "You must be logged in" });
    }

    const data = await request.formData();
    const groupId = data.get("groupId") as string;
    const userId = data.get("userId") as string;

    if (!groupId || !userId) {
      return fail(400, { error: "Group ID and User ID are required" });
    }

    // Verify current user is the group leader
    const leaderMembership = await prisma.groupMember.findFirst({
      where: {
        userId: locals.user.id,
        groupId: groupId,
        isLeader: true,
      },
    });

    if (!leaderMembership) {
      return fail(403, { error: "Only group leaders can remove members" });
    }

    // Cannot remove yourself
    if (userId === locals.user.id) {
      return fail(400, { error: "You cannot remove yourself from the group" });
    }

    // Remove the member
    await prisma.groupMember.deleteMany({
      where: {
        userId: userId,
        groupId: groupId,
      },
    });

    return { success: true };
  },

  updateGroup: async ({ request, params, locals }) => {
    if (!locals.user) {
      return fail(401, { error: "You must be logged in" });
    }

    const data = await request.formData();
    const groupId = data.get("groupId") as string;
    const name = data.get("name") as string;
    const emoji = data.get("emoji") as string;

    if (!groupId) {
      return fail(400, { error: "Group ID is required" });
    }

    if (!name) {
      return fail(400, { error: "Presentation name is required" });
    }

    // Verify user is the group leader
    const membership = await prisma.groupMember.findFirst({
      where: {
        userId: locals.user.id,
        groupId: groupId,
        isLeader: true,
      },
    });

    if (!membership) {
      return fail(403, {
        error: "Only group leaders can edit the presentation",
      });
    }

    // Update group
    await prisma.group.update({
      where: { id: groupId },
      data: {
        name,
        emoji: emoji || "📊",
      },
    });

    return { success: true };
  },

  deleteGroup: async ({ request, params, locals }) => {
    if (!locals.user) {
      return fail(401, { error: "You must be logged in" });
    }

    const data = await request.formData();
    const groupId = data.get("groupId") as string;

    if (!groupId) {
      return fail(400, { error: "Group ID is required" });
    }

    // Verify user is the group leader
    const membership = await prisma.groupMember.findFirst({
      where: {
        userId: locals.user.id,
        groupId: groupId,
        isLeader: true,
      },
    });

    if (!membership) {
      return fail(403, { error: "Only group leaders can delete the group" });
    }

    // Delete all memberships first, then the group
    await prisma.groupMember.deleteMany({
      where: { groupId },
    });

    await prisma.group.delete({
      where: { id: groupId },
    });

    return { success: true };
  },

  updateEvent: async ({ request, params, locals }) => {
    if (!locals.user) {
      return fail(401, { error: "You must be logged in" });
    }

    const event = await prisma.event.findUnique({
      where: { joinCode: params.code },
    });

    if (!event) {
      return fail(404, { error: "Event not found" });
    }

    if (event.hostId !== locals.user.id) {
      return fail(403, { error: "Only the event host can update settings" });
    }

    const data = await request.formData();
    const name = data.get("name") as string;
    const theme = data.get("theme") as string;
    const description = data.get("description") as string;
    const submissionDeadline = data.get("submissionDeadline") as string;
    const maxPresentationTime = data.get("maxPresentationTime") as string;
    const submissionsClosed = data.get("submissionsClosed") === "on";
    const timezone = data.get("timezone") as string;

    await prisma.event.update({
      where: { id: event.id },
      data: {
        name,
        theme: theme || null,
        description: description || null,
        timezone: timezone || "America/New_York",
        ...(submissionDeadline && {
          submissionDeadline: new Date(submissionDeadline),
        }),
        ...(maxPresentationTime && {
          maxPresentationTime: parseInt(maxPresentationTime),
        }),
        submissionsClosed,
      },
    });

    return { success: true };
  },

  removeParticipant: async ({ request, params, locals }) => {
    if (!locals.user) {
      return fail(401, { error: "You must be logged in" });
    }

    const event = await prisma.event.findUnique({
      where: { joinCode: params.code },
    });

    if (!event) {
      return fail(404, { error: "Event not found" });
    }

    if (event.hostId !== locals.user.id) {
      return fail(403, {
        error: "Only the event host can remove participants",
      });
    }

    const data = await request.formData();
    const userId = data.get("userId") as string;

    // Remove user from all groups in this event
    await prisma.groupMember.deleteMany({
      where: {
        userId,
        group: {
          eventId: event.id,
        },
      },
    });

    // Delete any groups that now have no members
    const emptyGroups = await prisma.group.findMany({
      where: {
        eventId: event.id,
        members: {
          none: {},
        },
      },
    });

    await prisma.group.deleteMany({
      where: {
        id: {
          in: emptyGroups.map((g) => g.id),
        },
      },
    });

    return { success: true };
  },

  updateCategories: async ({ request, params, locals }) => {
    if (!locals.user) {
      return fail(401, { error: "You must be logged in" });
    }

    const event = await prisma.event.findUnique({
      where: { joinCode: params.code },
    });

    if (!event) {
      return fail(404, { error: "Event not found" });
    }

    if (event.hostId !== locals.user.id) {
      return fail(403, { error: "Only the event host can manage categories" });
    }

    const data = await request.formData();
    const categories = JSON.parse(data.get("categories") as string);

    // Delete all existing categories for this event
    await prisma.category.deleteMany({
      where: { eventId: event.id },
    });

    // Create new categories
    await Promise.all(
      categories.map((cat: any) =>
        prisma.category.create({
          data: {
            eventId: event.id,
            name: cat.name,
            description: cat.description || null,
            order: cat.order,
          },
        })
      )
    );

    return { success: true };
  },

  reorderPresentations: async ({ request, params, locals }) => {
    if (!locals.user) {
      return fail(401, { error: "You must be logged in" });
    }

    const event = await prisma.event.findUnique({
      where: { joinCode: params.code },
    });

    if (!event) {
      return fail(404, { error: "Event not found" });
    }

    if (event.hostId !== locals.user.id) {
      return fail(403, {
        error: "Only the event host can reorder presentations",
      });
    }

    const data = await request.formData();
    const orderedGroupIds = JSON.parse(data.get("orderedGroupIds") as string);

    // Delete existing orders
    await prisma.presentationOrder.deleteMany({
      where: { eventId: event.id },
    });

    // Create new orders
    await Promise.all(
      orderedGroupIds.map((groupId: string, index: number) =>
        prisma.presentationOrder.create({
          data: {
            eventId: event.id,
            groupId,
            position: index,
          },
        })
      )
    );

    // Update groups with presentation order
    await Promise.all(
      orderedGroupIds.map((groupId: string, index: number) =>
        prisma.group.update({
          where: { id: groupId },
          data: { presentationOrder: index },
        })
      )
    );

    return { success: true };
  },
};
