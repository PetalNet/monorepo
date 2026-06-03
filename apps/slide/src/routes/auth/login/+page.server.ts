import { fail, redirect } from "@sveltejs/kit";
import { verifyUser, createSession } from "$lib/server/auth";
import type { Actions } from "./$types";

export const actions: Actions = {
  default: async ({ request, cookies, url }) => {
    const formData = await request.formData();
    const email = formData.get("email")?.toString();
    const password = formData.get("password")?.toString();

    if (!email || !password) {
      return fail(400, { error: "Email and password are required" });
    }

    const user = await verifyUser(email, password);

    if (!user) {
      return fail(400, { error: "Invalid email or password" });
    }

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
  },
};
