import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.js";
import { Operations } from "../src/operations.js";
import { defaultPolicy } from "../src/policy.js";
function setup() {
  const f = fixture();
  f.policies.publish(
    "global",
    { ...defaultPolicy, timeoutMs: 3_600_000 },
    true,
  );
  const registration = f.register();
  registration.session.role = "Planner";
  registration.session.enforcement = "enforced";
  f.identity.saveSession(registration.session);
  f.identity.revokeTokens(registration.session.session);
  const token = f.identity.issue(registration.session).capability,
    operations = new Operations(f.store, f.identity, f.policies, () => true);
  return { ...f, registration, token, operations };
}
test("authority lifecycle: expired admission invalidation survives transaction rollback", () => {
  const f = setup();
  try {
    f.clock.tick(300_000);
    assert.throws(
      () =>
        f.operations.begin(f.token, f.binding.connection, {
          tool: "read",
          args: { path: "src/a" },
          idempotencyKey: "expiry",
        }),
      /capability_expired/,
    );
    assert.equal(
      f.identity.session(f.registration.session.session).status,
      "paused",
    );
    assert.equal(f.store.list("operation").length, 0);
  } finally {
    f.close();
  }
});
test("authority lifecycle: idle capabilities expire and unverified health cannot renew", () => {
  const f = setup();
  try {
    f.clock.tick(300_000);
    f.operations.sweep();
    assert.equal(
      f.identity.session(f.registration.session.session).status,
      "paused",
    );
  } finally {
    f.close();
  }
  const g = fixture();
  try {
    const r = g.register();
    new Operations(g.store, g.identity, g.policies, () => false);
    g.clock.tick(240_000);
    assert.throws(
      () => g.identity.renew(r.capability, g.binding.connection),
      /enforcement_unhealthy/,
    );
    assert.equal(g.identity.session(r.session.session).status, "paused");
  } finally {
    g.close();
  }
});
test("authority lifecycle: successful renewal extends a running lease without broadening actions", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = setup();
  try {
    const operation = f.operations.begin(f.token, f.binding.connection, {
      tool: "read",
      args: { path: "src/a" },
      idempotencyKey: "active",
    });
    let done!: (value: unknown) => void;
    let signal!: AbortSignal;
    const running = f.operations.run(operation, (received) => {
      signal = received;
      return new Promise((resolve) => (done = resolve));
    });
    f.operations.commit(operation, () => {});
    assert.equal(f.operations.current(operation).status, "admitted");
    f.clock.tick(240_000);
    t.mock.timers.tick(240_000);
    const renewed = f.identity.renew(f.token, f.binding.connection);
    assert.equal(f.operations.current(operation).expires, renewed.expires);
    assert.deepEqual(f.operations.current(operation).args, { path: "src/a" });
    f.clock.tick(60_000);
    t.mock.timers.tick(60_000);
    assert.equal(signal.aborted, false);
    assert.equal(f.identity.session(operation.session).status, "active");
    done("finished after original expiry");
    assert.equal((await running).status, "completed");
  } finally {
    f.close();
    t.mock.timers.reset();
  }
});
