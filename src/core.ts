import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

export class HarnessError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 403,
    public details?: unknown,
  ) {
    super(message);
  }
}
export function check(
  value: unknown,
  code: string,
  message = code,
  status = 403,
): asserts value {
  if (!value) throw new HarnessError(code, message, status);
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`;
}
export const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const digest = (value: unknown) => hash(canonical(value));
export const id = () => randomUUID();
export const secret = () => randomBytes(32).toString("base64url");
export const sign = (key: string, value: unknown) =>
  createHmac("sha256", key).update(canonical(value)).digest("hex");
export function equal(a: string, b: string): boolean {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export interface Clock {
  now(): number;
}
export class EngineClock implements Clock {
  private origin = performance.now();
  private wall: number;
  constructor(last = 0) {
    this.wall = Math.max(Date.now(), last);
  }
  now() {
    return Math.floor(this.wall + performance.now() - this.origin);
  }
}
export const roles = [
  "Conductor",
  "Researcher",
  "Planner",
  "Implementer",
  "Reviewer",
  "Verifier",
] as const;
export type Role = (typeof roles)[number];
export const stages = [
  "research",
  "plan",
  "implementation",
  "execution",
  "verification",
  "complete",
] as const;
export type Stage = (typeof stages)[number];
export type Trust = "governing" | "untrusted";
export interface Scope {
  repository: string;
  session: string;
  root: string;
  role: Role;
  generation: number;
  connection: string;
}
export interface Session extends Scope {
  integration: string;
  runtimeSession: string;
  parent?: string;
  depth: number;
  status: "active" | "paused" | "terminated" | "needs_attention";
  stage: Stage;
  skills: Record<string, string>;
  model?: { model: string; reasoning: string };
  policy: string;
  enforcement: "unverified" | "enforced";
  created: number;
}
