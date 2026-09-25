import {
  check,
  digest,
  hash,
  id,
  stages,
  type Role,
  type Session,
  type Stage,
  type Trust,
} from "./core.js";
import type { Store } from "./store.js";
import type { Identity } from "./identity.js";
import type { Policies, ModelCapabilities } from "./policy.js";
import type { Operations, ActionApproval } from "./operations.js";
export interface Artifact {
  id: string;
  repository: string;
  session: string;
  root: string;
  kind: string;
  hash: string;
  content: string;
  dependencies: string[];
  sources: string[];
  trust: Trust;
  policy: string;
  valid: boolean;
  sharedWith: string[];
  created: number;
}
export interface Review {
  id: string;
  artifact: string;
  hash: string;
  dependencies: Record<string, string>;
  policy: string;
  reviewer: string;
  findings: Array<{ message: string; blocking: boolean }>;
  created: number;
}
export interface StageAttempt {
  root: string;
  stage: Stage;
  artifact: string;
  revision: number;
  state:
    | "review"
    | "human_gate"
    | "revision_required"
    | "passed"
    | "needs_attention";
  review?: string;
  humanApproval?: string;
}
export class Artifacts {
  private onInvalidate: (root: string) => void = () => {};
  private invalidationListeners = new Set<
    (artifacts: ReadonlySet<string>) => void
  >();
  onInvalidation(listener: (artifacts: ReadonlySet<string>) => void) {
    this.invalidationListeners.add(listener);
  }
  constructor(
    readonly store: Store,
    readonly identity: Identity,
  ) {}
  setInvalidator(fn: (root: string) => void) {
    this.onInvalidate = fn;
  }
  get(scope: Session, key: string): Artifact {
    const a = this.store.get<Artifact>("artifact", key);
    check(
      a &&
        a.repository === scope.repository &&
        (a.session === scope.session || a.sharedWith.includes(scope.session)),
      "artifact_not_found",
      "Artifact not found",
      404,
    );
    check(hash(a.content) === a.hash, "artifact_integrity");
    return a;
  }
  page(
    scope: Session,
    key: string,
    expectedHash: string,
    offset = 0,
    bytes = 512,
  ) {
    const artifact = this.get(scope, key);
    check(artifact.hash === expectedHash, "artifact_version_changed");
    const content = Buffer.from(artifact.content, "utf8");
    check(
      Number.isSafeInteger(offset) &&
        offset >= 0 &&
        offset <= content.length &&
        Number.isSafeInteger(bytes) &&
        bytes >= 4 &&
        bytes <= 1024,
      "artifact_page_range",
    );
    check(
      offset === content.length || (content[offset]! & 0xc0) !== 0x80,
      "artifact_page_boundary",
    );
    let end = Math.min(content.length, offset + bytes);
    // Page offsets count UTF-8 bytes. Never split a multibyte character; the
    // next offset is exact and makes progress even at the minimum page size.
    while (end < content.length && (content[end]! & 0xc0) === 0x80) end--;
    return {
      id: artifact.id,
      hash: artifact.hash,
      trust: artifact.trust,
      valid: artifact.valid,
      offset,
      bytes: end - offset,
      next: end < content.length ? end : null,
      totalBytes: content.length,
      content: content.subarray(offset, end).toString("utf8"),
    };
  }
  source(scope: Session, key: string) {
    const evidence = this.store.get<{
      repository: string;
      session: string;
      trust: Trust;
      hash: string;
    }>("evidence", key);
    if (evidence) {
      check(
        evidence.repository === scope.repository &&
          evidence.session === scope.session,
        "evidence_not_found",
      );
      return evidence;
    }
    return this.get(scope, key);
  }
  create(
    scope: Session,
    input: {
      kind: string;
      content: string;
      dependencies: string[];
      sources: string[];
      shareWithRoot?: boolean;
    },
  ): Artifact {
    check(Buffer.byteLength(input.content) <= 2_000_000, "artifact_size");
    check(input.kind.length > 0 && input.kind.length <= 80, "artifact_kind");
    for (const dependency of input.dependencies)
      check(this.get(scope, dependency).valid, "dependency_invalid");
    for (const source of input.sources) this.source(scope, source);
    const artifact: Artifact = {
      id: id(),
      repository: scope.repository,
      session: scope.session,
      root: scope.root,
      kind: input.kind,
      hash: hash(input.content),
      content: input.content,
      dependencies: [...new Set(input.dependencies)],
      sources: [...new Set(input.sources)],
      trust: "untrusted",
      policy: scope.policy,
      valid: true,
      sharedWith:
        input.shareWithRoot && scope.root !== scope.session ? [scope.root] : [],
      created: this.store.clock.now(),
    };
    this.store.transaction(() => {
      this.store.put(
        "artifact",
        artifact.id,
        artifact,
        scope.repository,
        scope.session,
      );
      this.store.audit(
        "artifact.created",
        {
          id: artifact.id,
          hash: artifact.hash,
          trust: artifact.trust,
          dependencies: artifact.dependencies,
          sources: artifact.sources,
        },
        scope.repository,
        scope.session,
      );
    });
    return artifact;
  }
  share(scope: Session, key: string, target: string) {
    this.store.transaction(() => {
      const a = this.get(scope, key);
      check(a.session === scope.session, "artifact_owner");
      const recipient = this.identity.session(target);
      check(recipient.repository === scope.repository, "repository_isolation");
      a.sharedWith = [...new Set([...a.sharedWith, target])];
      this.store.put("artifact", a.id, a, a.repository, a.session);
      this.store.audit(
        "artifact.shared",
        { artifact: key, target },
        a.repository,
        a.session,
      );
    });
  }
  /** Forward only content explicitly visible to this Conductor, preserving its
   * original owner and trust. Admission wraps sharing and assignment atomically. */
  shareForDelegation(parent: Session, key: string, child: Session) {
    const artifact = this.get(parent, key);
    check(
      parent.role === "Conductor" &&
        child.parent === parent.session &&
        child.root === parent.root &&
        child.repository === parent.repository &&
        artifact.root === parent.root,
      "delegation_scope",
    );
    artifact.sharedWith = [...new Set([...artifact.sharedWith, child.session])];
    this.store.put(
      "artifact",
      artifact.id,
      artifact,
      artifact.repository,
      artifact.session,
    );
    this.store.audit(
      "artifact.delegated",
      { artifact: key, owner: artifact.session, target: child.session },
      parent.repository,
      parent.session,
    );
  }
  invalidate(scope: Session, key: string) {
    const artifact = this.get(scope, key);
    check(artifact.session === scope.session, "artifact_owner");
    return this.store.transaction(() => {
      const all = this.store.list<Artifact>("artifact", scope.repository),
        invalid = new Set([key]);
      const visit = (key: string, ancestors: Set<string>) => {
        check(!ancestors.has(key), "dependency_cycle");
        const next = new Set([...ancestors, key]);
        for (const a of all.filter((a) => a.dependencies.includes(key))) {
          visit(a.id, next);
          invalid.add(a.id);
        }
      };
      visit(key, new Set());
      for (const a of all.filter((a) => invalid.has(a.id))) {
        a.valid = false;
        this.store.put("artifact", a.id, a, a.repository, a.session);
      }
      for (const approval of this.store.list<ActionApproval>(
        "action-approval",
        scope.repository,
      ))
        if (approval.dependencies.some((d) => invalid.has(d))) {
          approval.valid = false;
          this.store.put(
            "action-approval",
            approval.id,
            approval,
            scope.repository,
            approval.session,
          );
        }
      for (const listener of this.invalidationListeners) listener(invalid);
      for (const root of new Set(
        all.filter((a) => invalid.has(a.id)).map((a) => a.root),
      ))
        if (
          this.store
            .list<StageAttempt>("stage-attempt", scope.repository, root)
            .some((a) => invalid.has(a.artifact))
        )
          this.onInvalidate(root);
      this.store.audit(
        "artifact.invalidated",
        { ids: [...invalid] },
        scope.repository,
        scope.session,
      );
      return [...invalid];
    });
  }
  assertDag(repository: string) {
    const all = this.store.list<Artifact>("artifact", repository),
      map = new Map(all.map((a) => [a.id, a]));
    const visited = new Set<string>(),
      visiting = new Set<string>();
    const visit = (key: string) => {
      check(!visiting.has(key), "dependency_cycle");
      if (visited.has(key)) return;
      visiting.add(key);
      const a = map.get(key);
      check(a, "dependency_missing");
      for (const dep of a.dependencies) visit(dep);
      visiting.delete(key);
      visited.add(key);
    };
    for (const a of all) visit(a.id);
  }
}
export class Workflow {
  constructor(
    readonly store: Store,
    readonly identity: Identity,
    readonly policies: Policies,
    readonly artifacts: Artifacts,
    readonly operations: Operations,
    private models:
      ModelCapabilities | ((session: Session) => ModelCapabilities) = {},
  ) {}
  admit(
    parent: Session,
    role: Exclude<Role, "Conductor">,
    setting?: { model: string; reasoning: string },
  ) {
    return this.store.transaction(() => {
      const current = this.identity.session(parent.session);
      check(
        current.status === "active" && current.generation === parent.generation,
        "parent_inactive",
      );
      check(current.role === "Conductor", "delegation_authority");
      const effective = this.policies.effective(current.repository),
        all = this.store.list<Session>("session", current.repository);
      check(current.depth < effective.policy.maxDepth, "delegation_depth");
      check(
        all.filter(
          (s) =>
            s.root === current.root && s.parent && s.status !== "terminated",
        ).length < effective.policy.maxSpecialists,
        "specialist_limit",
      );
      const config = setting ?? effective.policy.models[role];
      const capabilities =
        typeof this.models === "function" ? this.models(current) : this.models;
      if (config)
        check(
          capabilities[role]?.[config.model]?.includes(config.reasoning),
          "unsupported_model",
        );
      const sessionId = id();
      const child: Session = {
        ...current,
        session: sessionId,
        parent: current.session,
        role,
        depth: current.depth + 1,
        runtimeSession: `${current.runtimeSession}:${sessionId}`,
        connection: id(),
        generation: 1,
        enforcement: "unverified",
        model: config,
        created: this.store.clock.now(),
      };
      this.identity.saveSession(child);
      this.store.audit(
        "specialist.admitted",
        {
          session: child.session,
          parent: current.session,
          role,
          model: config,
        },
        child.repository,
        child.session,
      );
      return { session: child };
    });
  }
  terminate(scope: Session, target: string) {
    const child = this.identity.session(target);
    check(
      scope.role === "Conductor" &&
        child.parent === scope.session &&
        child.root === scope.root &&
        child.repository === scope.repository,
      "delegation_scope",
    );
    this.operations.invalidate(child.session, "session_terminated");
  }
  submit(scope: Session, artifactId: string): StageAttempt {
    return this.store.transaction(() => {
      const root = this.identity.session(scope.root);
      check(
        root.status === "active" && root.stage !== "complete",
        "workflow_inactive",
      );
      const expected: Record<string, Role> = {
        research: "Researcher",
        plan: "Planner",
        implementation: "Implementer",
        execution: "Verifier",
        verification: "Verifier",
      };
      check(scope.role === expected[root.stage], "stage_role");
      const artifact = this.artifacts.get(scope, artifactId);
      check(
        artifact.valid &&
          artifact.session === scope.session &&
          artifact.policy === root.policy &&
          artifact.root === root.root,
        "stage_artifact",
      );
      const key = `${root.root}:${root.stage}`,
        previous = this.store.get<StageAttempt>("stage-attempt", key);
      check(
        !previous || previous.state === "revision_required",
        "review_pending",
      );
      const revision = previous ? previous.revision + 1 : 0,
        limit = this.policies.effective(scope.repository).policy.revisionLimit;
      check(revision <= limit, "revision_limit");
      const attempt: StageAttempt = {
        root: root.root,
        stage: root.stage,
        artifact: artifact.id,
        revision,
        state: "review",
      };
      this.store.put(
        "stage-attempt",
        key,
        attempt,
        scope.repository,
        root.root,
      );
      this.store.audit(
        "workflow.submitted",
        attempt,
        scope.repository,
        scope.session,
      );
      return attempt;
    });
  }
  review(
    scope: Session,
    artifactId: string,
    findings: Review["findings"],
  ): Review {
    return this.store.transaction(() => {
      check(scope.role === "Reviewer", "reviewer_role");
      const artifact = this.artifacts.get(scope, artifactId);
      check(
        artifact.valid &&
          artifact.session !== scope.session &&
          artifact.root === scope.root,
        "review_artifact",
      );
      const root = this.identity.session(scope.root),
        key = `${scope.root}:${root.stage}`,
        attempt = this.store.get<StageAttempt>("stage-attempt", key);
      check(
        attempt?.artifact === artifactId && attempt.state === "review",
        "review_not_requested",
      );
      this.artifacts.assertDag(scope.repository);
      const deps: Record<string, string> = {};
      for (const dep of artifact.dependencies) {
        const a = this.store.get<Artifact>("artifact", dep);
        check(
          a?.valid && a.repository === scope.repository,
          "dependency_invalid",
        );
        deps[dep] = a.hash;
      }
      const review: Review = {
        id: id(),
        artifact: artifactId,
        hash: artifact.hash,
        dependencies: deps,
        policy: root.policy,
        reviewer: scope.session,
        findings,
        created: this.store.clock.now(),
      };
      this.store.put(
        "review",
        review.id,
        review,
        scope.repository,
        scope.session,
      );
      attempt.review = review.id;
      if (findings.some((f) => f.blocking)) {
        if (
          attempt.revision >=
          this.policies.effective(scope.repository).policy.revisionLimit
        ) {
          attempt.state = "needs_attention";
          root.status = "needs_attention";
          this.identity.saveSession(root);
        } else attempt.state = "revision_required";
      } else if (
        this.policies
          .effective(scope.repository)
          .policy.humanGates.includes(root.stage as Exclude<Stage, "complete">)
      )
        attempt.state = "human_gate";
      else this.advance(root, attempt);
      this.store.put(
        "stage-attempt",
        key,
        attempt,
        scope.repository,
        scope.root,
      );
      this.store.audit(
        "review.completed",
        { review: review.id, attempt },
        scope.repository,
        scope.session,
      );
      return review;
    });
  }
  approveStage(rootId: string, artifactId: string, reviewId: string) {
    return this.store.transaction(() => {
      const root = this.identity.session(rootId),
        key = `${root.root}:${root.stage}`,
        attempt = this.store.get<StageAttempt>("stage-attempt", key);
      check(
        attempt?.state === "human_gate" &&
          attempt.artifact === artifactId &&
          attempt.review === reviewId,
        "human_gate_stale",
      );
      this.validateAttempt(root, attempt);
      attempt.humanApproval = id();
      this.advance(root, attempt);
      this.store.put("stage-attempt", key, attempt, root.repository, root.root);
      this.store.audit(
        "review.human_approved",
        { artifactId, reviewId, approval: attempt.humanApproval },
        root.repository,
        root.root,
      );
      return attempt;
    });
  }
  private validateAttempt(root: Session, attempt: StageAttempt) {
    check(
      root.status === "active" &&
        root.policy === this.policies.effective(root.repository).id,
      "workflow_authority",
    );
    const a = this.store.get<Artifact>("artifact", attempt.artifact),
      r = this.store.get<Review>("review", attempt.review ?? "");
    check(
      a?.valid &&
        r &&
        a.hash === r.hash &&
        a.policy === r.policy &&
        r.policy === root.policy &&
        !r.findings.some((f) => f.blocking),
      "review_stale",
    );
    for (const [key, hash] of Object.entries(r.dependencies)) {
      const dep = this.store.get<Artifact>("artifact", key);
      check(dep?.valid && dep.hash === hash, "review_dependency_stale");
    }
  }
  private advance(root: Session, attempt: StageAttempt) {
    this.validateAttempt(root, attempt);
    attempt.state = "passed";
    root.stage = stages[stages.indexOf(root.stage) + 1] ?? "complete";
    this.identity.saveSession(root);
  }
  reviewChange(
    scope: Session,
    artifactId: string,
    findings: Review["findings"],
  ): Review {
    return this.store.transaction(() => {
      check(scope.role === "Reviewer", "reviewer_role");
      const artifact = this.artifacts.get(scope, artifactId);
      check(
        artifact.valid &&
          artifact.session !== scope.session &&
          artifact.root === scope.root &&
          artifact.kind === "change-set",
        "review_artifact",
      );
      const review: Review = {
        id: id(),
        artifact: artifactId,
        hash: artifact.hash,
        dependencies: {},
        policy: scope.policy,
        reviewer: scope.session,
        findings,
        created: this.store.clock.now(),
      };
      for (const dep of artifact.dependencies) {
        const a = this.store.get<Artifact>("artifact", dep);
        check(a?.valid, "dependency_invalid");
        review.dependencies[dep] = a.hash;
      }
      this.store.put(
        "review",
        review.id,
        review,
        scope.repository,
        scope.session,
      );
      this.store.audit(
        "change.reviewed",
        { review: review.id, artifact: artifactId },
        scope.repository,
        scope.session,
      );
      return review;
    });
  }
  approveAction(
    rootId: string,
    tool: string,
    args: Record<string, unknown>,
    dependencies: string[],
    human: boolean,
  ) {
    return this.store.transaction(() => {
      const root = this.identity.session(rootId);
      check(root.status === "active", "workflow_inactive");
      check(dependencies.length > 0, "review_evidence_required");
      let exactChange = false;
      for (const key of dependencies) {
        const a = this.store.get<Artifact>("artifact", key);
        check(
          a?.valid &&
            a.repository === root.repository &&
            a.root === root.root &&
            a.policy === root.policy,
          "approval_artifact",
        );
        if (a.kind === "change-set") {
          const change = JSON.parse(a.content);
          if (digest(change) === this.operations.actionHash(tool, args))
            exactChange = true;
        }
        const reviews = this.store
          .list<Review>("review", root.repository)
          .filter(
            (r) =>
              r.artifact === key &&
              r.hash === a.hash &&
              r.policy === root.policy,
          );
        check(
          reviews.length > 0 &&
            reviews.every((r) => !r.findings.some((f) => f.blocking)),
          "review_required",
        );
      }
      check(exactChange, "reviewed_change_mismatch");
      const approval: ActionApproval = {
        id: id(),
        repository: root.repository,
        session: root.root,
        action: this.operations.actionHash(tool, args),
        policy: root.policy,
        human,
        valid: true,
        dependencies,
      };
      this.store.put(
        "action-approval",
        approval.id,
        approval,
        root.repository,
        root.root,
      );
      this.store.audit(
        "action.approved",
        { ...approval },
        root.repository,
        root.root,
      );
      return approval;
    });
  }
}
