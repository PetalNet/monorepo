import { redirect } from "@sveltejs/kit";
import prisma from "$lib/server/prisma";

export const load = async ({ locals }) => {
  if (!locals.user) {
    throw redirect(303, "/login");
  }

  const events = await prisma.event.findMany({
    where: { userId: locals.user.id },
    orderBy: { date: "desc" },
    include: {
      _count: {
        select: {
          rsvps: true,
          questions: true,
        },
      },
    },
  });

  return {
    events: events.map((event) => ({
      id: event.id,
      title: event.title,
      description: event.description,
      date: event.date.toISOString(),
      timezone: event.timezone,
      location: event.location,
      publicCode: event.publicCode,
      manageToken: event.manageToken,
      rsvpCount: event._count.rsvps,
      questionCount: event._count.questions,
    })),
  };
};
