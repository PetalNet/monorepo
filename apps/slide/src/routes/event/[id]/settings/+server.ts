import { json } from "@sveltejs/kit";
import { prisma } from "$lib/server/db";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, params, locals }) => {
  if (!locals.user) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  const event = await prisma.event.findUnique({
    where: { id: params.id },
  });

  if (!event || event.hostId !== locals.user.id) {
    return json({ error: "Forbidden" }, { status: 403 });
  }

  const data = await request.json();

  if (data.action === "toggleSubmissions") {
    await prisma.event.update({
      where: { id: params.id },
      data: {
        submissionsClosed: data.submissionsClosed,
      },
    });

    return json({ success: true });
  }

  if (data.action === "reorderCategories") {
    // Update category order
    const updates = data.categories.map((cat: { id: string; order: number }) =>
      prisma.category.update({
        where: { id: cat.id },
        data: { order: cat.order },
      })
    );

    await prisma.$transaction(updates);

    return json({ success: true });
  }

  return json({ error: "Invalid action" }, { status: 400 });
};
