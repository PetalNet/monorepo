import { json, error } from "@sveltejs/kit";
import prisma from "$lib/server/prisma";
import {
  removeTracksFromPlaylist,
  refreshAccessToken,
} from "$lib/server/spotify";

export const POST = async ({ request, locals }) => {
  try {
    const { playlistId, trackUri, questionId, eventCode } =
      await request.json();

    if (!playlistId || !trackUri || !questionId) {
      throw error(400, "Missing required parameters");
    }

    // Determine whose Spotify token to use
    let userId: string;
    if (eventCode) {
      // Guest RSVP - use event host's token
      const event = await prisma.event.findUnique({
        where: { publicCode: eventCode },
        select: { userId: true },
      });

      if (!event) {
        throw error(404, "Event not found");
      }

      userId = event.userId;
    } else if (locals.user) {
      // Logged in user
      userId = locals.user.id;
    } else {
      throw error(401, "Authentication required");
    }

    // Get user's Spotify credentials
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        spotifyAccessToken: true,
        spotifyRefreshToken: true,
        spotifyTokenExpiry: true,
      },
    });

    if (!user?.spotifyAccessToken || !user?.spotifyRefreshToken) {
      throw error(401, "Spotify not connected");
    }

    // Check if token needs refresh
    let accessToken = user.spotifyAccessToken;
    if (
      user.spotifyTokenExpiry &&
      new Date(user.spotifyTokenExpiry) <= new Date()
    ) {
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
        console.error("Token refresh failed:", err);
        throw error(500, "Failed to refresh Spotify token");
      }
    }

    // Remove track from Spotify playlist
    await removeTracksFromPlaylist(playlistId, [trackUri], accessToken);

    return json({ success: true });
  } catch (err: any) {
    console.error("Remove track error:", err);
    if (err.status) {
      throw err;
    }
    throw error(500, "Failed to remove track");
  }
};
