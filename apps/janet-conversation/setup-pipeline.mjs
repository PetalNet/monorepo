#!/usr/bin/env node
// Adds Janet to Home Assistant: the janet_conversation config entry, a Wyoming entry for the Chatterbox
// voice, and an Assist pipeline "Janet Talk" (Wyoming faster-whisper in, Janet as the agent, Chatterbox out).
// Additive and idempotent. It never touches another pipeline or the preferred one. `--remove` undoes a run.
//
//   HASS_TOKEN_FILE=... HEAD_TOKEN_FILE=... [HASS_URL=...] [HEAD_URL=...] [TTS_HOST=... TTS_PORT=10230] node setup-pipeline.mjs [--remove]
//
// Needs Node 22 or later. The Wyoming speech-to-text entry must already exist (it is added with the desk voice).
import fs from "node:fs";

const env = process.env;
const config = {
  url: env.HASS_URL ?? "http://10.10.10.11:8123",
  headUrl: env.HEAD_URL ?? "http://10.10.10.202:8791",
  ttsHost: env.TTS_HOST ?? "10.10.10.152",
  ttsPort: Number(env.TTS_PORT ?? 10230),
  pipelineName: "Janet Talk",
  voice: env.TTS_VOICE ?? "janet",
};
const token = fs.readFileSync(env.HASS_TOKEN_FILE, "utf8").trim();
const remove = process.argv.includes("--remove");

async function rest(method, path, body) {
  const response = await fetch(config.url + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

function openSocket() {
  const socket = new WebSocket(config.url.replace(/^http/, "ws") + "/api/websocket");
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    socket.onerror = () => reject(new Error("websocket error"));
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "auth_required") socket.send(JSON.stringify({ type: "auth", access_token: token }));
      else if (message.type === "auth_ok") resolve();
      else if (message.type === "auth_invalid") reject(new Error("Home Assistant rejected the token"));
      else if (message.type === "result") {
        const { resolve: done, reject: fail } = pending.get(message.id);
        pending.delete(message.id);
        if (message.success) done(message.result);
        else fail(new Error(`${message.error.code}: ${message.error.message}`));
      }
    };
  });
  const call = async (command) => {
    await ready;
    const id = nextId++;
    const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    socket.send(JSON.stringify({ ...command, id }));
    return result;
  };
  return { call, close: () => socket.close() };
}

async function flowEntry(handler, existing, data) {
  if (existing) return existing.entry_id;
  if (remove) return null;
  const flow = await rest("POST", "/api/config/config_entries/flow", { handler });
  const result = await rest("POST", `/api/config/config_entries/flow/${flow.flow_id}`, data);
  if (result.type !== "create_entry") throw new Error(`${handler} flow ended with ${JSON.stringify(result)}`);
  return result.result.entry_id;
}

const ha = openSocket();
try {
  const entries = await ha.call({ type: "config_entries/get" });
  const janetEntry = entries.find((entry) => entry.domain === "janet_conversation");
  const ttsEntry = entries.find(
    (entry) => entry.domain === "wyoming" && entry.title !== "faster-whisper" && entry.title !== "openwakeword",
  );
  const owner = (await ha.call({ type: "config/auth/list" })).find((user) => user.is_owner && user.is_active)?.id;

  const { pipelines, preferred_pipeline: preferred } = await ha.call({ type: "assist_pipeline/pipeline/list" });
  const pipeline = pipelines.find((p) => p.name === config.pipelineName);

  if (remove) {
    if (pipeline) await ha.call({ type: "assist_pipeline/pipeline/delete", pipeline_id: pipeline.id });
    if (janetEntry) await rest("DELETE", `/api/config/config_entries/entry/${janetEntry.entry_id}`);
    console.log(JSON.stringify({ removed: { pipeline: pipeline?.id ?? null, janet_entry: janetEntry?.entry_id ?? null }, note: "the Wyoming voice entry is left; delete it by hand if unwanted" }));
  } else {
    const janetId = await flowEntry("janet_conversation", janetEntry, {
      url: config.headUrl,
      token: fs.readFileSync(env.HEAD_TOKEN_FILE, "utf8").trim(),
      owner_user_id: owner,
    });
    const ttsId = await flowEntry("wyoming", ttsEntry, { host: config.ttsHost, port: config.ttsPort });
    const registry = await ha.call({ type: "config/entity_registry/list" });
    const entityOf = (entryId, domain) =>
      registry.find((e) => e.config_entry_id === entryId && e.entity_id.startsWith(domain + "."))?.entity_id;
    const sttEntity = registry.find((e) => e.entity_id === "stt.faster_whisper")?.entity_id;
    const ttsEntity = entityOf(ttsId, "tts");
    const agent = entityOf(janetId, "conversation");
    if (!sttEntity || !ttsEntity || !agent) throw new Error(`missing entities: ${JSON.stringify({ sttEntity, ttsEntity, agent })}`);
    const { voices } = await ha.call({ type: "tts/engine/voices", engine_id: ttsEntity, language: "en" }).catch(() => ({ voices: null }));
    const voice = voices?.find((v) => v.voice_id === config.voice || v.name === config.voice)?.voice_id ?? null;
    const fields = {
      name: config.pipelineName,
      language: "en",
      conversation_engine: agent,
      conversation_language: "*",
      stt_engine: sttEntity,
      stt_language: "en",
      tts_engine: ttsEntity,
      tts_language: "en",
      tts_voice: voice,
      wake_word_entity: null,
      wake_word_id: null,
    };
    const saved = pipeline
      ? await ha.call({ type: "assist_pipeline/pipeline/update", pipeline_id: pipeline.id, ...fields })
      : await ha.call({ type: "assist_pipeline/pipeline/create", ...fields });
    const after = await ha.call({ type: "assist_pipeline/pipeline/list" });
    if (after.preferred_pipeline !== preferred) throw new Error("the preferred pipeline changed; restore it by hand");
    console.log(JSON.stringify({ pipeline_id: saved.id, ...fields, preferred_pipeline_unchanged: after.preferred_pipeline }, null, 2));
  }
} finally {
  ha.close();
}
