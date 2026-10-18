import { check, digest, id, type Session } from "./core.js";
import type { Store } from "./store.js";
import type { Policies } from "./policy.js";
import type { Evidence } from "./gateway.js";
import { sanitize, type Sanitized } from "./sanitize.js";

export interface ExternalReview {
  id: string;
  key: string;
  repository: string;
  root: string;
  session: string;
  url: string;
  mode: "approve-url" | "approve-content";
  state: "pending" | "approved" | "rejected";
  evidence?: string;
  hash?: string;
  /** What the owner saw and, once approved, what the model may receive. */
  text?: string;
  flags?: Sanitized["flags"];
  comment?: string;
  created: number;
  decided?: number;
}
export type ResearchResult =
  | {
      status: "released";
      id: string;
      hash: string;
      url: string;
      trust: "untrusted";
      content: string;
      truncated: boolean;
      flags: Sanitized["flags"];
      review?: string;
    }
  | {
      status: "awaiting_review";
      review: string;
      url: string;
      mode: string;
      message: string;
    }
  | {
      status: "rejected";
      review: string;
      url: string;
      comment?: string;
      message: string;
    };
/** Tells the agent plainly that this is a wait, not a failure or a denial. */
const waiting = (mode: string) =>
  mode === "approve-url"
    ? "This address is waiting for the owner to approve the fetch. Nothing was fetched. Tell the owner it is pending under Reviews and request it again after approval; do not treat this as a network failure."
    : "The page was fetched but is held for the owner's review. You cannot see it yet. Tell the owner it is pending under Reviews and request the same URL again after approval; do not treat this as a network failure.";

/** Fetched content reaches a model only after the owner's configured review.
 * Approvals bind the exact URL for the root session and, in content mode, the
 * exact evidence hash the owner read. */
export class ExternalReviews {
  constructor(
    readonly store: Store,
    readonly policies: Policies,
  ) {}
  private release(
    evidence: Evidence,
    text: string,
    flags: Sanitized["flags"],
    review?: string,
  ): ResearchResult {
    return {
      status: "released",
      id: evidence.id,
      hash: evidence.hash,
      url: evidence.url,
      trust: "untrusted",
      content: text,
      truncated: evidence.content.length > text.length,
      flags,
      review,
    };
  }
  async handle(
    scope: Session,
    url: string,
    fetch: () => Promise<Evidence>,
  ): Promise<ResearchResult> {
    const review = this.policies.effective(scope.repository).policy.humanReview,
      trusted = review.trustedDomains.includes(new URL(url).hostname),
      mode = trusted ? "off" : review.externalContent;
    if (mode === "off") {
      const evidence = await fetch(),
        clean = sanitize(evidence.content);
      return this.release(evidence, clean.text, clean.flags);
    }
    const key = `${scope.root}:${digest(url)}`;
    const existing = this.store.get<ExternalReview>("external-review", key);
    if (existing?.state === "rejected")
      return {
        status: "rejected",
        review: existing.id,
        url,
        comment: existing.comment,
        message:
          "The owner rejected this URL for this task. Do not request it again; continue without it or ask the owner.",
      };
    if (existing?.state === "pending")
      return {
        status: "awaiting_review",
        review: existing.id,
        url,
        mode: existing.mode,
        message: waiting(existing.mode),
      };
    if (existing?.state === "approved") {
      // The model receives exactly what the owner approved, never a refetch.
      if (existing.mode === "approve-content") {
        const evidence = this.store.get<Evidence>(
          "evidence",
          existing.evidence!,
        );
        check(
          evidence &&
            evidence.hash === existing.hash &&
            existing.text !== undefined,
          "external_review_stale",
        );
        return this.release(
          evidence,
          existing.text,
          existing.flags ?? [],
          existing.id,
        );
      }
      const evidence = await fetch(),
        clean = sanitize(evidence.content);
      return this.release(evidence, clean.text, clean.flags, existing.id);
    }
    const record: ExternalReview = {
      id: id(),
      key,
      repository: scope.repository,
      root: scope.root,
      session: scope.session,
      url,
      mode,
      state: "pending",
      created: this.store.clock.now(),
    };
    if (mode === "approve-content") {
      const evidence = await fetch(),
        clean = sanitize(evidence.content);
      record.evidence = evidence.id;
      record.hash = evidence.hash;
      record.text = clean.text;
      record.flags = clean.flags;
    }
    return this.store.transaction(() => {
      const raced = this.store.get<ExternalReview>("external-review", key);
      const saved = raced && raced.state !== "rejected" ? raced : record;
      if (saved === record) {
        this.store.put(
          "external-review",
          key,
          record,
          record.repository,
          record.root,
        );
        this.store.audit(
          "external.review_requested",
          { id: record.id, url, mode, hash: record.hash, flags: record.flags },
          record.repository,
          record.session,
        );
      }
      return {
        status: "awaiting_review" as const,
        review: saved.id,
        url,
        mode: saved.mode,
        message: waiting(saved.mode),
      };
    });
  }
  list() {
    return this.store.list<ExternalReview>("external-review");
  }
  pending(root: string) {
    return this.list().filter((r) => r.root === root && r.state === "pending");
  }
  decide(reviewId: string, decision: "approve" | "reject", comment?: string) {
    return this.store.transaction(() => {
      const record = this.list().find((r) => r.id === reviewId);
      check(record, "external_review_not_found", "Review not found", 404);
      check(record.state === "pending", "external_review_decided");
      if (decision === "approve" && record.mode === "approve-content") {
        // The evidence must still be the content the owner read.
        const evidence = this.store.get<Evidence>("evidence", record.evidence!);
        check(
          evidence && evidence.hash === record.hash,
          "external_review_stale",
        );
      }
      record.state = decision === "approve" ? "approved" : "rejected";
      record.comment = comment?.slice(0, 2000);
      record.decided = this.store.clock.now();
      this.store.put(
        "external-review",
        record.key,
        record,
        record.repository,
        record.root,
      );
      this.store.audit(
        "external.review_decided",
        { id: record.id, decision, url: record.url, hash: record.hash },
        record.repository,
        record.session,
      );
      return record;
    });
  }
}
