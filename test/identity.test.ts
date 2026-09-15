import test from "node:test";
import assert from "node:assert/strict";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { sign } from "../src/core.js";
import { defaultPolicy } from "../src/policy.js";
import { fixture } from "./helpers.js";

test("registration: atomic nonce race, replay and lost-response recovery", async () => {
  const f = fixture();
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => Promise.resolve().then(f.register)),
    );
    assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(f.store.list("session").length, 1);
    assert.throws(f.register, /nonce_used_or_expired/);
    const time = f.clock.now(),
      proof = sign(f.integration.secret, {
        action: "registration-status",
        binding: f.registration,
        time,
      });
    const recovered = f.identity.status(f.registration, time, proof);
    assert.equal(recovered.registered, true);
    if (recovered.registered)
      assert.equal(
        f.identity.authenticate(recovered.capability, f.binding.connection)
          .role,
        "Conductor",
      );
  } finally {
    f.close();
  }
});
test("registration: expiry boundary and failed transaction consume neither nonce nor registration", () => {
  const f = fixture();
  try {
    const original = f.store.audit.bind(f.store);
    f.store.audit = () => {
      throw new Error("disk unavailable");
    };
    assert.throws(f.register, /disk unavailable/);
    assert.equal(f.store.list("session").length, 0);
    assert.equal(f.store.db.prepare("SELECT used FROM nonces").get()!.used, 0);
    f.store.audit = original;
    f.clock.tick(60_000);
    assert.throws(f.register, /nonce_used_or_expired/);
  } finally {
    f.close();
  }
});
test("registration: role, repository, integration and connection spoofing fail", () => {
  const f = fixture();
  try {
    assert.throws(() =>
      f.identity.register(
        { ...f.registration, role: "Implementer" },
        sign(f.integration.secret, f.registration),
      ),
    );
    for (const field of [
      "repository",
      "connection",
      "runtimeSession",
    ] as const) {
      const tampered = {
        ...f.registration,
        [field]: field === "repository" ? f.other.id : "spoof",
      };
      assert.throws(
        () =>
          f.identity.register(tampered, sign(f.integration.secret, tampered)),
        /nonce_binding/,
      );
    }
    const registered = f.register();
    assert.throws(
      () => f.identity.authenticate(registered.capability, "other"),
      /capability_scope/,
    );
    assert.equal(registered.session.enforcement, "unverified");
    assert.throws(() => f.repositories.enroll(join(f.dir, "missing")));
    symlinkSync(f.other.path, join(f.repo.path, "spoof"));
    assert.equal(
      f.repositories.enroll(join(f.repo.path, "spoof")).id,
      f.other.id,
    );
    assert.notEqual(f.other.id, f.repo.id);
  } finally {
    f.close();
  }
});
test("capability: exact expiry, renewal rotation, revoked tokens and failures", () => {
  const f = fixture();
  try {
    const registered = f.register();
    registered.session.enforcement = "enforced";
    f.identity.saveSession(registered.session);
    f.clock.tick(239_999);
    assert.equal(
      f.identity.authenticate(registered.capability, f.binding.connection).role,
      "Conductor",
    );
    f.clock.tick(1);
    const renewed = f.identity.renew(
      registered.capability,
      f.binding.connection,
    );
    assert.equal(renewed.expires, f.clock.now() + 300_000);
    assert.throws(
      () =>
        f.identity.authenticate(registered.capability, f.binding.connection),
      /capability_invalid/,
    );
    f.clock.tick(299_999);
    assert.ok(
      f.identity.authenticate(renewed.capability, f.binding.connection),
    );
    f.clock.tick(1);
    assert.throws(
      () => f.identity.renew(renewed.capability, f.binding.connection),
      /capability_expired/,
    );
  } finally {
    f.close();
  }
});
test("policy: field-specific ceiling errors preserve publication; active corruption fails closed", () => {
  const f = fixture();
  try {
    assert.throws(
      () =>
        f.policies.publish(f.repo.id, { ...defaultPolicy, maxDepth: 8 }, true),
      (e) =>
        typeof e === "object" &&
        e !== null &&
        "details" in e &&
        !!(e.details as { maxDepth: string }).maxDepth,
    );
    assert.deepEqual(f.policies.effective(f.repo.id).policy, defaultPolicy);
    const candidate = f.policies.publish(
      "global",
      { ...defaultPolicy, maxDepth: 3 },
      false,
    );
    assert.notEqual(f.policies.active("global").id, candidate.id);
    f.store.remove("policy-active", "global");
    assert.throws(() => f.policies.effective(f.repo.id), /missing/);
  } finally {
    f.close();
  }
});
test("policy: concrete overlapping denies, optional policy and strict command constraints", () => {
  const f = fixture();
  try {
    const global = {
      ...defaultPolicy,
      allowPaths: ["src/**"],
      denyPaths: ["src/secrets/**"],
    };
    f.policies.publish("global", global, true);
    const effective = f.policies.effective(f.repo.id);
    assert.equal(f.policies.path(effective, "src/main.ts"), true);
    assert.equal(f.policies.path(effective, "src/secrets/token"), false);
    assert.throws(() => f.policies.path(effective, "src/../outside"));
    assert.throws(
      () =>
        f.policies.publish(
          f.repo.id,
          { ...global, tools: [...global.tools, "execute"] },
          true,
        ),
      /exceeds/,
    );
    f.policies.publish(f.repo.id, global, true);
    f.store.remove("policy-active", f.repo.id);
    assert.throws(() => f.policies.effective(f.repo.id), /missing/);
  } finally {
    f.close();
  }
});
