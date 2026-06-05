import { json } from '@sveltejs/kit';
import { readFileSync } from 'node:fs';
import { env } from '$env/dynamic/private';

// ElevenLabs text-to-speech for the reader's "listen" button.
// Key resolution: $ELEVEN_API_KEY, else /data/eleven-api-key (the mounted data dir).
// No key → 503, and the client quietly falls back to the browser's Web Speech API.
function apiKey() {
  if (env.ELEVEN_API_KEY) return env.ELEVEN_API_KEY.trim();
  try { return readFileSync('/data/eleven-api-key', 'utf8').trim() || null; } catch { return null; }
}

// Whitelisted voices — the client sends a KEY, never a raw voice id, so a request
// can't drive arbitrary use of our ElevenLabs account. These IDs are voices that
// exist in the account (free tier). 'agent-a' = Alice's cloned show voice via
// $ELEVEN_VOICE_ID once the clip is uploaded. Tom + the other library voice Alice
// linked are SHARED voices that must be "Add to my voices"'d in the EL UI first;
// once they show in /v1/voices, drop their account ids here.
const VOICES = {
  george: 'JBFqnCBsd6RMkjVDRZzb',  // warm, captivating storyteller (default narrator)
  river: 'SAz9YHcvj6GT2YYXdXww',   // relaxed, neutral, informative
  brian: 'nPczCjzI2devNBz1zQrb',   // deep, resonant, comforting
  sarah: 'EXAVITQu4vr4xnSDxMaL'    // mature, reassuring, confident
};
function resolveVoice(pick) {
  const agent-a = env.ELEVEN_VOICE_ID?.trim();
  if (pick === 'agent-a') return agent-a || VOICES.george;       // cloned Agent-a, else a narrator until ready
  if (VOICES[pick]) return VOICES[pick];
  return agent-a || VOICES.george;                             // default
}

export async function POST({ request }) {
  const key = apiKey();
  if (!key) return json({ error: 'no-tts-key' }, { status: 503 });

  let text = '', pick = '';
  try { ({ text, voice: pick } = await request.json()); } catch {}
  text = String(text || '').trim();
  if (!text) return json({ error: 'empty' }, { status: 400 });
  if (text.length > 5000) text = text.slice(0, 5000); // keep latency + cost sane

  const voice = resolveVoice(String(pick || 'agent-a').toLowerCase());
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
