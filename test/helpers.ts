import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../src/store.js";
import { Policies, defaultPolicy } from "../src/policy.js";
import { Identity, Repositories, type Registration } from "../src/identity.js";
import { sign } from "../src/core.js";
export class TestClock {
  time = 1_000_000;
  now() {
    return this.time;
  }
  tick(n: number) {
    this.time += n;
  }
}
export function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "harness-test-"));
  execFileSync("git", ["init", "-q", join(dir, "repo")], { stdio: "pipe" });
  execFileSync("git", ["init", "-q", join(dir, "other")], { stdio: "pipe" });
  const clock = new TestClock(),
    store = new Store(join(dir, "state.sqlite"), clock),
    policies = new Policies(store),
    repositories = new Repositories(store),
    identity = new Identity(store, policies, repositories);
  policies.publish("global", defaultPolicy, true);
  const repo = repositories.enroll(join(dir, "repo")),
    other = repositories.enroll(join(dir, "other"));
  const integration = identity.pair("opencode");
  const binding = {
    integration: integration.id,
    repository: repo.id,
    runtimeSession: "external-session",
    connection: "bridge-connection",
  };
  const challenge = identity.challenge(binding);
  const registration: Registration = { ...binding, nonce: challenge.nonce };
  const register = () =>
    identity.register(registration, sign(integration.secret, registration));
  return {
    dir,
    clock,
    store,
    policies,
    repositories,
    identity,
    repo,
    other,
    integration,
    binding,
    registration,
    register,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
