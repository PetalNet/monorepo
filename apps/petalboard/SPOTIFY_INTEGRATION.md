# Spotify Playlist Integration

This feature allows event hosts to add collaborative playlist questions to their events. Guests can search for and suggest songs that will be collected for the event playlist.

## Setup

### 1. Create a Spotify App

1. Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
2. Log in with your Spotify account
3. Click "Create App"
4. Fill in the details:
   - App Name: PetalBoard
   - App Description: Event management with collaborative playlists
   - Redirect URI: `http://localhost:5173/api/spotify/callback` (for development)
   - For production, add: `https://yourdomain.com/api/spotify/callback`
5. Copy the **Client ID** and **Client Secret**

### 2. Add Environment Variables

Add these to your `.env` file:

```
SPOTIFY_CLIENT_ID=your_client_id_here
SPOTIFY_CLIENT_SECRET=your_client_secret_here
SPOTIFY_REDIRECT_URI=http://localhost:5173/api/spotify/callback
```

For production, update the `SPOTIFY_REDIRECT_URI` to your production domain.

### 3. Database Migration

The schema has been updated with Spotify fields. Run:

```bash
npx prisma generate
npx prisma db push
```

## How It Works

### For Event Hosts

1. **Connect Spotify Account**

   - Go to Settings
   - Click "Connect Spotify" in the Spotify Integration section
   - Authorize PetalBoard to access your Spotify account
   - This allows you to create playlist questions

2. **Add Playlist Question**

   - When creating or editing an event, select question type "Spotify Playlist"
   - This question type requires Spotify authentication
   - If not connected, you'll be prompted to connect your account

3. **View Song Submissions**
   - In the event management RSVPs tab, see all song suggestions
   - Songs are stored as JSON with track info (name, artist, album, Spotify URI)
   - You can create a playlist from these suggestions

### For Guests

1. **RSVP with Song Suggestion**
   - When RSVPing to an event with a playlist question
   - Use the song search to find tracks on Spotify
   - Select a song to add to your RSVP
   - No Spotify account needed for guests!

## Files Created/Modified

### New Files

- `src/lib/server/spotify.ts` - Spotify API utilities
- `src/lib/components/SpotifySongSelector.svelte` - Song search component
- `src/routes/api/spotify/auth/+server.ts` - OAuth initiation
- `src/routes/api/spotify/callback/+server.ts` - OAuth callback
- `src/routes/api/spotify/search/+server.ts` - Song search API

### Modified Files

- `prisma/schema.prisma` - Added Spotify fields to User and Event models
- `src/routes/settings/+page.svelte` - Added Spotify connection UI
- `src/routes/settings/+page.server.ts` - Added disconnect action

## Question Type: "spotify_playlist"

When a question has `type: "spotify_playlist"`, the response `value` is stored as JSON:

```json
{
  "id": "spotify_track_id",
  "name": "Song Name",
  "artists": [{ "name": "Artist Name" }],
  "album": {
    "name": "Album Name",
    "images": [{ "url": "image_url" }]
  },
  "uri": "spotify:track:xxx",
  "preview_url": "preview_url_if_available",
  "duration_ms": 240000
}
```

## Token Management

- Access tokens expire after 1 hour
- Refresh tokens are stored and used to get new access tokens automatically
- Token refresh happens automatically during API requests

## Security

- OAuth state parameter prevents CSRF attacks
- Tokens are stored encrypted in the database
- Only event hosts need Spotify accounts
- Guests can search without authentication (uses host's token)

## Future Enhancements

- Auto-create Spotify playlists from event responses
- Show playlist preview in event public view
- Allow hosts to curate/moderate song suggestions
- Support for Apple Music, YouTube Music, etc.
