import { check, digest } from "../core.js";
import type { RuntimeRelay } from "./bridge.js";
export interface CodexRequest {
  id: string | number;
  method: string;
  params: Record<string, unknown>;
}
export interface CodexResponse {
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}
const tools = new Set([
  "read",
  "change",
  "delete",
  "rename",
  "research",
  "execute",
  "delegate",
  "artifact",
  "review",
  "compact",
  "learn",
]);
/** Separately implemented against the locally generated app-server schema. Native effects are never approved. */
export class CodexAdapter {
  private turn?: string;
  private pending = new Set<string>();
  private responses = new Map<
    string,
    { hash: string; response: CodexResponse }
  >();
  private stopped = false;
  constructor(
    private relay: RuntimeRelay,
    readonly threadId: string,
    private onStop: (reason: string) => void = () => {},
  ) {}
  turnStarted(threadId: string, turnId: string) {
    check(!this.stopped && threadId === this.threadId, "codex_thread_binding");
    check(!this.pending.size, "codex_tool_exchange_incomplete");
    this.turn = turnId;
  }
  async handle(request: CodexRequest): Promise<CodexResponse> {
    try {
      check(!this.stopped, "codex_adapter_stopped");
      const p = request.params;
      check(
        (p.threadId ?? p.conversationId) === this.threadId,
        "codex_thread_binding",
      );
      if (
        request.method === "item/commandExecution/requestApproval" ||
        request.method === "item/fileChange/requestApproval"
      )
        return { id: request.id, result: { decision: "decline" } };
      if (
        request.method === "execCommandApproval" ||
        request.method === "applyPatchApproval"
      )
        return { id: request.id, result: { decision: "denied" } };
      if (request.method === "item/permissions/requestApproval")
        return {
          id: request.id,
          result: { permissions: {}, scope: "turn", strictAutoReview: true },
        };
      check(request.method === "item/tool/call", "codex_method_unsupported");
      check(
        typeof p.turnId === "string" &&
          p.turnId === this.turn &&
          typeof p.callId === "string",
        "codex_turn_binding",
      );
      check(
        p.namespace === undefined ||
          p.namespace === null ||
          p.namespace === "agent_harness",
        "codex_tool_namespace",
      );
      check(
        typeof p.tool === "string" &&
          p.tool.startsWith("harness_") &&
          tools.has(p.tool.slice(8)),
        "codex_native_tool_denied",
      );
      const key = `${p.turnId}:${p.callId}`,
        requestHash = digest({ tool: p.tool, args: p.arguments }),
        previous = this.responses.get(key);
      if (previous) {
        check(previous.hash === requestHash, "codex_call_replay_mismatch");
        return { ...previous.response, id: request.id };
      }
      check(!this.pending.has(key), "codex_call_in_progress");
      this.pending.add(key);
      try {
        const result = await this.relay.execute({
          session: this.threadId,
          tool: p.tool.slice(8),
          args: p.arguments,
          call: key,
        });
        const operation = result as {
          status?: string;
          result?: unknown;
          id?: string;
          error?: string;
        };
        const success = operation.status
          ? operation.status === "completed"
          : true;
        const payload = operation.status
          ? {
              operation: operation.id,
              status: operation.status,
              result: operation.result,
              error: operation.error,
            }
          : result;
        const response: CodexResponse = {
          id: request.id,
          result: {
            success,
            contentItems: [
              { type: "inputText", text: JSON.stringify(payload) },
            ],
          },
        };
        this.responses.set(key, { hash: requestHash, response });
        return response;
      } finally {
        this.pending.delete(key);
      }
    } catch (error) {
      return {
        id: request.id,
        error: {
          code: -32000,
          message:
            error instanceof Error ? error.message : "Codex request rejected",
        },
      };
    }
  }
  async beforeCompaction() {
    check(
      !this.stopped && !this.pending.size,
      "codex_tool_exchange_incomplete",
    );
    return this.relay.context(this.threadId);
  }
  disconnected() {
    this.stopped = true;
    this.responses.clear();
    this.onStop("codex_connection_lost");
  }
  terminated(threadId: string) {
    check(threadId === this.threadId, "codex_thread_binding");
    this.disconnected();
  }
}
export const codexRuntimeProfile = {
  runtime: "codex",
  protocol: "app-server-v2",
  schemaVersion: "0.154.0-alpha.6.2",
  nativeApprovals: "decline",
  rootSessionLaunch: false,
  certified: false,
} as const;
