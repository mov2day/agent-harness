import { z } from "zod";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import {
  lstatSync,
  readFileSync,
  realpathSync,
  openSync,
  closeSync,
  fstatSync,
  constants,
} from "node:fs";
import { check, hash, type Session } from "./core.js";
import {
  pinnedLookup,
  publicAddress,
  researchUrl,
  type HttpsRequestFactory,
  type ResolveAddresses,
} from "./gateway.js";
import type { Store } from "./store.js";
import type { Operation, Operations } from "./operations.js";
const toolName = z
  .string()
  .regex(
    /^harness_(read|change|delete|rename|research|execute|delegate|artifact|review|compact|learn)$/,
  );
const functionCall = z
  .object({
    id: z.string(),
    type: z.literal("function"),
    function: z
      .object({ name: toolName, arguments: z.string().max(2_000_000) })
      .strict(),
  })
  .strict();
const message = z
  .object({
    role: z.enum(["system", "developer", "user", "assistant", "tool"]),
    content: z
      .union([
        z.string(),
        z.array(
          z.object({ type: z.literal("text"), text: z.string() }).strict(),
        ),
      ])
      .nullable()
      .optional(),
    tool_call_id: z.string().optional(),
    tool_calls: z.array(functionCall).max(32).optional(),
    name: toolName.optional(),
  })
  .strict();
/** Only inference messages and local function definitions may cross this channel.
 * Remote images, built-in web/code tools, remote MCP and arbitrary request URLs
 * are deliberately absent from the schema. Research uses the other gateway. */
export const modelRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(message).min(1).max(1024),
    tools: z
      .array(
        z
          .object({
            type: z.literal("function"),
            function: z
              .object({
                name: toolName,
                description: z.string().max(16_384).optional(),
                parameters: z.record(z.unknown()),
                strict: z.boolean().optional(),
              })
              .strict(),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    tool_choice: z
      .union([
        z.enum(["auto", "none", "required"]),
        z
          .object({
            type: z.literal("function"),
            function: z.object({ name: toolName }).strict(),
          })
          .strict(),
      ])
      .optional(),
    stream: z.boolean().optional(),
    stream_options: z
      .object({ include_usage: z.boolean() })
      .strict()
      .optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    reasoning_effort: z.string().optional(),
    parallel_tool_calls: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.max_tokens === undefined ||
      value.max_completion_tokens === undefined,
    "Specify only one output token limit",
  )
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value)) <= 2_000_000,
    "Model request exceeds the context transport limit",
  );
const profileSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]{1,64}$/),
    endpoint: z.string().url(),
    credentialFile: z.string().min(1),
    models: z
      .array(
        z
          .object({
            id: z.string().min(1),
            upstream: z.string().min(1),
            reasoning: z.array(z.string().min(1)).min(1),
            maxOutputTokens: z.number().int().min(256).max(32_768),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type ModelProfile = z.infer<typeof profileSchema>;
export class ModelChannel {
  constructor(
    readonly store: Store,
    readonly operations: Operations,
    private resolve: ResolveAddresses = lookup,
    private request: HttpsRequestFactory = httpsRequest,
  ) {}
  private credential(profile: ModelProfile) {
    let canonical: string, stat: ReturnType<typeof lstatSync>, fd: number;
    try {
      canonical = realpathSync(profile.credentialFile);
      stat = lstatSync(profile.credentialFile);
      fd = openSync(
        profile.credentialFile,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch {
      // Runtime-visible errors must not reveal credential paths or OS details.
      throw new Error("provider_credential_unavailable");
    }
    try {
      const pinned = fstatSync(fd);
      check(
        stat.isFile() &&
          !stat.isSymbolicLink() &&
          pinned.isFile() &&
          pinned.dev === stat.dev &&
          pinned.ino === stat.ino &&
          pinned.uid === process.getuid?.() &&
          !(pinned.mode & 0o077) &&
          pinned.size <= 8192,
        "provider_credential_permissions",
      );
      check(
        !this.store
          .list<{ path: string }>("repository")
          .some(
            (r) => canonical === r.path || canonical.startsWith(`${r.path}/`),
          ),
        "provider_credential_in_repository",
      );
      const key = readFileSync(fd, "utf8").trim();
      check(
        key.length > 0 && key.length <= 8192 && /^[\x21-\x7e]+$/.test(key),
        "provider_credential_invalid",
      );
      return key;
    } finally {
      closeSync(fd);
    }
  }
  install(input: unknown) {
    const profile = profileSchema.parse(input),
      url = new URL(profile.endpoint);
    researchUrl(profile.endpoint, [url.hostname]);
    check(
      url.pathname.endsWith("/chat/completions") && !url.search,
      "provider_endpoint",
    );
    check(
      new Set(profile.models.map((m) => m.id)).size === profile.models.length,
      "provider_models_duplicate",
    );
    this.credential(profile);
    profile.credentialFile = realpathSync(profile.credentialFile);
    this.store.transaction(() => {
      for (const existing of this.store.list<ModelProfile>("model-profile"))
        if (existing.id !== profile.id)
          check(
            !existing.models.some((m) =>
              profile.models.some((other) => other.id === m.id),
            ),
            "provider_model_ambiguous",
          );
      const previous = this.store.get<ModelProfile>(
        "model-profile",
        profile.id,
      );
      this.store.put("model-profile", profile.id, profile);
      if (previous) {
        const models = new Set(
          [...previous.models, ...profile.models].map((m) => m.id),
        );
        const roots = new Set(
          this.store
            .list<Session>("session")
            .filter(
              (s) =>
                s.status === "active" && s.model && models.has(s.model.model),
            )
            .map((s) => s.root),
        );
        for (const root of roots)
          this.operations.invalidate(root, "model_profile_changed");
      }
      this.store.audit("model.profile_installed", {
        id: profile.id,
        endpoint: profile.endpoint,
        models: profile.models.map((m) => m.id),
      });
    });
    return { id: profile.id, models: profile.models.map((m) => m.id) };
  }
  async send(op: Operation, signal: AbortSignal) {
    const current = this.operations.validate(op),
      scope = this.operations.identity.session(current.session),
      setting = scope.model;
    check(setting, "model_not_assigned");
    const input = modelRequestSchema.parse(current.args.request);
    check(
      input.model === setting.model &&
        (!input.reasoning_effort ||
          input.reasoning_effort === setting.reasoning),
      "model_override_denied",
    );
    const profiles = this.store
      .list<ModelProfile>("model-profile")
      .filter((p) => p.models.some((m) => m.id === setting.model));
    check(profiles.length === 1, "model_provider_not_configured");
    const profile = profileSchema.parse(profiles[0]),
      model = profile.models.find((m) => m.id === setting.model)!;
    check(model.reasoning.includes(setting.reasoning), "unsupported_model");
    const requestedLimit =
      input.max_completion_tokens ?? input.max_tokens ?? model.maxOutputTokens;
    check(requestedLimit <= model.maxOutputTokens, "model_output_limit");
    const endpoint = new URL(profile.endpoint);
    researchUrl(profile.endpoint, [endpoint.hostname]);
    const addresses = await this.resolve(endpoint.hostname, {
      all: true,
      verbatim: true,
    });
    check(
      addresses.length && addresses.every((a) => publicAddress(a.address)),
      "prohibited_address",
    );
    this.operations.validate(op);
    signal.throwIfAborted();
    const credential = this.credential(profile),
      target = addresses[0]!;
    const payload = JSON.stringify({
      ...input,
      model: model.upstream,
      stream: false,
      stream_options: undefined,
      max_tokens: undefined,
      max_completion_tokens: requestedLimit,
      reasoning_effort:
        setting.reasoning === "none" ? undefined : setting.reasoning,
    });
    const body = await new Promise<Buffer>((resolve, reject) => {
      let req: ReturnType<HttpsRequestFactory>;
      this.operations.commit(op, () => {
        req = this.request(
          endpoint,
          {
            method: "POST",
            lookup: pinnedLookup(target.address, target.family),
            family: target.family,
            servername: endpoint.hostname,
            rejectUnauthorized: true,
            agent: false,
            signal,
            headers: {
              authorization: `Bearer ${credential}`,
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
              "accept-encoding": "identity",
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            let bytes = 0;
            res.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > 512 * 1024)
                res.destroy(new Error("model_result_limit"));
              else chunks.push(chunk);
            });
            res.on("error", reject);
            res.on("end", () => {
              if (res.statusCode !== 200)
                reject(new Error(`model_http_status:${res.statusCode}`));
              else resolve(Buffer.concat(chunks));
            });
          },
        );
        req!.setTimeout(60_000, () =>
          req!.destroy(new Error("model_provider_timeout")),
        );
        req!.on("error", reject);
        req!.end(payload);
      });
    });
    this.operations.validate(op);
    check(
      !body.includes(Buffer.from(credential)),
      "provider_credential_in_response",
    );
    const response = JSON.parse(body.toString("utf8"));
    check(
      response &&
        Array.isArray(response.choices) &&
        response.choices.length === 1,
      "model_response_invalid",
    );
    this.store.transaction(() =>
      this.store.audit(
        "model.response",
        {
          operation: op.id,
          profile: profile.id,
          model: setting.model,
          address: target.address,
          hash: hash(body),
        },
        op.repository,
        op.session,
      ),
    );
    return {
      response,
      profile: profile.id,
      hash: hash(body),
      trust: "untrusted" as const,
    };
  }
}
