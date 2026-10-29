import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { searchTracks, refreshAccessToken } from "$lib/server/spotify";
import { prisma } from "$lib/server/prisma";

export const GET: RequestHandler = async ({ url, locals }) => {
  const query = url.searchParams.get("q");
  const eventCode = url.searchParams.get("eventCode");

  if (!query) {
    throw error(400, "Missing query parameter");
  }

  let userId: string;

  // If eventCode is provided, use the event host's Spotify token (for guest RSVP)
  if (eventCode) {
    const event = await prisma.event.findUnique({
      where: { publicCode: eventCode },
      select: { userId: true },
    });

    if (!event) {
      throw error(404, "Event not found");
    }

    userId = event.userId;
  } else {
    // Otherwise, use the logged-in user's token (for settings/testing)
    if (!locals.user) {
      throw error(401, "Unauthorized");
    }
    userId = locals.user.id;
  }

  // Get user's Spotify token
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      spotifyAccessToken: true,
      spotifyRefreshToken: true,
      spotifyTokenExpiry: true,
    },
  });

  if (!user?.spotifyAccessToken || !user.spotifyRefreshToken) {
    throw error(403, "Spotify not connected for this event");
  }

  let accessToken = user.spotifyAccessToken;

  // Refresh token if expired
  if (user.spotifyTokenExpiry && new Date() >= user.spotifyTokenExpiry) {
    try {
      const tokenData = await refreshAccessToken(user.spotifyRefreshToken);
      accessToken = tokenData.access_token;

      // Update tokens in database
      await prisma.user.update({
        where: { id: userId },
        data: {
          spotifyAccessToken: tokenData.access_token,
          spotifyRefreshToken:
            tokenData.refresh_token || user.spotifyRefreshToken,
          spotifyTokenExpiry: new Date(
            Date.now() + tokenData.expires_in * 1000
          ),
        },
      });
    } catch (err) {
      console.error("Token refresh error:", err);
      throw error(500, "Failed to refresh Spotify token");
    }
  }

  try {
    const results = await searchTracks(query, accessToken);
    return json(results);
  } catch (err) {
    console.error("Search error:", err);
    throw error(500, "Failed to search Spotify");
  }
};
