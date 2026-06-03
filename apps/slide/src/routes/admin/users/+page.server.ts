import type { PageServerLoad, Actions } from "./$types";
import { prisma } from "$lib/server/db";
import { fail } from "@sveltejs/kit";

export const load: PageServerLoad = async () => {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      email: true,
      name: true,
      createdAt: true,
      updatedAt: true,
      _count: {
        select: {
          hostedEvents: true,
          groupMembers: true,
          votes: true,
        },
      },
    },
  });

  const adminEmail = process.env.ADMIN_EMAIL;

  return { users, adminEmail };
};

export const actions: Actions = {
  deleteUser: async ({ request }) => {
    const formData = await request.formData();
    const userId = formData.get("userId") as string;

    if (!userId) {
      return fail(400, { error: "User ID required" });
    }

    try {
      await prisma.user.delete({
        where: { id: userId },
      });

      return { success: true };
    } catch (error) {
      return fail(500, { error: "Failed to delete user" });
    }
  },
};
