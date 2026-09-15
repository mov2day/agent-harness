import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.js";
import { Operations } from "../src/operations.js";
import { Store } from "../src/store.js";

test("required audit: failure rolls back admission, remains latched after storage recovers, and cancels active effects", async () => {
  const f = fixture();
  try {
    const session = f.register().session;
    session.enforcement = "enforced";
    f.identity.saveSession(session);
    const operations = new Operations(
        f.store,
        f.identity,
        f.policies,
        () => true,
      ),
      token = f.identity.issue(session).capability;
    const begin = (key: string) =>
      operations.begin(token, session.connection, {
        tool: "artifact",
        args: {
          kind: "draft",
          content: "input",
          dependencies: [],
          sources: [],
          trust: "untrusted",
        },
        idempotencyKey: key,
      });
    const op = begin("active");
    let aborted = false;
    const running = operations.run(
      op,
      (signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true },
          ),
        ),
    );
    // Simulate an actual SQLite audit write failure, independently of application code.
    f.store.db.exec(
      "CREATE TRIGGER fail_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'audit disk failure'); END",
    );
    assert.throws(() => begin("denied"), /audit disk failure/);
    assert.equal(f.store.list("operation").length, 1);
    assert.equal(f.store.fault?.reason.includes("audit disk failure"), true);
    const failed = assert.rejects(running, /audit disk failure/);
    await failed;
    assert.equal(aborted, true);
    f.store.db.exec("DROP TRIGGER fail_audit");
    assert.throws(
      () => begin("still-blocked"),
      /Required audit storage failed/,
    );
    assert.notEqual(operations.current(op).status, "completed");
    // The durable running intent survives the failed outcome transaction and is
    // reconciled on restart; no external effect is retried by a storage retry.
    operations.recover();
    assert.equal(operations.current(op).status, "requires_reconciliation");
    assert.equal(f.identity.session(session.session).status, "paused");
  } finally {
    f.close();
  }
});
test("required audit: a failed durable commit latches storage health even after an audit insert succeeds", () => {
  const store = new Store(":memory:");
  try {
    store.db.exec(
      "CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(parent INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)",
    );
    assert.throws(
      () =>
        store.transaction(() => {
          store.db.prepare("INSERT INTO child(parent) VALUES(1)").run();
          store.audit("must-be-durable", {});
        }),
      /FOREIGN KEY constraint/,
    );
    assert.equal(store.fault?.event, "transaction.commit");
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM audit").get()!.n,
      0,
    );
    assert.throws(() => store.assertHealthy(), /Required audit storage failed/);
  } finally {
    store.close();
  }
});
