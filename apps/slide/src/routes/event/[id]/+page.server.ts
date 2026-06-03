import { redirect, error, fail } from "@sveltejs/kit";
import { prisma } from "$lib/server/db";
import type { PageServerLoad, Actions } from "./$types";

export const load: PageServerLoad = async ({ params, locals }) => {
  if (!locals.user) {
    throw redirect(303, "/auth/login");
  }

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
    },
  });

  if (!event) {
    throw error(404, "Event not found");
  }

  // Check if user is the host
  const isHost = event.hostId === locals.user.id;

  return {
    event,
    isHost,
  };
};

export const actions: Actions = {
  updateSettings: async ({ request, params, locals }) => {
    if (!locals.user) {
      return fail(401, { error: "Unauthorized" });
    }

    const event = await prisma.event.findUnique({
      where: { id: params.id },
    });

    if (!event || event.hostId !== locals.user.id) {
      return fail(403, { error: "Forbidden" });
    }

    const data = await request.formData();
    const name = data.get("name") as string;
    const theme = data.get("theme") as string;
    const description = data.get("description") as string;
    const submissionDeadline = data.get("submissionDeadline") as string;
    const maxPresentationTime = data.get("maxPresentationTime") as string;
    const orderMode = data.get("orderMode") as string;

    // Validation
    if (!name || name.trim().length === 0) {
      return fail(400, { error: "Event name is required" });
    }

    if (orderMode && !["random", "alphabetical"].includes(orderMode)) {
      return fail(400, { error: "Invalid order mode" });
    }

    // Parse and validate deadline
    let parsedDeadline: Date | null = null;
    if (submissionDeadline && submissionDeadline.trim().length > 0) {
      try {
        parsedDeadline = new Date(submissionDeadline);
        if (isNaN(parsedDeadline.getTime())) {
          return fail(400, { error: "Invalid submission deadline" });
        }
      } catch (e) {
        return fail(400, { error: "Invalid submission deadline format" });
      }
    }

    // Parse and validate max presentation time
    let parsedMaxTime: number | null = null;
    if (maxPresentationTime && maxPresentationTime.trim().length > 0) {
      parsedMaxTime = parseInt(maxPresentationTime);
      if (isNaN(parsedMaxTime) || parsedMaxTime < 1) {
        return fail(400, {
          error: "Max presentation time must be at least 1 minute",
        });
      }
    }

    try {
      await prisma.event.update({
        where: { id: params.id },
        data: {
          name: name.trim(),
          theme: theme && theme.trim().length > 0 ? theme.trim() : null,
          description:
            description && description.trim().length > 0
              ? description.trim()
              : null,
          submissionDeadline: parsedDeadline,
          maxPresentationTime: parsedMaxTime,
          orderMode: orderMode || "random",
        },
      });

      return { success: true };
    } catch (e) {
      console.error("Failed to update event:", e);
      return fail(500, { error: "Failed to update event settings" });
    }
  },

  deleteEvent: async ({ params, locals }) => {
    if (!locals.user) {
      return fail(401, { error: "Unauthorized" });
    }

    const event = await prisma.event.findUnique({
      where: { id: params.id },
    });

    if (!event || event.hostId !== locals.user.id) {
      return fail(403, { error: "Forbidden" });
    }

    try {
      await prisma.event.delete({
        where: { id: params.id },
      });

      throw redirect(303, "/dashboard");
    } catch (e) {
      if (e instanceof Response) {
        throw e; // Re-throw redirects
      }
      console.error("Failed to delete event:", e);
      return fail(500, { error: "Failed to delete event" });
    }
  },
};
