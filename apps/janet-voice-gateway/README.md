# Janet voice gateway

One authenticated HTTP door for a voice client that is not on the lab network, such as
[Janet for macOS](../janet-mac). It sits behind a reverse proxy and gives the client two things:

- the voice head's (`apps/janet-voice-head`) conversation API, passed through;
- speech from a [Wyoming](https://github.com/OHF-Voice/wyoming) text-to-speech server such as
  [chatterbox-wyoming](../chatterbox-wyoming), and Wake-on-LAN for the host that runs it.

## API

Bearer token on everything except `GET /health`. It is the voice head's token. With an `[access]`
section in the config, the same routes also need a valid Cloudflare Access token (below).

| Call                                              | Reply                                              |
| :------------------------------------------------ | :------------------------------------------------- |
| `GET /health`                                     | `{"ok": true, "version"}`                          |
| `POST /v1/conversations`, `…/{id}/turns`, `…/{id}/interrupt`, `…/{id}/end` | the head's status and body |
| `POST /v1/tts` `{"text"}`                         | `audio/wav` (mono PCM16), or 503 while the voice host wakes |
| `GET /v1/voice`                                   | `{"state": "up" \| "asleep"}`                      |
| `POST /v1/voice/wake`                             | `{"sent": true}`                                   |

- **Head routes.** Only the four conversation routes reach the head. The gateway forwards the
  caller's `Authorization` header as it came, so the head checks the same token a second time. A
  turn's `text/event-stream` is relayed line by line as the head produces it. The path sent to the
  head is rebuilt from the checked conversation id and action, never copied from the request.
- **Speech.** One request is one sentence. The response headers go out as soon as the voice server
  accepts the connection, and the WAV follows when it is synthesized: a cold voice model can take
  longer to load than a proxy waits for headers. If the voice server fails part-way the transfer is
  cut without its final chunk, so the client sees a failed download and not half a sentence.
- **Sleeping voice host.** When nothing answers on the voice server's port, `POST /v1/tts` sends a
  Wake-on-LAN packet and returns 503 with `{"state": "waking"}` and `Retry-After: 5`. The client
  shows the text and asks again.

## Configuration

Every host-specific value comes from a TOML file outside the repository:

```toml
listen = ["127.0.0.1:8792"]
token_file = "/path/to/voice-head-token"   # the same file the voice head uses
head = "http://127.0.0.1:8791"

[voice]
wyoming = "gpu-host.local:10230"
name = "default"                           # the Wyoming voice name
mac = "aa:bb:cc:dd:ee:ff"                  # the voice host's network card
broadcast = "192.0.2.255:9"                # broadcast address of the network both hosts share

[access]                                   # optional; see Exposure
certs_url = "https://<team>.cloudflareaccess.com/cdn-cgi/access/certs"
issuer = "https://<team>.cloudflareaccess.com"
audience = "<the Access application's AUD tag>"
```

Run it:

```sh
python janet_voice_gateway.py --config /path/to/gateway.toml
```

The gateway must run on the same layer-2 network as the voice host, because a wake packet is a
broadcast. It has no dependency outside the Python standard library.

## Exposure

Put it behind a proxy that authenticates the caller before the request arrives, and do not publish
the port. The bearer token is the second check, not the only one.

Behind Cloudflare Access, set `[access]`. Access signs every request it lets through
(`Cf-Access-Jwt-Assertion`), and the gateway then refuses any request without a signature made by
that team's keys for that application and still in date. A request that reaches the gateway some
other way, from the proxy's own host or from the local network, has no such signature, so Access
cannot be skipped. The gateway fetches the signing keys from `certs_url` and fails closed when it
cannot.

Each connection carries one request and is then closed. A request with a chunked body or a
`Content-Length` that is not a plain number is refused.

## Tests

```sh
python -m unittest discover -s . -t .
```
