import { error, redirect } from "@sveltejs/kit";
import prisma from "$lib/server/prisma";
import { createSession } from "$lib/server/auth";

export const GET = async ({ params, cookies }) => {
  const { token } = params;

  if (!token) {
    throw error(400, "Invalid verification link");
  }

  const user = await prisma.user.findUnique({
    where: { verificationToken: token },
  });

  if (!user) {
    throw error(400, "Invalid or expired verification link");
  }

  if (user.emailVerified) {
    // Already verified, just log them in
    await createSession(user.id, cookies);
    throw redirect(303, "/dashboard");
  }

  // Mark email as verified and clear the token
  await prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerified: true,
      verificationToken: null,
    },
  });

  // Create session and redirect to dashboard
  await createSession(user.id, cookies);
  throw redirect(303, "/dashboard");
};
