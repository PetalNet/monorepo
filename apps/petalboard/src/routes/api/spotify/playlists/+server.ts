import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getUserPlaylists, refreshAccessToken } from "$lib/server/spotify";
import { prisma } from "$lib/server/prisma";

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: locals.user.id },
    select: {
      spotifyAccessToken: true,
      spotifyRefreshToken: true,
      spotifyTokenExpiry: true,
    },
  });

  if (!user?.spotifyAccessToken || !user?.spotifyRefreshToken) {
    return json({ error: "Spotify not connected" }, { status: 400 });
  }

  let accessToken = user.spotifyAccessToken;

  // Check if token is expired
  if (
    user.spotifyTokenExpiry &&
    new Date(user.spotifyTokenExpiry) < new Date()
  ) {
    try {
      const tokenData = await refreshAccessToken(user.spotifyRefreshToken);
      accessToken = tokenData.access_token;

      // Update tokens in database
      await prisma.user.update({
        where: { id: locals.user.id },
        data: {
          spotifyAccessToken: tokenData.access_token,
          spotifyRefreshToken:
            tokenData.refresh_token || user.spotifyRefreshToken,
          spotifyTokenExpiry: new Date(
            Date.now() + tokenData.expires_in * 1000
          ),
        },
      });
    } catch (error) {
      return json(
        { error: "Failed to refresh Spotify token" },
        { status: 401 }
      );
    }
  }

  try {
    const playlists = await getUserPlaylists(accessToken);
    return json({ playlists });
  } catch (error) {
    console.error("Failed to fetch playlists:", error);
    return json({ error: "Failed to fetch playlists" }, { status: 500 });
  }
};
