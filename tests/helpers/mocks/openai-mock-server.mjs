#!/usr/bin/env node
// Minimal OpenAI-compatible mock server (issue #883, PoC phase 1).
//
// Deterministic, instant stand-in for the OpenAI Chat Completions / Embeddings
// API, so specs whose value is UI/flow plumbing (not the model's answer) can run
// without a live provider round-trip — cutting the provider-latency variance
// that turns into transient-saturation timeouts under the daily's load (#773).
//
// Point Langflow at it by setting OPENAI_BASE_URL (a Langflow global variable or
// the container env) to this server's /v1 URL; Langflow's instantiation layer
// forwards it as the OpenAI client `base_url` (base/models/unified_models/
// instantiation.py). No per-flow edits needed.
//
// Behaviour: ECHO. The assistant reply is the verbatim text of the last user
// message, so specs that send a sentinel and assert it comes back still pass,
// and presence-only specs get a non-empty reply. Supports streaming
// (`stream: true` → SSE) and non-streaming. Deps: none (Node http only).
//
// Usage: PORT=11500 node tests/helpers/mocks/openai-mock-server.mjs

import http from "node:http";

const PORT = Number(process.env.MOCK_OPENAI_PORT || process.env.PORT || 11500);
const MODEL_ID = "gpt-4o-mini";
const EMBED_DIM = 1536;
// Langflow repopulates the OpenAI model panel from the override endpoint's
// /v1/models when OPENAI_BASE_URL is set, so advertise a realistic list of
// current OpenAI chat model ids (not just one) or the provider panel comes up
// empty and specs can't select a model (#883 PoC finding).
const MODEL_IDS = [
  "gpt-4o-mini",
  "gpt-4o",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4-turbo",
  "gpt-3.5-turbo",
];

const now = () => Math.floor(Date.now() / 1000);
const id = (p) => `${p}-mock${now()}${Math.floor(Math.random() * 1e6)}`;

function lastUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user") {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        // vision/multimodal: concatenate text parts
        return m.content
          .map((p) => (typeof p === "string" ? p : p?.text || ""))
          .join(" ")
          .trim();
      }
    }
  }
  return "";
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function chatCompletion(reply, model) {
  return {
    id: id("chatcmpl"),
    object: "chat.completion",
    created: now(),
    model: model || MODEL_ID,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: reply },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 1,
      completion_tokens: Math.max(1, reply.split(/\s+/).length),
      total_tokens: 1 + Math.max(1, reply.split(/\s+/).length),
    },
  };
}

function streamChunks(res, reply, model) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const base = {
    id: id("chatcmpl"),
    object: "chat.completion.chunk",
    created: now(),
    model: model || MODEL_ID,
  };
  // role delta first, then the content in one chunk, then stop.
  const send = (delta, finish = null) =>
    res.write(
      `data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`,
    );
  send({ role: "assistant" });
  send({ content: reply });
  send({}, "stop");
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || "").split("?")[0];
  console.log(`[mock-openai] ${req.method} ${url}`);

  if (req.method === "GET" && url.endsWith("/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        data: MODEL_IDS.map((m) => ({
          id: m,
          object: "model",
          created: now(),
          owned_by: "mock",
        })),
      }),
    );
    return;
  }

  if (req.method === "POST" && url.endsWith("/chat/completions")) {
    const body = await readBody(req);
    const reply = lastUserText(body.messages) || "OK";
    if (body.stream) return streamChunks(res, reply, body.model);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(chatCompletion(reply, body.model)));
    return;
  }

  if (req.method === "POST" && url.endsWith("/embeddings")) {
    const body = await readBody(req);
    const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
    // Deterministic unit-ish vector per input (fixed, non-zero).
    const vec = Array.from({ length: EMBED_DIM }, (_, i) => ((i % 7) + 1) / 100);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        model: body.model || "text-embedding-3-small",
        data: inputs.map((_, i) => ({ object: "embedding", index: i, embedding: vec })),
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }),
    );
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: `mock: no route for ${req.method} ${url}` } }));
});

server.listen(PORT, () => {
  console.log(`[mock-openai] listening on http://0.0.0.0:${PORT} (echo mode)`);
});
