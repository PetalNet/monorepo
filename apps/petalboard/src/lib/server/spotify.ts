import { env } from "$env/dynamic/private";

const SPOTIFY_CLIENT_ID = env.SPOTIFY_CLIENT_ID || "";
const SPOTIFY_CLIENT_SECRET = env.SPOTIFY_CLIENT_SECRET || "";
const SPOTIFY_REDIRECT_URI =
  env.SPOTIFY_REDIRECT_URI || "http://localhost:5173/api/spotify/callback";

export interface SpotifyTrack {
  id: string;
  name: string;
  artists: Array<{ name: string }>;
  album: {
    name: string;
    images: Array<{ url: string; height: number; width: number }>;
  };
  uri: string;
  preview_url: string | null;
  duration_ms: number;
}

export interface SpotifySearchResult {
  tracks: {
    items: SpotifyTrack[];
  };
}

export interface SpotifyTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

export function getSpotifyAuthUrl(state: string): string {
  const scopes = [
    "playlist-modify-public",
    "playlist-modify-private",
    "playlist-read-private",
    "playlist-read-collaborative",
  ].join(" ");

  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: SPOTIFY_REDIRECT_URI,
    scope: scopes,
    state,
  });

  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

export async function exchangeCodeForToken(
  code: string
): Promise<SpotifyTokenResponse> {
  console.log("Exchanging code for token, redirect URI:", SPOTIFY_REDIRECT_URI);

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(
        `${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`
      ).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: SPOTIFY_REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error("Spotify token exchange failed:", response.status, error);
    throw new Error(
      `Failed to exchange code for token: ${response.status} - ${error}`
    );
  }

  const data = await response.json();
  console.log(
    "Token exchange successful, got access_token:",
    !!data.access_token
  );
  return data;
}

export async function refreshAccessToken(
  refreshToken: string
): Promise<SpotifyTokenResponse> {
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(
        `${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`
      ).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    throw new Error("Failed to refresh access token");
  }

  return response.json();
}

export async function searchTracks(
  query: string,
  accessToken: string
): Promise<SpotifySearchResult> {
  const params = new URLSearchParams({
    q: query,
    type: "track",
    limit: "20",
  });

  const response = await fetch(
    `https://api.spotify.com/v1/search?${params.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error("Failed to search tracks");
  }

  return response.json();
}

export async function createPlaylist(
  userId: string,
  name: string,
  description: string,
  accessToken: string
): Promise<{ id: string; external_urls: { spotify: string } }> {
  const response = await fetch(
    `https://api.spotify.com/v1/users/${userId}/playlists`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        description,
        public: false,
      }),
    }
  );

  if (!response.ok) {
    throw new Error("Failed to create playlist");
  }

  return response.json();
}

export async function addTracksToPlaylist(
  playlistId: string,
  trackUris: string[],
  accessToken: string
): Promise<void> {
  if (trackUris.length === 0) {
    return;
  }

  const response = await fetch(
    `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        uris: trackUris,
      }),
    }
  );

  if (!response.ok) {
    throw new Error("Failed to add tracks to playlist");
  }
}

export async function removeTracksFromPlaylist(
  playlistId: string,
  trackUris: string[],
  accessToken: string
): Promise<void> {
  if (trackUris.length === 0) {
    return;
  }

  const response = await fetch(
    `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tracks: trackUris.map((uri) => ({ uri })),
      }),
    }
  );

  if (!response.ok) {
    throw new Error("Failed to remove tracks from playlist");
  }
}

export async function replacePlaylistTracks(
  playlistId: string,
  trackUris: string[],
  accessToken: string
): Promise<void> {
  const head = trackUris.slice(0, 100);
  const response = await fetch(
    `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ uris: head }),
    }
  );

  if (!response.ok) {
    throw new Error("Failed to replace playlist tracks");
  }

  for (let index = 100; index < trackUris.length; index += 100) {
    const chunk = trackUris.slice(index, index + 100);
    await addTracksToPlaylist(playlistId, chunk, accessToken);
  }
}

export async function getSpotifyProfile(
  accessToken: string
): Promise<{ id: string; display_name: string; email: string }> {
  const response = await fetch("https://api.spotify.com/v1/me", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error("Failed to get Spotify profile");
  }

  return response.json();
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  description: string | null;
  external_urls: { spotify: string };
  images: Array<{ url: string; height: number | null; width: number | null }>;
  tracks: { total: number };
}

export async function getUserPlaylists(
  accessToken: string
): Promise<SpotifyPlaylist[]> {
  const response = await fetch(
    "https://api.spotify.com/v1/me/playlists?limit=50",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error("Failed to get user playlists");
  }

  const data = await response.json();
  return data.items;
}

export async function getPlaylist(
  playlistId: string,
  accessToken: string
): Promise<SpotifyPlaylist> {
  const response = await fetch(
    `https://api.spotify.com/v1/playlists/${playlistId}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error("Failed to get playlist");
  }

  return response.json();
}
