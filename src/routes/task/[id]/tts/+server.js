import { json } from '@sveltejs/kit';
import { readFileSync } from 'node:fs';
import { env } from '$env/dynamic/private';

// ElevenLabs text-to-speech for the reader's "listen" button.
// Key resolution: $ELEVEN_API_KEY, else /data/eleven-api-key (the mounted data dir).
// No key → 503, and the client quietly falls back to the browser's Web Speech API.
// Rachel is a clean, neutral narrator voice; override with $ELEVEN_VOICE_ID.
function apiKey() {
  if (env.ELEVEN_API_KEY) return env.ELEVEN_API_KEY.trim();
  try { return readFileSync('/data/eleven-api-key', 'utf8').trim() || null; } catch { return null; }
}

export async function POST({ request }) {
  const key = apiKey();
  if (!key) return json({ error: 'no-tts-key' }, { status: 503 });

  let text = '';
  try { ({ text } = await request.json()); } catch {}
  text = String(text || '').trim();
  if (!text) return json({ error: 'empty' }, { status: 400 });
  if (text.length > 5000) text = text.slice(0, 5000); // keep latency + cost sane

  const voice = env.ELEVEN_VOICE_ID?.trim() || '21m00Tcm4TlvDq8ikWAM'; // Rachel
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({
      text,
      model_id: 'eleven_turbo_v2_5',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 }
    })
  });
  if (!r.ok) return json({ error: 'tts-upstream', status: r.status }, { status: 502 });

  return new Response(r.body, {
    headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' }
  });
}
