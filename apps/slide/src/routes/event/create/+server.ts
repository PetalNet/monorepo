import { json, redirect } from "@sveltejs/kit";
import { prisma } from "$lib/server/db";
import { nanoid } from "nanoid";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, locals }) => {
  // Check if user is authenticated
  if (!locals.user) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const data = await request.json();

    // Validate required fields
    if (!data.name) {
      return json({ error: "Event name is required" }, { status: 400 });
    }

    if (!data.categories || data.categories.length === 0) {
      return json(
        { error: "At least one rating category is required" },
        { status: 400 }
      );
    }

    // Generate unique join code
    const joinCode = nanoid(8).toUpperCase();

    // Create event with categories
    const event = await prisma.event.create({
      data: {
        name: data.name,
        theme: data.theme,
        description: data.description,
        joinCode,
        hostId: locals.user.id,
        timezone: data.timezone || "America/New_York",
        ...(data.submissionDeadline && {
          submissionDeadline: new Date(data.submissionDeadline),
        }),
        maxPresentationTime: data.maxPresentationTime || null,
        orderMode: data.orderMode,
        visibility: "private", // Always private for now
        status: "setup",
        categories: {
          create: data.categories.map((cat: any, index: number) => ({
            name: cat.name,
            description: cat.description,
            order: index,
          })),
        },
      },
    });

    return json({ eventId: event.id, joinCode: event.joinCode });
  } catch (error) {
    console.error("Error creating event:", error);
    return json({ error: "Failed to create event" }, { status: 500 });
  }
};
