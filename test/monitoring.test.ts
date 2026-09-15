import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { DenialMonitor, type Alert } from "../src/monitoring.js";
import type { Scope } from "../src/core.js";
import { TestClock } from "./helpers.js";
import type { RecoveryClockSource } from "../src/recovery-clock.js";
const scope: Scope = {
  repository: "repo",
  session: "child",
  root: "root",
  role: "Implementer",
  generation: 1,
  connection: "bridge",
};
test("denial windows: bursts across minutes, exact open boundary, all scopes and coalescing", () => {
  const clock = new TestClock();
  clock.time = 59_999;
  const store = new Store(":memory:", clock),
    monitor = new DenialMonitor(store);
  try {
    for (let i = 0; i < 9; i++) monitor.record(scope, "path");
    assert.equal(store.list("alert").length, 0);
    clock.tick(2);
    monitor.record(scope, "path");
    assert.equal(store.get<Alert>("alert", "session:child:60000")?.count, 10);
    for (let i = 0; i < 40; i++)
      monitor.record({ ...scope, session: `child-${i % 4}` }, "tool");
    assert.ok(store.get("alert", "root:root:60000"));
    assert.ok(store.get("alert", "repository:repo:60000"));
    assert.ok(store.get("alert", "user::60000"));
    clock.time = 119_999;
    const alerts = monitor.record(scope, "boundary");
    assert.equal(
      alerts.find((a) => a.scope === "session:child"),
      undefined,
    );
    assert.equal(
      store
        .get<Alert>("alert", "root:root:60000")
        ?.sessions.includes("child-3"),
      true,
    );
  } finally {
    store.close();
  }
});
test("denial windows: forward/backward wall jumps and reboot retain recent events conservatively", () => {
  for (const change of ["forward", "backward", "reboot", "unknown"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "harness-clock-")),
      clock = new TestClock();
    let wall = 1_000_000,
      elapsed = 50_000;
    const source: RecoveryClockSource = {
      wall: () => wall,
      uptime: () => elapsed,
      boot: "boot-one",
    };
    let store = new Store(join(dir, "state.sqlite"), clock, source);
    try {
      let monitor = new DenialMonitor(store);
      for (let n = 0; n < 9; n++) monitor.record(scope, "before-restart");
      store.close();
      wall += change === "backward" ? -3_600_000 : 3_600_000;
      clock.tick(change === "backward" ? 0 : 3_600_000);
      elapsed += 5000;
      if (change === "reboot") {
        source.boot = "boot-two";
        elapsed = 1000;
      }
      if (change === "unknown") source.boot = null;
      store = new Store(join(dir, "state.sqlite"), clock, source);
      monitor = new DenialMonitor(store);
      assert.equal(
        monitor
          .record(scope, "after-restart")
          .find((a) => a.scope === "session:child")?.count,
        10,
        change,
      );
      assert.equal(
        store.db
          .prepare(
            "SELECT COUNT(*) AS n FROM audit WHERE event='monitor.clock_recovered'",
          )
          .get()!.n,
        1,
      );
      // A second monitor on the same store must not rebase a second time.
      monitor = new DenialMonitor(store);
      wall += 86_400_000;
      clock.tick(59_999);
      const boundary = monitor
        .record(scope, "still-monotonic")
        .find((a) => a.scope === "session:child");
      if (change === "reboot" || change === "unknown")
        assert.equal(boundary?.count, 11);
      else assert.equal(boundary, undefined);
      clock.tick(1);
      assert.equal(
        monitor
          .record(scope, "exact-expiry")
          .find((a) => a.scope === "session:child"),
        undefined,
      );
      clock.tick(900_000);
      assert.equal(monitor.record(scope, "expired").length, 0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
test("denial windows: concurrent events, sustained activity, child attribution and restart recovery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-alert-")),
    clock = new TestClock();
  let store = new Store(join(dir, "state.sqlite"), clock);
  try {
    let monitor = new DenialMonitor(store);
    await Promise.all(
      Array.from({ length: 99 }, (_, i) =>
        Promise.resolve().then(() =>
          monitor.record(
            { ...scope, session: `terminated-child-${i}` },
            "denied",
          ),
        ),
      ),
    );
    store.close();
    store = new Store(join(dir, "state.sqlite"), clock);
    monitor = new DenialMonitor(store);
    clock.tick(60_001);
    const alerts = monitor.record(scope, "denied");
    assert.equal(
      alerts.find((a) => a.scope === "repository:repo" && a.window === 900_000)
        ?.count,
      100,
    );
    assert.equal(
      alerts.find((a) => a.scope === "user:" && a.window === 900_000)?.sessions
        .length,
      100,
    );
    clock.tick(900_000);
    assert.equal(monitor.record(scope, "expired").length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
