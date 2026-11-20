# Ask Janet to call

The HA trigger and encrypted Matrix delivery are deployed on `10.10.10.14`. Google voice activation still needs Google Home pairing and a routine in Parker's account. No Google account was accessed.

HA Cloud reports `logged_in: false`. HA's Matter integration has no entries. A separate Matterbridge 3.11.4 with matterbridge-hass 1.7.0 now exposes only `input_boolean.janet_call_me`. HA lists Google Home and Google Home Mini speakers, but both report `unavailable`. Bring a compatible hub online before pairing. The HA Matter Server is a controller; it does not replace this bridge.

## Finish the Google setup

1. Bring the Google Home Mini, or another [supported Google Home Matter hub](https://support.google.com/googlehome/answer/12391458), online on the same network as `10.10.10.14`. IPv6 and local multicast must work between them.
2. On Parker's Mac, open a terminal and run `ssh -N -L 8283:127.0.0.1:8283 docker@10.10.10.14`. Open `http://localhost:8283` in Chrome. The Matterbridge page shows the bridge's pairing QR code. Keep the pairing code private.
3. On Parker's Android phone, open Google Home using his existing account. Select the home containing the online hub. Choose **Add → Device → Matter-enabled device** and scan the QR code on the Mac. If Google warns that the software bridge is uncertified, this is the expected development bridge. Complete pairing and assign **Janet call me** to a room named **Lab**.
4. Tap the **Janet call me** device once. Expect it to turn off again and a message to appear in janet-dm. This is the first test that crosses Google's Matter connection.
5. In Mac Chrome, open [Google Home for web](https://home.google.com/), select the same home, and open **Automations → Add new**. If offered, enable the script editor's Public Preview. Paste [google-home.yaml](google-home.yaml), choose the device from the editor's autocomplete, then **Validate → Save → Activate**. The YAML assumes the device is named **Janet call me** in room **Lab**. If assigned elsewhere, use the exact name from autocomplete.
6. On the S23+, open Gemini's profile menu and **Connected Apps**, then enable Google Home for the same account. [Google documents Google Home device control and routine launch from Gemini](https://support.google.com/gemini/answer/15335456).
7. Say **Hey Google, Janet please call me**. Check janet-dm for the new request. Repeat with the phone on cellular, and then through Android Auto while parked. Voice recognition, account permissions, and Android Auto have not been tested here.

If Gemini does not launch the custom phrase, try **Hey Google, turn on Janet call me**. This directly targets the same device. If Google cannot reach the bridge, restore the hub connection. Nabu Casa is an alternative, but requires signing into HA Cloud and an active subscription before Google linking. Neither is currently configured.

The existing Android app has a **Call Janet** launcher shortcut that starts an outbound call. It does not implement this request for Janet to ring back, and Gemini shortcut discovery has not been verified.

The script uses Google's documented [OkGoogle starter](https://developers.home.google.com/automations/schema/reference/entity/assistant/ok_google_event) and [OnOff action](https://developers.home.google.com/automations/schema/reference/entity/sht_device/on_off_command). Account-specific device validation remains part of step 5.

## What runs

`automation.yaml` resets the switch, snapshots the request time and phone tracker, and sends the request. `input_datetime.janet_call_last_request` suppresses repeat triggers for 60 seconds. `input_text.janet_call_pending` retains the compact snapshot until the relay accepts it. A startup trigger and a once-per-minute trigger recover pending requests. Requests during a delivery outage coalesce into the oldest pending call request.

The snapshot includes the tracker update time, GPS accuracy, and coordinates rounded to six decimal places. A long zone name is explicitly described as a known zone with a long name. Missing coordinates are labeled unavailable; a tracker report older than ten minutes at request time is labeled potentially stale. The automation uses the last HA report and does not claim to force a fresh GPS fix.

`rest-command.yaml` POSTs to HA's own loopback port 19911. `janet-call-tunnel.service` carries that connection over SSH to the Shawn relay's loopback port 9911 on `.14`. The SSH add-on's persisted `ssh.allow_tcp_forwarding` option is enabled, with `GatewayPorts no`. The request's bearer token and location do not cross the LAN in plaintext on this hop.

`shawn-relay.patch` adds an authenticated `/janet-call` endpoint to the existing Python relay. It validates and durably enqueues through `sender.py`, then returns 202. The existing `/alert` and `/truenas` routes retain their behavior. Python is used because this extends the existing Python relay and reuses its installed matrix-nio encryption environment.

`janet-call-sender.service` drains the SQLite queue as `@minijanet:mx.petalcat.dev`, using a dedicated Matrix device and persistent key store. It sends only to `!FccCIgRbxzylIkvkNk:mx.petalcat.dev`, requires that room to be encrypted, and mentions Janet. The stable Matrix transaction ID prevents duplicate delivery after a crash between send and local receipt. Conflicting payloads for one ID are rejected. Delivered message bodies are cleared, SQLite secure deletion is enabled, and the WAL is checkpointed and truncated. Hashes and event receipts remain for deduplication.

Janet should respond to a fresh request by running:

```sh
janet-ring "you asked me to call"
```

She should check the request timestamp before acting on a request delivered after an extended outage. The ring command and phone behavior belong to the parallel `janet-ring` builder.

## Deployment paths

On `.14`, source and units are in `/home/docker/.local/lib/janet-call-trigger/`. Runtime state and credentials are in `/home/docker/.local/state/janet-call-trigger/`, mode 0700. The sender uses `/home/docker/.claude/system-sender/venv/bin/python`. Its dedicated account file and crypto store stay on local disk.

Matterbridge's pinned npm install is `/home/docker/.local/lib/janet-call-matter/`. Its state, private HA token, and pairing material are in `/home/docker/.local/state/janet-call-matter/`. The frontend binds only `127.0.0.1:8283`; Matter UDP uses `ens18:5540`. The `--novirtual` flag disables reboot and update control devices. The HA plugin's whitelist is exactly `["input_boolean.janet_call_me"]`. Health is available at `http://127.0.0.1:8283/health` on `.14`.

HA stores the automation in `/config/automations.yaml`; the API ID is `janet_call_request`. The REST command is in `/config/configuration.yaml`. The three helpers were created through HA's WebSocket API. Copies of the automation, REST command, units, and relay patch live beside this file. No existing versioned HA automation collection was found in the current checkout.

The initial private configuration backup and relay backup are in `.14:/home/docker/.local/state/janet-call-trigger/`. The HA config backup is `/config/configuration.yaml.before-janet-call-20261120`. Backups can contain unrelated credentials and must stay private.

## Verify or disable

Run the queue tests from the monorepo root:

```sh
python3 -m unittest discover -s apps/janet-phone/ha-trigger/tests -v
```

Inspect the deployed services:

```sh
ssh docker@10.10.10.14 'systemctl is-active shawn-relay janet-call-sender janet-call-tunnel janet-call-matter'
```

For a live test, turn on `input_boolean.janet_call_me` in HA. This sends a real call request. Expect the switch to reset, the pending text to clear after acceptance, and one encrypted message to arrive in janet-dm. A second trigger within 60 seconds must reset without a second request.

Disable `automation.janet_call_request` in HA to stop requests. To remove the bridge and sender, stop and disable `janet-call-matter`, `janet-call-sender`, and `janet-call-tunnel` on `.14`. Remove only the `/janet-call` addition from the Shawn relay, then restart that relay. Remove only `janet_call_request` from HA's REST commands and reload them. Do not restore the full old HA config over unrelated later changes. The SSH forwarding setting can be returned to its recorded previous value once no tunnel needs it.

## Recorded checks

On 2026-11-20, the initial HA entity did not exist and the dedicated delivery queue had no rows. The deployed HA API trigger subsequently produced encrypted event `$pbr_75JCHMTD3e0kX7Cx65L5ZCbOmJbrM1x3gcNm5so` in one observed run of about four seconds. Janet's own Matrix reader decrypted its timestamp, zone, and Maps link. The duplicate trigger produced one request total and left the switch off.

After review fixes, an observed normal run produced `$NSdpzNUuvM8RtJn2YdA9phW_s22ySGf6QSQ4AIWdSkw` in about 2.5 seconds. The receipt was queried using Janet's account, and Janet's Matrix reader decrypted all expected fields. The local delivered body and HA pending snapshot were cleared. These are individual delivery observations, not a latency guarantee or a Google voice test.

A sender outage retained a queued request and delivered it after restart. A replay of an accepted HTTP request after sender restart kept the same receipt. Invalid authorization returned 401; an authenticated invalid request returned 400. Five queue tests cover invalid inputs, Unicode size limits, conflicting IDs, identical retries, delivered-body removal, and migration of existing receipts.

With the SSH tunnel stopped, HA retained the pending snapshot and reset the switch. Reloading the automation canceled the active delivery attempt without removing that snapshot. After the tunnel returned, the automation's recovery path delivered `$iQcJfqrWEo3Zx2QHJHLTk0QybMc84YISID3pg-ubqZc` once and cleared the snapshot. A full HA core restart was deliberately avoided because the existing Bluetooth integration can fail after restart. The startup recovery path is configured but has not been exercised through an actual core restart.

HA's real template renderer passed synthetic cases for missing, stale, and fresh coordinates. The delivery database ended with four receipts, zero pending rows, zero retained delivered bodies, and a zero-byte WAL.

Matterbridge's API reports exactly one bridged endpoint, **Janet call me**, and its health check passes. No Google pairing, Google account routine validation, cellular voice test, or Android Auto test has been performed. No dorm lamps were actuated, and HA core was not restarted.

The implementation was reviewed through the router by **gpt-6.1-sol:high**. Its findings prompted message-size bounds, conflict rejection, delivered-body removal, persistent HA recovery, and the SSH transport.
