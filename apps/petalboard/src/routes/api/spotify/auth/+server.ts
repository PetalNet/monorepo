import { redirect } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getSpotifyAuthUrl } from "$lib/server/spotify";
import { randomBytes } from "crypto";

export const GET: RequestHandler = async ({ locals, cookies }) => {
  if (!locals.user) {
    throw redirect(302, "/login");
  }

  // Generate state for CSRF protection
  const state = randomBytes(16).toString("hex");
  cookies.set("spotify_auth_state", state, {
    path: "/",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 10, // 10 minutes
  });

  const authUrl = getSpotifyAuthUrl(state);
  throw redirect(302, authUrl);
};
