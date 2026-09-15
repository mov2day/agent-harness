import { id, type Scope } from "./core.js";
import type { Store } from "./store.js";
export interface Alert {
  id: string;
  scope: string;
  window: number;
  threshold: number;
  count: number;
  first: number;
  last: number;
  sessions: string[];
  rules: string[];
  acknowledged: boolean;
}
export class DenialMonitor {
  constructor(readonly store: Store) {
    store.recoverDenialClock();
  }
  record(scope: Scope, rule: string) {
    return this.store.transaction(() => {
      const now = this.store.clock.now(),
        event = id();
      this.store.db
        .prepare(
          "INSERT INTO denials(id,time,repository,session,root,rule) VALUES(?,?,?,?,?,?)",
        )
        .run(event, now, scope.repository, scope.session, scope.root, rule);
      const windows: Array<[string, string, string, number, number]> = [
        ["session", "session", scope.session, 60_000, 10],
        ["root", "root", scope.root, 60_000, 20],
        ["repository", "repository", scope.repository, 60_000, 30],
        ["user", "", "", 60_000, 50],
        ["repository", "repository", scope.repository, 900_000, 100],
        ["user", "", "", 900_000, 100],
      ];
      const triggered: Alert[] = [];
      for (const [kind, column, value, window, threshold] of windows) {
        const events = this.store.db
          .prepare(
            `SELECT session,rule FROM denials WHERE time>? AND time<=?${column ? ` AND ${column}=?` : ""}`,
          )
          .all(now - window, now, ...(column ? [value] : []));
        if (events.length < threshold) continue;
        const key = `${kind}:${value}:${window}`,
          previous = this.store.get<Alert>("alert", key);
        const alert: Alert = {
          id: key,
          scope: `${kind}:${value}`,
          window,
          threshold,
          count: events.length,
          first: previous?.first ?? now,
          last: now,
          sessions: [...new Set(events.map((e) => e.session as string))],
          rules: [...new Set(events.map((e) => e.rule as string))],
          acknowledged: false,
        };
        this.store.put(
          "alert",
          key,
          alert,
          kind === "repository" ? value : scope.repository,
        );
        triggered.push(alert);
      }
      this.store.audit(
        "authorization.denied",
        { event, rule },
        scope.repository,
        scope.session,
      );
      this.store.db
        .prepare("DELETE FROM denials WHERE time<=?")
        .run(now - 900_000);
      return triggered;
    });
  }
}
