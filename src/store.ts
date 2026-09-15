import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync, lstatSync } from "node:fs";
import { dirname } from "node:path";
import { check, id, type Clock, EngineClock } from "./core.js";
import {
  recoveryClockSource,
  recoveryElapsed,
  type ClockCheckpoint,
  type RecoveryClockSource,
} from "./recovery-clock.js";

export class Store {
  readonly db: DatabaseSync;
  readonly clock: Clock;
  private inTransaction = false;
  private transactionAudited = false;
  private previousClock?: ClockCheckpoint;
  private recoverySource?: RecoveryClockSource;
  private denialClockRecovered = false;
  private auditFailure?: { event: string; reason: string; time: number };
  private failureListeners: Array<() => void> = [];
  get fault() {
    return this.auditFailure;
  }
  assertHealthy() {
    check(
      !this.auditFailure,
      "required_audit_failed",
      "Required audit storage failed; restart and reconciliation are required",
    );
  }
  onAuditFailure(fn: () => void) {
    this.failureListeners.push(fn);
  }
  private latchAuditFailure(event: string, error: unknown) {
    if (this.auditFailure) return;
    this.auditFailure = {
      event,
      reason: String(error),
      time: this.clock.now(),
    };
    queueMicrotask(() => {
      for (const notify of this.failureListeners) notify();
    });
  }
  constructor(
    path: string,
    clock?: Clock,
    recoverySource?: RecoveryClockSource,
  ) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      check(!lstatSync(dirname(path)).isSymbolicLink(), "storage_symlink");
    }
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, repository TEXT NOT NULL DEFAULT '', session TEXT NOT NULL DEFAULT '', data TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS scope_idx ON records(kind,repository,session);
      CREATE TABLE IF NOT EXISTS nonces (id TEXT PRIMARY KEY, integration TEXT NOT NULL, repository TEXT NOT NULL, runtime_session TEXT NOT NULL, connection TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, registration TEXT);
      CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, time INTEGER NOT NULL, repository TEXT NOT NULL, session TEXT NOT NULL, event TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS denials (id TEXT PRIMARY KEY, time INTEGER NOT NULL, repository TEXT NOT NULL, session TEXT NOT NULL, root TEXT NOT NULL, rule TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS denial_time ON denials(time);
    `);
    this.previousClock = this.get<ClockCheckpoint>("meta", "clock");
    this.recoverySource =
      recoverySource ?? (clock ? undefined : recoveryClockSource());
    this.clock = clock ?? new EngineClock(this.previousClock?.time);
  }
  private clockCheckpoint(): ClockCheckpoint {
    return {
      time: this.clock.now(),
      ...(this.recoverySource
        ? {
            wall: this.recoverySource.wall(),
            uptime: this.recoverySource.uptime(),
            boot: this.recoverySource.boot,
          }
        : {}),
    };
  }
  recoverDenialClock() {
    if (this.denialClockRecovered) return;
    this.denialClockRecovered = true;
    if (!this.previousClock || !this.recoverySource) return;
    const current = this.clockCheckpoint(),
      previous = this.previousClock,
      recovery = recoveryElapsed(previous, current),
      shift = current.time - previous.time - recovery.elapsed;
    this.transaction(() => {
      this.db.prepare("UPDATE denials SET time=time+?").run(shift);
      if (recovery.uncertain)
        this.audit("monitor.clock_recovered", {
          previous,
          current,
          elapsed: recovery.elapsed,
          reason:
            "Recent denial ages retained conservatively after clock or boot change",
        });
    });
  }
  get<T>(kind: string, key: string): T | undefined {
    const row = this.db
      .prepare("SELECT data FROM records WHERE kind=? AND id=?")
      .get(kind, key);
    return row ? (JSON.parse(row.data as string) as T) : undefined;
  }
  list<T>(kind: string, repository?: string, session?: string): T[] {
    const sql =
      "SELECT data FROM records WHERE kind=?" +
      (repository === undefined ? "" : " AND repository=?") +
      (session === undefined ? "" : " AND session=?");
    const args = [
      kind,
      ...(repository === undefined ? [] : [repository]),
      ...(session === undefined ? [] : [session]),
    ];
    return this.db
      .prepare(sql)
      .all(...args)
      .map((row) => JSON.parse(row.data as string) as T);
  }
  put(
    kind: string,
    key: string,
    value: unknown,
    repository = "",
    session = "",
  ) {
    this.db
      .prepare(
        "INSERT INTO records(kind,id,repository,session,data) VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET repository=excluded.repository,session=excluded.session,data=excluded.data",
      )
      .run(kind, key, repository, session, JSON.stringify(value));
  }
  remove(kind: string, key: string) {
    this.db.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, key);
  }
  transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    for (let attempt = 0; ; attempt++) {
      try {
        this.db.exec("BEGIN IMMEDIATE");
        break;
      } catch (error) {
        if (attempt >= 2 || !String(error).includes("locked")) throw error;
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          10 * (attempt + 1),
        );
      }
    }
    this.inTransaction = true;
    this.transactionAudited = false;
    try {
      const result = fn();
      check(
        !(result instanceof Promise),
        "async_transaction",
        "Transactions cannot contain asynchronous effects",
      );
      this.put("meta", "clock", this.clockCheckpoint());
      try {
        this.db.exec("COMMIT");
      } catch (error) {
        if (this.transactionAudited)
          this.latchAuditFailure("transaction.commit", error);
        throw error;
      }
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }
  audit(event: string, data: unknown, repository = "", session = "") {
    try {
      this.db
        .prepare(
          "INSERT INTO audit(id,time,repository,session,event,data) VALUES(?,?,?,?,?,?)",
        )
        .run(
          id(),
          this.clock.now(),
          repository,
          session,
          event,
          JSON.stringify(data),
        );
      if (this.inTransaction) this.transactionAudited = true;
    } catch (error) {
      // This in-memory latch survives a rollback of the failed audit transaction.
      this.latchAuditFailure(event, error);
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
