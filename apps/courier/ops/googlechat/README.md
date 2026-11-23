# Google Chat bot cookie compatibility

The bot's released Google Chat bridge accepts five legacy cookies. Consumer accounts can also require `__Secure-1PSIDTS` and related cookies. This patch preserves those fields, sends their exact wire names and saves rotated cookies through the existing bridge database. It targets mautrix/googlechat commit `a835bccd269eace6c28196a3f869eb1fb3c8acf7`, whose four affected files match the deployed 0.5.2 bot. It also enables certificate verification in the bridge HTTP request method.

This is a local compatibility patch. Fake captures and a loopback HTTPS server test the importer, cookie wire format, rotation, deletion, persistence failure, concurrent saves, and SQLite reload. They do not establish successful Google authentication or session longevity. Upstream [issue 115](https://github.com/mautrix/googlechat/issues/115) documents the additional cookie requirement. No inspected maintained fork solves both capture and rotation persistence. Beeper Cloud support alone does not establish this bot account's eligibility.

## Prepare and test

Keep virtual environments and build caches over 200 MB on the lab NAS. From this directory:

```sh
mkdir -p sources
git clone https://github.com/mautrix/googlechat.git sources/upstream
git -C sources/upstream checkout a835bccd269eace6c28196a3f869eb1fb3c8acf7
uv sync --locked --group test
uv run --no-sync python build_patch.py
uv run --no-sync python -m unittest -v test_importer test_rotation test_submit
uv run --locked python import_curl.py < fixtures/firefox-fake.curl
```

The generator checks the upstream commit and exact replacement anchors. It writes `patched/` and the reviewable patch. Use the generated packages as a bot-only `PYTHONPATH` overlay; preserve the existing venv and installed dependencies. The overlay needs `maugclib/` and `mautrix_googlechat/` from `patched/`. Use the existing bot config and database. Disable bbctl updates and config regeneration with `--no-update --no-override-config --custom-startup-command` pointing to the bot's existing venv Python executable. The Python command's `-m mautrix_googlechat -c config.yaml` arguments remain under bbctl's control.

Back up the bot configuration and SQLite database first. Retain the stopped original container with restart disabled. Never run both bridge instances against the same session. Rollback stops the replacement before removing the overlay launch and starting the original. Do not change Parker's personal bridges or copy their sessions.

## Import a fresh capture

Give Parker [the Mac capture instructions](CAPTURE-MAC.md) after installation and offline verification. Check the vault note's existence and revision metadata first. Do not replay old captures automatically.

`import_curl.py` parses a single root Google Chat Copy-as-cURL capture without executing shell text. Its CLI prints only validation metadata. `submit_capture.py` additionally submits it to the isolated bot's configured loopback provisioning API. It verifies `petalcat27@gmail.com`, leaves an existing login alone, and stops after one rejection. An unexpected newly authenticated account is logged out. The adapter reads the capture from stdin and the provisioning credential directly from the bot configuration. It never writes or prints either.

Run the adapter inside `bot-gchat`, using the existing venv Python. Pass a newly approved vault capture through stdin directly, without an intermediate file or shell argument. The expected config is `/root/.local/share/bbctl/prod/sh-gchat/config.yaml`. Do not use the adapter for an unrelated account or bridge. The importer rejects captures larger than the vault-drop form's 8,192-byte limit.

A login-success result is followed by account and connection checks. Once connected, verify the existing Eli DM's account identity and actual portal MXID before changing Courier. Keep the staged Google Chat mapping empty until that portal exists. Explicitly join both portals as the existing Courier account, preserving its device and crypto stores. End-to-end delivery tests need authorized participants.
