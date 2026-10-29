import { fail, redirect } from "@sveltejs/kit";
import prisma from "$lib/server/prisma";
import { verifyPassword, createSession } from "$lib/server/auth";
import { loginSchema } from "$lib/server/validation";

export const load = async ({ locals }) => {
  if (locals.user) {
    throw redirect(303, "/dashboard");
  }
};

export const actions = {
  default: async ({ request, cookies }) => {
    const formData = await request.formData();
    const raw = Object.fromEntries(formData) as Record<string, string>;
    const parsed = loginSchema.safeParse(raw);

    if (!parsed.success) {
      return fail(400, {
        errors: parsed.error.flatten().fieldErrors,
        values: { email: raw.email },
      });
    }

    const { email, password } = parsed.data;

    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user || !verifyPassword(password, user.passwordHash)) {
      return fail(400, {
        errors: { email: ["Invalid email or password"] },
        values: { email },
      });
    }

    if (!user.emailVerified) {
      return fail(400, {
        errors: {
          email: [
            "Please verify your email address before logging in. Check your inbox for the verification link.",
          ],
        },
        values: { email },
      });
    }

    await createSession(user.id, cookies);
    throw redirect(303, "/dashboard");
  },
};
