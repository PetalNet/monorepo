# Google Maps API Setup Guide

PetalBoard uses Google Maps API to provide fancy address autocomplete and map visualization for event locations.

## Step 1: Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Note your project ID for reference

## Step 2: Enable Required APIs

Enable the following APIs in your Google Cloud project:

1. **Maps JavaScript API** - For displaying the map
2. **Places API** - For address autocomplete
3. **Geocoding API** - For converting addresses to coordinates (optional but recommended)

To enable these:

1. Go to **APIs & Services** → **Library**
2. Search for each API name
3. Click **Enable** for each

## Step 3: Create an API Key

1. Go to **APIs & Services** → **Credentials**
2. Click **Create Credentials** → **API Key**
3. Copy your API key (it will look like: `AIzaSyBxxxxxxxxxxxxxxxxxxxxxxxxxxx`)

## Step 4: Secure Your API Key (Recommended)

For production, restrict your API key:

1. Click on your API key in the Credentials page
2. Under **Application restrictions**:
   - Choose **HTTP referrers (web sites)**
   - Add your domains:
     - `http://localhost:5173/*` (for development)
     - `https://yourdomain.com/*` (for production)
3. Under **API restrictions**:
   - Choose **Restrict key**
   - Select:
     - Maps JavaScript API
     - Places API
     - Geocoding API
4. Click **Save**

## Step 5: Update Your .env File

Open the `.env` file in the project root and update:

```env
# Google Maps API
PUBLIC_GOOGLE_MAPS_API_KEY="AIzaSyBxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

Replace `AIzaSyBxxxxxxxxxxxxxxxxxxxxxxxxxxx` with your actual API key.

**Important Notes:**

- The variable name MUST start with `PUBLIC_` because it's used in the browser
- Never commit real API keys to version control
- For production, use environment variables from your hosting provider
- Consider using API key restrictions to prevent unauthorized use

## Step 6: Test the Integration

1. Start the dev server: `pnpm dev`
2. Navigate to the event creation page
3. Start typing an address in the Location field
4. You should see autocomplete suggestions
5. Select an address to see the map appear with a marker

## Features

The address input provides:

✅ **Smart Autocomplete** - As you type, get address suggestions
✅ **Interactive Map** - See the selected location on a beautiful map
✅ **Visual Feedback** - Animated marker drop when selecting a location
✅ **Clear Button** - Easy way to remove the selected location
✅ **Graceful Fallback** - If API key is not configured, users can still type addresses manually

## Troubleshooting

### "Google Maps API key not configured"

- Make sure you've added `PUBLIC_GOOGLE_MAPS_API_KEY` to your `.env` file
- Ensure the variable name starts with `PUBLIC_`
- Restart the dev server after changing `.env`

### Autocomplete not working

- Check that the **Places API** is enabled in your Google Cloud project
- Verify your API key has access to the Places API
- Check browser console for errors

### Map not displaying

- Ensure **Maps JavaScript API** is enabled
- Check for API key restrictions that might be blocking your domain
- Verify billing is enabled on your Google Cloud account (required for production use)

### "RefererNotAllowedMapError"

- Your domain is not authorized in the API key restrictions
- Add your domain to the HTTP referrers list in API key settings

## Pricing

Google Maps Platform has a generous free tier:

- **$200 free credit per month**
- Maps JavaScript API: ~28,000 loads/month free
- Places API Autocomplete: ~17,000 requests/month free

For most small to medium-sized event management apps, you'll stay within the free tier.

Monitor usage: [Google Cloud Console → Billing](https://console.cloud.google.com/billing)

## Alternative: Skip Google Maps

If you don't want to use Google Maps:

1. Leave `PUBLIC_GOOGLE_MAPS_API_KEY` unset or set to placeholder
2. The app will gracefully degrade to a regular text input
3. Users can still enter locations manually (like "Online" or "123 Main St")

The address autocomplete and map are enhancements, not requirements.
