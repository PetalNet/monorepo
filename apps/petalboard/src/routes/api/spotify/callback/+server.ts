import { redirect } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { exchangeCodeForToken } from "$lib/server/spotify";
import { prisma } from "$lib/server/prisma";

export const GET: RequestHandler = async ({ url, locals, cookies }) => {
  if (!locals.user) {
    throw redirect(302, "/login");
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  // Verify state matches
  const savedState = cookies.get("spotify_auth_state");
  cookies.delete("spotify_auth_state", { path: "/" });

  if (error) {
    throw redirect(302, "/settings");
  }

  if (!code || !state || state !== savedState) {
    throw redirect(302, "/settings");
  }

  try {
    console.log(
      "=== CALLBACK: Starting token exchange for user:",
      locals.user.id
    );
    const tokenData = await exchangeCodeForToken(code);

    console.log("=== CALLBACK: Token exchange successful");
    console.log("=== CALLBACK: Has access_token:", !!tokenData.access_token);
    console.log("=== CALLBACK: Has refresh_token:", !!tokenData.refresh_token);
    console.log(
      "=== CALLBACK: Access token length:",
      tokenData.access_token?.length
    );
    console.log(
      "=== CALLBACK: Refresh token length:",
      tokenData.refresh_token?.length
    );

    const expiryDate = new Date(Date.now() + tokenData.expires_in * 1000);
    console.log(
      "=== CALLBACK: Calculated expiry date:",
      expiryDate.toISOString()
    );

    console.log("=== CALLBACK: About to update user in database");

    // Use $transaction to ensure atomicity
    const result = await prisma.$transaction(async (tx) => {
      const updatedUser = await tx.user.update({
        where: { id: locals.user.id },
        data: {
          spotifyAccessToken: tokenData.access_token,
          spotifyRefreshToken: tokenData.refresh_token,
          spotifyTokenExpiry: expiryDate,
        },
      });

      console.log("=== CALLBACK: Transaction update completed");
      console.log(
        "=== CALLBACK: Updated user has spotifyAccessToken:",
        !!updatedUser.spotifyAccessToken
      );
      console.log(
        "=== CALLBACK: Updated user spotifyAccessToken length:",
        updatedUser.spotifyAccessToken?.length
      );

      // Verify the update by reading it back
      const verified = await tx.user.findUnique({
        where: { id: locals.user.id },
        select: { spotifyAccessToken: true },
      });
      console.log(
        "=== CALLBACK: Verification - has token:",
        !!verified?.spotifyAccessToken
      );
      console.log(
        "=== CALLBACK: Verification - token length:",
        verified?.spotifyAccessToken?.length
      );

      return updatedUser;
    });

    console.log("=== CALLBACK: Transaction committed successfully");
    console.log(
      "=== CALLBACK: Final result has token:",
      !!result.spotifyAccessToken
    );
  } catch (err) {
    console.error("=== CALLBACK ERROR:", err);
    throw redirect(302, "/settings");
  }

  throw redirect(302, "/settings");
};
