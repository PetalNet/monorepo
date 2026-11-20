# Janet phone

A phone call to Janet. A caller's device opens one WebSocket and streams microphone audio. The
bridge turns that into a conversation with the voice head (`apps/janet-voice-head`) and streams
Janet's voice back. The design is in [docs/janet-voice/SPEC.md](../../docs/janet-voice/SPEC.md), §14.

```text
caller ── WebSocket ──► janet-phone ──► Wyoming speech-to-text
                             │
                             └──► janet-voice-gateway ──► voice head (one conversation per call)
                                                     └──► Wyoming text-to-speech
```

One call is one head conversation at the tier the bridge is configured with, never one the caller
names. The head session has no tools, and the caller's words reach it as speech to answer, not as
instructions.

- **Disclosure first.** The first thing a caller hears is the configured `disclosure` sentence. It is
  fixed text, not model output, and the caller cannot cut it off. Its audio is kept in `cache_dir`,
  so a call opens with it at once after a restart and while the voice host is still waking.
- **Paired phones only.** A phone presents its own device token, which works only on this bridge
  and so only for the tier and channel the bridge is configured with. The bridge keeps a hash of
  each token in `devices_file`; removing an entry (or `--revoke ID`) refuses that phone's next call. A
  call already in progress runs on, for at most `max_call_s`. The
  bridge then calls the gateway with the voice head's token from `head_token_file`, which never
  reaches a phone, and forwards the request's `Cf-Access-Jwt-Assertion`, which the gateway also
  checks. A phone that is not paired gets HTTP 403 and no socket.
- **Pairing without typing.** A pairing link is `https://<host>/v1/call/pair?c=<code>&e=<expiry>`:
  only a one-time code that lasts `pair_ttl_s` seconds, so it can go in a chat message or a QR code.
  It lands on a page with one button, which opens the app with `janetcall://pair?u=…` (the bridge's
  address and the code). The phone trades the code at `POST /v1/call/pair` `{"code", "name"}` for
  `{"token", "cf_id", "cf_secret"}`: its device token and the Cloudflare Access service token it
  needs from then on. Neither is ever in a link. Both pair routes must be reachable without Access;
  the exchange answers 429 after ten attempts in a minute, counted for everyone together.
- **Signing in from the app.** With a `[signin]` table the phone can pair by signing in, with no
  link at all. The app opens `GET /v1/call/pair/signin?challenge=<PKCE S256 challenge>&state=<state>`
  in a browser. The bridge answers 302 to single sign-on with its own client id and redirect
  address, so the app knows only the bridge. Single sign-on returns the browser to `redirect_uri`
  with `code` and `state`, and the phone trades them at `POST /v1/call/pair/signin`
  `{"code", "verifier", "name"}` for the same `{"token", "cf_id", "cf_secret"}`. The bridge spends
  the code at `token_url` with the verifier, asks `userinfo_url` who signed in, and pairs the phone
  only when that `preferred_username` is in `pair_users`. A 403 with an `error` is a refusal, a
  503 means single sign-on or the Access file could not be read, and attempts count against the
  same limits as the code exchange. The client is public (PKCE, no secret), and single sign-on
  should itself allow only the owner to use it, so the bridge's check is the second of two.
- **Getting a link.** `--pair-link FILE` asks the running bridge for one and writes it to FILE, which
  only its owner can read. `GET <pair_path>` shows the same link as a QR code; it is for the
  single-sign-on proxy alone:
  a request must carry the secret in `proxy_secret_file` as `X-Janet-Pair-Proxy`, and only then is
  its `X-authentik-username` believed and checked against `pair_users`. Each pairing is announced
  through the notify command. If a paired phone is lost, unpair it and rotate the Access token.
- **Restoring an existing owner's phone.** A host administrator can run
  `janet-phone --config CONFIG --devices` to inspect device ids, names, pairing history and verification.
  After identifying the owner's physical phone, run
  `janet-phone --config CONFIG --verify-owner ID --reason "Why this device belongs to the owner"`.
  ID must contain at least 12 hex characters and match exactly one existing phone paired by
  `lab_owner`. This local command requires write access to the pairing store; there is no HTTP grant
  route. It keeps the phone's token and pairing history and records the owner, local admin authority,
  UTC time and reason in `owner_grants` before marking that device verified. Repeating a verified
  grant makes no change. Other devices, including shared links issued by the owner, stay unverified.
  With the lab gate enabled, verified owner phones receive personal tier and lab tools; other
  pairings receive guest tier. Unpair that device with `--revoke ID` to remove its access. Revoked
  devices with grants remain in the store as inactive records so their audit history survives;
  they cannot call, be granted again, or appear in `--devices`.
- **Bounded.** At most `max_calls` calls at once (503 beyond that), `max_call_s` seconds per call,
  30 s per utterance, and four utterances waiting for a turn.
- **Cut-off.** When the caller speaks over a reply, the bridge stops sending it, tells the device to
  drop what it has queued, and tells the head how much was heard.
- **Speech in order.** One producer submits sentences in text order while earlier audio plays.
  Cutting off a reply drops unsent sentences. The next reply waits for any HTTP synthesis still in
  flight. Before mixing the line tone, the bridge trims quiet chunk edges to 50 ms before speech
  and 200 ms after it, with 5 ms fades in the retained quiet edges.
- **Records of test calls stay out of the owner's room.** The bridge decides each record's
  destination in code: `owner` only when `source = "inbound"` and the channel is not a test or dev
  channel, `notebook` for everything else, including a bridge whose config does not say. The notify
  command gets it as `JANET_PHONE_DESTINATION`, and `matrix_notice.py` maps destination names to
  rooms and refuses a record whose destination has no room.
- **Call record.** When the call ends, the bridge ends the conversation and pipes a plain-text record
  (time, length, caller class, transcript) to the `notify` command. `matrix_notice.py` posts text to a
  Matrix room as a notice, from standard input or from files dropped in an `--outbox` directory. Run
  it with `--outbox` as its own process, so the bridge, which faces callers, holds no Matrix
  credential either.

## Protocol

`GET /v1/call` upgraded to a WebSocket, with `Authorization: Bearer <device token>`.

| Direction        | Message                         | Meaning                                              |
| :--------------- | :------------------------------ | :--------------------------------------------------- |
| device to bridge | binary                          | microphone audio, mono PCM16LE at 16 kHz, continuous |
| bridge to device | `{"type": "audio", "rate": n}`  | sample rate of the binary audio that follows         |
| bridge to device | binary                          | Janet's voice, mono PCM16LE, paced near real time    |
| bridge to device | `{"type": "clear"}`             | the caller cut in: drop queued audio                 |
| bridge to device | `{"type": "bye"}`, then a close | Janet ended the call                                 |

For the device's screen the bridge also sends these text messages. A device may ignore any of them.

| Message                                                        | Meaning                                                                                              |
| :------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------- |
| `{"type": "state", "value": "listening"}`                      | what Janet is doing: `listening`, `thinking` or `speaking`                                           |
| `{"type": "words", "side": "her", "text", "words": [{w,t,d}]}` | sent just before a sentence's audio; `t` and `d` are seconds from the start of that audio, estimated |
| `{"type": "words", "side": "him", "text", "words": []}`        | what the caller was heard to say                                                                     |
| `{"type": "level", "her": 0.4, "him": 0.0}`                    | about ten a second: `min(1, RMS of the last 20 ms / 6000)` of her audio and of the microphone        |

`POST /v1/call/warm` from a paired phone (empty JSON body, 202 at once) wakes the voice host, loads
the voice and the speech-to-text model, and caches the disclosure. A call does the same when it
starts. At most once a minute.

Closing the socket hangs up.

## Incoming calls

`janet-ring "<reason>"` rings one paired Android phone. The command waits for the bridge to send
a complete, successful voice-head reply with speech audio and exits zero on `audio_connected`. Filler alone and failed head turns do not count. Decline, timeout, busy, transport,
gateway and speech failures exit nonzero and print their status. This confirms audio transport to the
client, not that a person heard it. The default deadline is 45 seconds, including connection and speech.
The reason goes to the voice head as quoted, untrusted context. Its ring-call prompt is built in
`Call.reply` on every ring turn: greet, check that both sides can hear, wait for confirmation, then give the brief and
ask for the decision. The bridge reports eight seconds without caller speech to the head once;
the model decides how to re-ask. The bridge never speaks the brief before the audio check.

Enable rings on the bridge with these top-level configuration values, before any TOML table:

```toml
ring_secret_file = "/secrets/ring-root"
ntfy_url = "https://ntfy.petalcat.dev"
ring_timeout_s = 45
```

Deploy the bridge from merged main first. Keep its ring root in the vault (`janet-phone-ring-root`)
and materialize it as a mode-600 file in the bridge's existing secrets mount. Generate it once with
at least 32 bytes of random text; retain it across restarts. Rotating it changes every phone's topic.
After rotation, force-stop Janet in Android's app settings, then open it again to register the new topic.

Install the standard-library command on Janet's VM through the monorepo's installer:

```sh
apps/janet-phone/install-ring.sh --ssh dot14 --container janet-phone \
  --config /etc/janet-phone/phone.toml
~/.claude/bin/janet-ring "The water sensor needs your attention."
```

For a bridge on the same machine, omit `--ssh` and `--container` and pass its config path. The
control client sends the root only to a numeric loopback listener. SSH uses the existing host key
and key authentication; it does not put credentials in URLs. With more than one paired device,
select one with `--device <hash-prefix>` from the bridge's existing `--devices` listing.
Pass that option to the installer to keep it as the default for the one-command invocation.

Pairing derives a different unguessable ntfy topic for each device, using HMAC-SHA256 of its token
hash under the vault root. Base64url encoding keeps the complete topic within ntfy's 64-character
limit. `POST /v1/call/ring/register` returns that topic to an authenticated phone, so an existing
pairing can enable incoming calls without pairing again. The topic stays in the listener's memory.
No device bearer token or reason is published to ntfy, and message caching is disabled.

The wake message contains only an opaque ring ID and its expiry. Before showing a call the phone
fetches the reason from authenticated `POST /v1/call/ring/pending` with `{"id":"..."}`. Answering
uses the existing authenticated call socket plus `X-Janet-Ring: <id>`; the bridge reserves the live
ring for the same device token before opening a conversation. A wrong device, duplicate answer,
expired ring or revoked token cannot open that conversation. `POST /v1/call/ring/decline` accepts
`{"id":"...","status":"declined"}` (or `busy`).

Janet reads the disclosure, then "I'm calling because: <reason>", and supplies the reason to the
normal voice conversation as quoted, untrusted context. Android wake and permission setup is in
the [phone instructions](../janet-call-android/README.md).

## Configuration

```toml
listen = "127.0.0.1:8793"
gateway = "http://127.0.0.1:8792" # janet-voice-gateway
stt = "stt-host.local:10300" # Wyoming speech-to-text
tier = "guest" # the head tier every call on this bridge gets
channel = "phone"
disclosure = "Hi, this is Janet, an automated assistant for Parker. This call is being transcribed."
source = "test" # "inbound" only for a real line from the outside
notify = [
	"sh",
	"-c",
	"f=/outbox/$(date +%s%N); cat > $f.tmp && mv $f.tmp $f.$JANET_PHONE_DESTINATION.txt",
]
record_dir = "" # set to keep both sides of every call as WAV files
cache_dir = "/state/cache" # the disclosure's audio, kept across restarts
max_calls = 2 # the head's own max_open is the real ceiling
head_token_file = "/secrets/head-token" # the voice head's bearer token
devices_file = "/state/devices.json" # paired phones, by token hash
http_listen = "127.0.0.1:8794" # pairing page and pairing exchange
public_url = "wss://voice.example/v1/call" # where a paired phone calls
access_file = "/secrets/access.json" # {"client_id", "client_secret"} of the Access service token
pair_users = ["owner"] # single sign-on usernames that may pair a phone
pair_path = "/pair"
proxy_secret_file = "/secrets/proxy-secret" # the header value the single-sign-on proxy adds
max_call_s = 900

[signin] # leave the table out to turn signing in off
authorize_url = "https://sso.example/application/o/authorize/" # where the phone's browser is sent
token_url = "http://127.0.0.1:9000/application/o/token/" # may be the provider's own listener
userinfo_url = "http://127.0.0.1:9000/application/o/userinfo/"
client_id = "the public client's id"
redirect_uri = "janetcall://signin"

turn_models = "/models" # silero_vad.onnx and the Parakeet files: the shared turn detector (below)
line_tone = "AL4 AT40 AH400 AW83 BC2 BL11 BR7 BF2 BO6 DL0 DW48 U37 V80" # the call's background sound (below); empty is off

[endpoint] # the fallback loudness detector, used only without turn_models
threshold = 500
silence_ms = 700
```

**When a turn ends.** With `turn_models`, the bridge uses the same turn detector as janet-mac
([`packages/janet-turn`](../../packages/janet-turn)): Silero VAD, a streaming speech model and a fitted judge. A
pause of 3 s ends a turn; after an "um" or a trailing "and" it waits 6 s; when the words are finished it ends
after 1 to 2.5 s. Without `turn_models`, or if the models fail to load, a call uses the loudness rule in `[endpoint]`.

**The line tone.** With `line_tone`, the bridge keeps a quiet sound under the call so the caller knows the line is open
([`packages/janet-line`](../../packages/janet-line), ported from the tuning page; the value is that page's code): comfort noise
while listening, a low hum that fades in while Janet works on a reply and out when she speaks, and everything ducked under her
voice. It is mixed into the audio the bridge already sends, from the pipeline's state (listening, thinking, speaking). To retune it,
send a new code and set `line_tone`.

**Hang-up earcon and who ended the call.** With `hangup_earcon` (the earcon code of [`packages/janet-line`](../../packages/janet-line),
e.g. `"HL40 HP880 HI5 HN150 HG30"`: level, first pitch in Hz, fall in semitones, note and gap length in ms), a short soft descending
blip is played before the line closes whenever Janet ends the call (the head ends the conversation, or the call reaches `max_call_s`).
A hang-up from the phone or a dropped connection gets none. Each call's last log line says which: `ended by Janet (...)` or
`ended by the far side (close code ..., the phone's microphone was last heard N s ago)`, and `no audio from the phone for 5 s` is
logged when the microphone uplink stops while the socket is still open.

Run it with `python janet_phone.py --config /path/to/phone.toml`, or build the `Dockerfile` from the repository root
(`docker build -f apps/janet-phone/Dockerfile .`); the image carries the models.

## Limits

- End of speech is a loudness threshold and a fixed silence. `Endpointer` is the one place a better
  detector plugs in.
- A reply is synthesized one whole sentence at a time, so the first audio of a reply waits for the
  first sentence.
- Cut-off relies on the calling device cancelling its own echo. A device that plays Janet through a
  loudspeaker without echo cancellation will cut her off with her own voice.
- The Access assertion a call starts with is used for the whole call. A call that outlasts it (24
  hours by default) loses its last turns.
- The head ends a conversation that sits idle. When that happens mid-call (a sleeping voice host can
  take minutes to say the disclosure), the call continues in a new conversation, which does not
  remember the earlier turns. A ring-initiated call closes if its head expires, since a fresh head
  would lose the audio check and decision context. Expiry before initial ring success returns nonzero.
- The call record carries the caller's words. Post it where a person reads it, not where an agent
  with tools takes messages as instructions.

## Tests

The tests run the real bridge against a fake gateway and a fake speech-to-text server:

```sh
python -m unittest discover -s tests -t .
```

`python tools/prove-ring.py` additionally uses the actual lab ntfy server and the command's HTTP
control path for ring, authenticated answer with PCM audio, decline and timeout. Speech and the
voice gateway remain test servers. It creates an ephemeral device and topic, publishes no reason
to ntfy, and does not call a real phone. It needs the same dependencies as the test suite.

`lab_token_file` optionally points to the bridge's separate internal voice-lab credential, and
`lab_owner` defaults to `parker`. On a personal line, only a device enrolled via direct SSO as
that owner receives a personal head with lab access. Shared pairing links, old device records,
other identities and guest lines get guest heads. Re-sign in after upgrading to establish the
verified identity. The lab token is read by the bridge, never accepted from a phone or returned
by pairing. With `lab_token_file` unset, the configured tier keeps its existing behavior.
Use the matching head/gateway version with the lab gate enabled before enabling
this setting; see the head's README for the fixed read-only allowlist and provisioning.
