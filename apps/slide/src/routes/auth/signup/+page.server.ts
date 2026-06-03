import { fail, redirect } from "@sveltejs/kit";
import { createUser, createSession } from "$lib/server/auth";
import type { Actions } from "./$types";

export const actions: Actions = {
  default: async ({ request, cookies, url }) => {
    const formData = await request.formData();
    const email = formData.get("email")?.toString();
    const password = formData.get("password")?.toString();
    const name = formData.get("name")?.toString();

    if (!email || !password || !name) {
      return fail(400, { error: "All fields are required" });
    }

    if (password.length < 6) {
      return fail(400, { error: "Password must be at least 6 characters" });
    }

    try {
      const user = await createUser(email, password, name);
      const session = await createSession(user.id);

      cookies.set("session", session.id, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: 60 * 60 * 24 * 30, // 30 days
      });

      // Redirect to the 'redirectTo' parameter if present, otherwise dashboard
      const redirectTo = url.searchParams.get("redirectTo") || "/dashboard";
      throw redirect(303, redirectTo);
    } catch (error: any) {
      if (error.code === "P2002") {
        return fail(400, { error: "Email already exists" });
      }
      throw error;
    }
  },
};
