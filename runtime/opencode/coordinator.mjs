import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const limit = 2_500_000;
const pending = new Map();
let session,
  initialized = false,
  child,
  http;
let buffer = Buffer.alloc(0);
const emit = (value) => {
  const line = JSON.stringify(value);
  if (Buffer.byteLength(line) > limit) throw new Error("runtime_output_limit");
  process.stdout.write(line + "\n");
};
function rpc(method, params) {
  if (pending.size >= 16)
    return Promise.reject(new Error("runtime_concurrency_limit"));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("engine_relay_timeout"));
    }, 3_610_000);
    pending.set(id, { resolve, reject, timer });
    emit({ type: "request", id, method, params });
  });
}
function unwrap(operation) {
  if (operation?.status !== "completed" || operation.invalidated)
    throw new Error(operation?.error ?? "engine_operation_not_completed");
  return operation.result;
}
async function body(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error("runtime_input_limit");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function checkSession(value) {
  if (!session || value !== session) throw new Error("runtime_session_spoof");
}
function sse(res, completion) {
  const message = completion.choices[0].message;
  if (!message || message.role !== "assistant")
    throw new Error("model_response_invalid");
  const base = {
    id: completion.id ?? randomUUID(),
    object: "chat.completion.chunk",
    created: completion.created ?? Math.floor(Date.now() / 1000),
    model: completion.model ?? "assigned-model",
  };
  const chunk = (delta, finish_reason = null) => ({
    ...base,
    choices: [{ index: 0, delta, finish_reason }],
  });
  const delta = { role: "assistant", content: message.content ?? "" };
  if (message.tool_calls)
    delta.tool_calls = message.tool_calls.map((call, index) => ({
      ...call,
      index,
    }));
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
  });
  res.write(`data: ${JSON.stringify(chunk(delta))}\n\n`);
  res.write(
    `data: ${JSON.stringify(chunk({}, completion.choices[0].finish_reason ?? "stop"))}\n\n`,
  );
  if (completion.usage)
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [], usage: completion.usage })}\n\n`,
    );
  res.end("data: [DONE]\n\n");
}
async function initialize(config) {
  if (initialized) throw new Error("runtime_already_initialized");
  initialized = true;
  if (typeof config.model?.model !== "string" || !config.model.model)
    throw new Error("model_not_assigned");
  http = createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.headers.origin || req.url.includes("?"))
        throw new Error("runtime_route_denied");
      const input = await body(req);
      checkSession(
        req.url === "/v1/chat/completions"
          ? req.headers["x-harness-session"]
          : input.session,
      );
      let result;
      if (req.url === "/check-session") result = { ok: true };
      else if (req.url === "/tool")
        result = unwrap(await rpc("execute", input));
      else if (req.url === "/context")
        result = unwrap(await rpc("context", { session }));
      else if (req.url === "/v1/chat/completions") {
        result = unwrap(
          await rpc("model", { session, request: input, call: randomUUID() }),
        );
        if (input.stream) {
          sse(res, result.response);
          return;
        }
        result = result.response;
      } else throw new Error("runtime_route_denied");
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: { message: String(error.message ?? error) } }),
      );
    }
  });
  await new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", resolve);
  });
  const relay = `http://127.0.0.1:${http.address().port}`;
  const runtimeConfig = {
    model: `harness/${config.model.model}`,
    small_model: `harness/${config.model.model}`,
    default_agent: "harness",
    enabled_providers: ["harness"],
    autoupdate: false,
    share: "disabled",
    plugin: ["file:///opt/agent-harness-runtime/plugin.mjs"],
    provider: {
      harness: {
        npm: "@ai-sdk/openai-compatible",
        name: "agent-harness",
        options: {
          baseURL: `${relay}/v1`,
          apiKey: "container-local-placeholder",
        },
        models: {
          [config.model.model]: {
            name: config.model.model,
            limit: { context: 32768, output: 8192 },
          },
        },
      },
    },
    permission: { "*": "deny", "harness_*": "allow" },
    agent: {
      harness: {
        mode: "primary",
        prompt: "Follow the engine's authoritative goal and assigned role.",
      },
      title: { disable: true },
      summary: { disable: true },
    },
    compaction: { auto: false },
  };
  child = spawn(
    "opencode",
    ["serve", "--hostname", "127.0.0.1", "--port", "4096", "--print-logs"],
    {
      cwd: "/workspace",
      env: {
        PATH: process.env.PATH,
        HOME: "/home/node",
        TMPDIR: "/tmp",
        XDG_CONFIG_HOME: "/opt/agent-harness-config",
        OPENCODE_CONFIG_CONTENT: JSON.stringify(runtimeConfig),
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_DISABLE_MODELS_FETCH: "true",
        OPENCODE_DISABLE_PROJECT_CONFIG: "true",
        HARNESS_RELAY_ORIGIN: relay,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => process.stderr.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  child.once("error", (error) => fatal(error));
  child.once("exit", (code) => fatal(new Error(`opencode_exited:${code}`)));
  const deadline = Date.now() + 30_000;
  let startupError = "server unavailable";
  for (;;) {
    try {
      const response = await fetch("http://127.0.0.1:4096/session", {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) break;
      startupError = `HTTP ${response.status}: ${(await response.text()).slice(0, 2048)}`;
    } catch (error) {
      startupError = String(error);
    }
    if (Date.now() >= deadline)
      throw new Error(`opencode_startup_timeout: ${startupError}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const response = await fetch("http://127.0.0.1:4096/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "agent-harness contained session" }),
  });
  if (!response.ok)
    throw new Error(`opencode_session_failed:${response.status}`);
  const created = await response.json();
  if (typeof created.id !== "string")
    throw new Error("opencode_session_missing");
  session = created.id;
  emit({ type: "ready", session, runtime: "opencode", version: "1.18.31" });
}
let prompting = false;
async function receive(value) {
  if (value.type === "response") {
    const request = pending.get(value.id);
    if (!request) throw new Error("runtime_response_identity");
    pending.delete(value.id);
    clearTimeout(request.timer);
    if (value.error) request.reject(new Error(value.error));
    else request.resolve(value.result);
  } else if (value.type === "init") await initialize(value);
  else if (value.type === "prompt") {
    if (
      !session ||
      prompting ||
      typeof value.text !== "string" ||
      value.text.length > 64000
    )
      throw new Error("runtime_prompt_denied");
    prompting = true;
    try {
      const response = await fetch(
        `http://127.0.0.1:4096/session/${session}/message`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agent: "harness",
            parts: [{ type: "text", text: value.text }],
          }),
        },
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(`opencode_prompt_failed:${JSON.stringify(result)}`);
      emit({ type: "result", id: value.id, result });
    } finally {
      prompting = false;
    }
  } else if (value.type === "stop") process.exit(0);
  else throw new Error("runtime_message_denied");
}
function fatal(error) {
  process.stderr.write(`${String(error.message ?? error)}\n`);
  process.exit(1);
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  let end;
  while ((end = buffer.indexOf(10)) >= 0) {
    if (end > limit) return fatal(new Error("runtime_input_limit"));
    const line = buffer.subarray(0, end);
    buffer = buffer.subarray(end + 1);
    try {
      void receive(JSON.parse(line.toString("utf8"))).catch(fatal);
    } catch (error) {
      fatal(error);
    }
  }
  if (buffer.length > limit) fatal(new Error("runtime_input_limit"));
});
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", fatal);
