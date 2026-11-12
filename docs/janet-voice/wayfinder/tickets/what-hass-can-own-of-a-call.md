---
title: What Home Assistant can own of a call
label: wayfinder:research
status: closed
assignee: Janet
handed-off: 2026-11-11
resolved: 2026-11-11
---

## Question

Parker asked whether a custom tree plus adapter integration could let Home Assistant handle a phone
call itself. Before that can be decided, one fact is missing: how much of a call a custom
integration can actually own on HA 2026.5.2.

- What the assist satellite platform gives a custom integration per call: concurrent calls, starting
  and stopping a pipeline mid-call, continuous two-way audio rather than turn by turn, interruption.
- What the built-in VoIP integration does and does not do today, and whether it works against a SIP
  trunk rather than a local phone adapter.
- Whether keypad digits, a transfer and voicemail detection are reachable from inside Home
  Assistant, or only from the trunk layer.
- Whether an integration can place an outbound call.

Handed to Janet in the room on 2026-11-11. Code and docs only, no live changes.

## Resolution

Janet, from HA core at tag 2026.5.2 and voip-utils 0.3.5. The merged shape holds.

- The satellite platform takes 16 kHz mono PCM and passes the device and satellite id into the
  pipeline. A turn can be run repeatedly within one call, choosing start and end stages, so a
  pipeline can be started and stopped mid-call.
- One pipeline per entity, and starting a new one cancels the running one. So a call needs one
  satellite per call, and entities can be added at any time.
- Not full duplex as shipped. The pipeline runs speech to text, then intent, then speech, in turns,
  and the built-in VoIP integration discards incoming audio until speech output ends. No barge-in.
- The built-in VoIP integration only answers INVITEs: no registration, no digest auth, no NAT
  handling, Opus only. It works with a phone adapter on the local network, not a trunk. It can only
  call back a device that already called in, never an arbitrary number. No keypad digits, no
  transfer. The caller URI becomes the device id and is not exposed as caller id.
- Entity exposure is per assistant, not per satellite, so Home Assistant cannot give a stranger's
  call fewer rights than Parker's. Janet has to gate on the device id herself, or the integration
  has to route unknown callers to a separate restricted pipeline.
- Must come from a phone layer underneath: transfer, keypad digits, voicemail and answering-machine
  detection, dialling arbitrary numbers, trunk registration and auth, G.711.
- Prior art worth knowing: `arnonym/ha-plugins` (ha-sip) registers with a SIP server and does keypad
  digits; `n-IA-hane/esphome-intercom` ships a PBX inside Home Assistant with trunks, transfer and
  voicemail. Whether either registers real assist satellites is unverified.

The no-barge-in finding is a property of the shipped VoIP integration, not of the satellite
platform: a custom adapter holds the audio socket and can keep listening during playback, then
cancel the running pipeline. That is the basis of
[Cutting her off](cutting-her-off.md), which Parker then made a requirement.

## Note

Correction recorded: this map first said Home Assistant "has no telephony at all, it cannot answer
or place a call." That was too strong. Home Assistant has an assist satellite platform a custom
integration can plug into, and ships a VoIP integration for SIP phones; neither is loaded on the box
today. The claim was corrected to Parker in the room the same day.
