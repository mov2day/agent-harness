import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFileSync, existsSync, writeFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  check,
  equal,
  secret,
  id,
  HarnessError,
  type Session,
} from "./core.js";
import type { Engine } from "./engine.js";
export function ownerCredential(state: string) {
  const file = join(state, "web.credential");
  if (!existsSync(file))
    writeFileSync(file, secret(), { flag: "wx", mode: 0o600 });
  const stat = lstatSync(file);
  check(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      (stat.mode & 0o077) === 0 &&
      stat.uid === process.getuid?.(),
    "web_credential_permissions",
  );
  return { file, token: readFileSync(file, "utf8").trim() };
}
async function body(req: IncomingMessage) {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    check(
      bytes <= 2_500_000,
      "request_too_large",
      "Request exceeds limit",
      413,
    );
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HarnessError("invalid_json", "Invalid JSON", 400);
  }
}
function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(data));
}
export function createEngineServer(
  engine: Engine,
  webToken: string,
  webDirectory: string,
) {
  const server = createServer(async (req, res) => {
    try {
      const port = (server.address() as { port: number }).port,
        origin = `http://127.0.0.1:${port}`;
      check(
        req.socket.remoteAddress === "127.0.0.1" ||
          req.socket.remoteAddress === "::ffff:127.0.0.1",
        "loopback_required",
      );
      check(req.headers.host === `127.0.0.1:${port}`, "host_rejected");
      const url = new URL(req.url ?? "/", origin);
      check(
        !url.search && !url.username && !url.password,
        "url_credentials_forbidden",
      );
      res.setHeader(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      );
      res.setHeader("referrer-policy", "no-referrer");
      res.setHeader("x-frame-options", "DENY");
      if (!url.pathname.startsWith("/v1/")) {
        check(
          req.method === "GET",
          "method_not_allowed",
          "Method not allowed",
          405,
        );
        const files: Record<string, [string, string]> = {
          "/": ["index.html", "text/html"],
          "/app.js": ["app.js", "application/javascript"],
          "/app.css": ["app.css", "text/css"],
        };
        const entry = files[url.pathname];
        check(entry, "not_found", "Not found", 404);
        res.writeHead(200, {
          "content-type": entry[1],
          "cache-control": "no-store",
        });
        res.end(readFileSync(join(webDirectory, entry[0])));
        return;
      }
      const owner = url.pathname.startsWith("/v1/owner/");
      if (owner) {
        check(
          typeof req.headers.authorization === "string" &&
            equal(req.headers.authorization, `Bearer ${webToken}`),
          "web_authentication",
          "Sign in to the controls interface",
          401,
        );
        check(req.headers.origin === origin, "origin_rejected");
      } else {
        check(
          !req.headers.origin && !req.headers["sec-fetch-site"],
          "browser_registration_rejected",
        );
      }
      check(
        req.method === "POST" || (owner && req.method === "GET"),
        "method_not_allowed",
        "Method not allowed",
        405,
      );
      if (req.method === "POST")
        check(
          req.headers["content-type"]?.split(";")[0] === "application/json",
          "content_type",
          "Expected application/json",
          415,
        );
      const data = req.method === "POST" ? await body(req) : {};
      let result: unknown;
      if (owner) {
        switch (url.pathname) {
          case "/v1/owner/state":
            result = engine.state();
            break;
          case "/v1/owner/repositories":
            result = engine.enroll(
              z.object({ path: z.string() }).strict().parse(data).path,
            );
            break;
          case "/v1/owner/policies": {
            const d = z
              .object({
                scope: z.string(),
                policy: z.unknown(),
                activate: z.boolean(),
              })
              .strict()
              .parse(data);
            result = engine.policies.publish(d.scope, d.policy, d.activate);
            break;
          }
          case "/v1/owner/authority": {
            const d = z
                .object({
                  root: z.string(),
                  goals: z.array(z.string()),
                  constraints: z.array(z.string()),
                  decisions: z.array(z.string()),
                  findings: z.array(z.string()),
                })
                .strict()
                .parse(data),
              s = engine.identity.session(d.root);
            check(s.root === s.session, "root_required");
            engine.store.transaction(() => {
              engine.store.put(
                "authority",
                s.root,
                {
                  goals: d.goals,
                  constraints: d.constraints,
                  decisions: d.decisions,
                  findings: d.findings,
                },
                s.repository,
                s.root,
              );
              engine.store.audit(
                "authority.updated",
                { root: s.root },
                s.repository,
                s.root,
              );
            });
            result = { saved: true };
            break;
          }
          case "/v1/owner/runtime/certificates":
            engine.containment.install(data);
            result = { installed: true };
            break;
          case "/v1/owner/model-profiles":
            result = engine.models.install(data);
            break;
          case "/v1/owner/runtime/attach":
            result = engine.containment.attach(
              engine.identity.session(data.session),
              data.container,
              data.certificate,
            );
            break;
          case "/v1/owner/runtime/cleanup": {
            const d = z.object({ session: z.string() }).strict().parse(data);
            result = await engine.runtimes.cleanup(d.session);
            break;
          }
          case "/v1/owner/reviews/approve":
            result = engine.workflow.approveStage(
              data.root,
              data.artifact,
              data.review,
            );
            break;
          case "/v1/owner/actions/approve":
            result = engine.workflow.approveAction(
              data.root,
              data.tool,
              data.args,
              data.dependencies,
              true,
            );
            break;
          case "/v1/owner/sessions/terminate":
            engine.operations.invalidate(data.session, "session_terminated");
            result = { terminated: true };
            break;
          case "/v1/owner/sessions/revoke":
            engine.operations.invalidate(data.session, "capability_revoked");
            result = { revoked: true };
            break;
          case "/v1/owner/operations/reconcile":
            engine.operations.reconcile(data.key, data.outcome, data.evidence);
            result = { reconciled: true };
            break;
          case "/v1/owner/context/configure":
            result = engine.compaction.configure(
              engine.identity.session(data.session),
              data.capacity,
              data.reserved,
            );
            break;
          case "/v1/owner/learning/promote":
            result = engine.learning.promote(
              engine.identity.session(data.session),
              data.candidate,
              true,
              !!data.global,
            );
            break;
          case "/v1/owner/learning/privacy":
            engine.learning.privacyReview(
              engine.identity.session(data.session),
              data.candidate,
              "authenticated-owner",
              data.decision,
            );
            result = { reviewed: true };
            break;
          case "/v1/owner/learning/rollback":
            engine.learning.rollback(
              engine.identity.session(data.session),
              data.candidate,
            );
            result = { rolledBack: true };
            break;
          case "/v1/owner/artifacts/get": {
            const artifact = engine.store.get("artifact", data.id);
            check(artifact, "artifact_not_found");
            result = artifact;
            break;
          }
          case "/v1/owner/alerts/acknowledge": {
            const a = engine.store.get<any>("alert", data.id);
            check(a, "alert_not_found");
            a.acknowledged = true;
            engine.store.put("alert", data.id, a);
            result = a;
            break;
          }
          default:
            throw new HarnessError("not_found", "API route not found", 404);
        }
      } else if (url.pathname === "/v1/integrations/challenge")
        result = engine.identity.challenge(data);
      else if (url.pathname === "/v1/specialists/challenge")
        result = engine.identity.specialistChallenge(data);
      else if (url.pathname === "/v1/specialists/register") {
        const d = z
          .object({ binding: z.unknown(), proof: z.string() })
          .strict()
          .parse(data);
        result = engine.identity.claimSpecialist(d.binding, d.proof);
      } else if (url.pathname === "/v1/integrations/register") {
        const d = z
          .object({ binding: z.unknown(), proof: z.string() })
          .strict()
          .parse(data);
        result = engine.identity.register(d.binding, d.proof);
      } else if (url.pathname === "/v1/integrations/status")
        result = engine.identity.status(data.binding, data.time, data.proof);
      else {
        const token = req.headers.authorization?.replace(/^Bearer /, ""),
          connection = req.headers["x-harness-connection"];
        check(
          token && typeof connection === "string",
          "integration_authentication",
          "Integration authentication required",
          401,
        );
        if (url.pathname === "/v1/capabilities/renew")
          result = engine.identity.renew(token, connection);
        else if (url.pathname === "/v1/runtime/prepare")
          result = engine.runtimes.prepare(token, connection, data);
        else if (url.pathname === "/v1/runtime/attach") {
          const d = z.object({ container: z.string() }).strict().parse(data);
          result = await engine.runtimes.attach(token, connection, d.container);
        } else if (url.pathname === "/v1/runtime/stop") {
          z.object({}).strict().parse(data);
          result = await engine.runtimes.stop(token, connection);
        } else if (url.pathname === "/v1/model") {
          const d = z
            .object({ request: z.unknown(), idempotencyKey: z.string() })
            .strict()
            .parse(data);
          result = await engine.execute(token, connection, {
            tool: "model",
            args: { request: d.request },
            idempotencyKey: d.idempotencyKey,
          });
        } else if (url.pathname === "/v1/operations") {
          const d = z
            .object({
              tool: z.string(),
              args: z.unknown(),
              idempotencyKey: z.string(),
            })
            .strict()
            .parse(data);
          result = await engine.execute(token, connection, {
            ...d,
            args: d.args,
          });
        } else {
          const routes: Record<string, { tool: string; args: unknown }> = {
            "/v1/context": { tool: "compact", args: { action: "context" } },
            "/v1/artifacts/get": {
              tool: "artifact",
              args: { action: "get", id: data.id },
            },
            "/v1/artifacts/share": {
              tool: "artifact",
              args: { action: "share", id: data.id, session: data.session },
            },
            "/v1/workflow/submit": {
              tool: "artifact",
              args: { action: "submit", id: data.artifact },
            },
            "/v1/reviews/change": {
              tool: "review",
              args: {
                kind: "change",
                artifact: data.artifact,
                findings: data.findings,
              },
            },
            "/v1/checkpoints/get": {
              tool: "compact",
              args: { action: "get", id: data.id },
            },
            "/v1/evidence/get": {
              tool: "artifact",
              args: { action: "evidence", id: data.id },
            },
          };
          const route = routes[url.pathname];
          check(route, "not_found", "API route not found", 404);
          const op = await engine.execute(token, connection, {
            ...route,
            idempotencyKey: id(),
          });
          check(
            op.status === "completed",
            "operation_failed",
            op.error ?? op.status,
          );
          result = op.result;
        }
      }
      send(res, 200, result);
    } catch (error) {
      const known = error instanceof HarnessError,
        validation = error instanceof z.ZodError;
      send(res, known ? error.status : validation ? 400 : 500, {
        error: known
          ? error.code
          : validation
            ? "invalid_request"
            : "internal_error",
        message: known
          ? error.message
          : validation
            ? "Request validation failed"
            : "The engine could not complete this request",
        ...(known && error.details ? { details: error.details } : {}),
      });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 32;
  return server;
}
