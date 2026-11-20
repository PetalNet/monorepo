# Parker-only read-only voice access proof

On 2026-11-20, the opt-in `apps/janet-voice-head/tests/prove_lab_call.py` ran the changed Python stack with real Claude (Sonnet for Parker, Haiku for the guest), the real stdio MCP server, live `systemctl --user`, the HTTP gateway, paired-device admission, `Call.reply`, and Wyoming synthesis at `10.10.10.152:10230`. The scripted input was the STT text, "what builders are running?" An isolated parent session, device registry, and hub kept the test out of main Janet. No production service was restarted and nothing was delivered to main.

Parker's phone received this speech, as seven streamed clauses:

> Let me check. Ten builders are running, all active. They are athletic turf, envgen ground, envgen integrator, janet ring, and makkit 215 ship. The others are makkit bugfix, voice readonly, vuln deploy, vuln remediate 1, and vuln watch.

The actual MCP result in the fork's transcript was:

```text
route-athletic-turf-142014.service: active running
route-envgen-ground-141240.service: active running
route-envgen-integrator-142311.service: active running
route-janet-ring-140723.service: active running
route-makkit-215-ship-142349.service: active running
route-makkit-bugfix-143216.service: active running
route-voice-readonly-142245.service: active running
route-vuln-deploy-142726.service: active running
route-vuln-remediate-1-142800.service: active running
route-vuln-watch-133123.service: active running
```

The same question from a paired guest received:

> I can't check that from here, so I don't know what the builders are running. I'll pass the question along and see if someone can look it up.

That guest session had no parent transcript, lab access, or tool results. An unpaired token received HTTP 403 before a head session opened. Separate HTTP tests cover a caller holding only the ordinary voice bearer, invalid lab credentials, cross-tier client references, and attempts to turn, interrupt, or end Parker's conversation. Phone admission tests cover direct owner SSO, another verified user, a shared Parker-issued link, and forged caller headers.

The phone socket delivered 940,800 bytes of Parker PCM and 301,440 bytes of guest PCM at 24 kHz. Both WAVs were sent through the real Wyoming speech recognizer at `10.10.10.152:10300`. Its transcripts match the spoken answers above, with phonetic spelling differences in builder names. This confirms that speech, rather than silent test audio, reached the socket.

Local artifacts are under `/home/agent/.local/state/router/verification/voice-readonly/`: `parker.wav`, `guest.wav`, `transcript.json`, and `audio-transcription.json`. The JSON transcript includes the exact tool result. The script records fresh results when rerun, so builder names will change.

This proves the scripted STT-to-phone-audio path with a synthetic, verified owner device. It does not prove microphone transcription, a real Android sign-in, the deployed production configuration, or desk speaker verification. The SSO exchange is covered by the existing HTTP-provider integration tests, including the newly persisted verified identity. An earlier model-only smoke test also returned the correct live builder list. An initial full proof attempt timed out during its isolated seed session startup; the successful run used the same lab-enabled launch settings as the tested owner head.

The allowlist is `mcp__janet_lab__builders`, `mcp__janet_lab__objectives`, `mcp__janet_lab__health`, and `mcp__janet_lab__pull_requests`. Every input is an empty object. Fixed argv commands, a three-second total command deadline, output limits, and empty inherited MCP configuration enforce the boundary. No shell, secret lookup, arbitrary file or command input, or write tool is exposed. Messages, recall, and calendar remain outside this allowlist.

Review: `gpt-6.1-terra:high` through the lab router. The first source review found two blockers: link issuers were being treated as verified recipients, and invalid lab credentials could still open personal forks. Both were fixed. A second source and deployment review reported no blocking findings; its local test environment was incomplete, so the implementation's separate test runs and this proof provide runtime validation.

A maintainability and rollout review by `gpt-6-sol:medium` found that an unset bridge lab credential must preserve the configured tier during the staged rollout. The follow-up preserves that behavior and adds a WebSocket control test. Live tool checks also confirmed the full objectives ledger exceeds the output limit, so the tool now uses the existing compact index. It opens the ledger without following symlinks and supplies the open file as stdin, which keeps the source fixed if its pathname changes.

The final source review by `gpt-6.1-terra:medium` confirmed both follow-up blockers resolved. The parent ledger directories remain trusted. Final targeted checks cover symlink refusal, pathname replacement, malformed output, owner and guest admission, and preserving the configured tier before the gate is enabled.
