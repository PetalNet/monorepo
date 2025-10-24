import { redirect } from "@sveltejs/kit";
import type { LayoutServerLoad } from "./$types";
import { validateSession } from "$lib/server/auth";

export const load: LayoutServerLoad = async ({ cookies }) => {
  const session = await validateSession(cookies.get("session") || "");

  if (!session) {
    throw redirect(302, "/auth/login?redirect=/admin");
  }

  const adminEmail = process.env.ADMIN_EMAIL;
  console.log("Admin check - User email:", session.user.email);
  console.log("Admin check - ADMIN_EMAIL env:", adminEmail);
  console.log("Admin check - Match:", session.user.email === adminEmail);

  if (!adminEmail || session.user.email !== adminEmail) {
    throw redirect(302, "/dashboard");
  }

  return {};
};
