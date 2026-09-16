import { execFileSync } from "node:child_process";
import {
  realpathSync,
  statSync,
  lstatSync,
  mkdtempSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  check,
  digest,
  equal,
  hash,
  id,
  secret,
  sign,
  type Scope,
  type Session,
} from "./core.js";
import type { Store } from "./store.js";
import type { Policies } from "./policy.js";
export interface Repository {
  id: string;
  path: string;
  device: number;
  inode: number;
  gitCommon: string;
  gitDir: string;
  caseSensitive: boolean;
  enrolled: number;
}
export interface Integration {
  id: string;
  secret: string;
  runtime: "opencode" | "codex";
  revoked: boolean;
}
export interface Capability {
  id: string;
  tokenHash: string;
  session: string;
  connection: string;
  repository: string;
  role: Scope["role"];
  generation: number;
  expires: number;
  revoked: boolean;
}
export interface Registration {
  integration: string;
  repository: string;
  runtimeSession: string;
  connection: string;
  nonce: string;
}
const registrationSchema = z
  .object({
    integration: z.string(),
    repository: z.string(),
    runtimeSession: z.string().min(1).max(256),
    connection: z.string().min(1).max(256),
    nonce: z.string(),
  })
  .strict();
const git = (root: string, args: string[]) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      HOME: "/nonexistent",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    timeout: 5000,
  }).trim();
export class Repositories {
  constructor(readonly store: Store) {}
  enroll(path: string): Repository {
    const root = realpathSync(path),
      top = realpathSync(git(root, ["rev-parse", "--show-toplevel"]));
    check(
      root === top,
      "repository_root",
      "Enroll the actual Git worktree root",
    );
    for (const profile of this.store.list<{ credentialFile: string }>(
      "model-profile",
    )) {
      check(
        profile.credentialFile !== root &&
          !profile.credentialFile.startsWith(`${root}/`),
        "provider_credential_in_repository",
      );
    }
    const common = realpathSync(
      resolve(root, git(root, ["rev-parse", "--git-common-dir"])),
    );
    const gitDir = realpathSync(
      resolve(root, git(root, ["rev-parse", "--git-dir"])),
    );
    const members = git(root, ["worktree", "list", "--porcelain", "-z"])
      .split("\0")
      .filter((x) => x.startsWith("worktree "))
      .map((x) => realpathSync(x.slice(9)));
    check(members.includes(root), "worktree_membership");
    const stat = statSync(root);
    const repositoryId = digest([stat.dev, stat.ino, common, gitDir]);
    const probe = mkdtempSync(join(root, ".harness-case-"));
    let caseSensitive: boolean;
    try {
      writeFileSync(join(probe, "CaseProbe"), "x", { flag: "wx" });
      caseSensitive = !existsSync(join(probe, "caseprobe"));
    } finally {
      unlinkSync(join(probe, "CaseProbe"));
      rmdirSync(probe);
    }
    const record: Repository = {
      id: repositoryId,
      path: root,
      device: stat.dev,
      inode: stat.ino,
      gitCommon: common,
      gitDir,
      caseSensitive,
      enrolled: this.store.clock.now(),
    };
    this.store.transaction(() => {
      this.store.put("repository", record.id, record, record.id);
      this.store.audit("repository.enrolled", record, record.id);
    });
    return record;
  }
  verify(repository: string): Repository {
    const r = this.store.get<Repository>("repository", repository);
    check(r, "repository_unknown");
    check(!lstatSync(r.path).isSymbolicLink(), "repository_changed");
    const s = statSync(r.path);
    check(
      s.dev === r.device &&
        s.ino === r.inode &&
        realpathSync(r.path) === r.path,
      "repository_changed",
    );
    check(
      realpathSync(
        resolve(r.path, git(r.path, ["rev-parse", "--git-common-dir"])),
      ) === r.gitCommon &&
        realpathSync(
          resolve(r.path, git(r.path, ["rev-parse", "--git-dir"])),
        ) === r.gitDir,
      "repository_changed",
    );
    check(
      git(r.path, ["worktree", "list", "--porcelain", "-z"])
        .split("\0")
        .includes(`worktree ${r.path}`),
      "worktree_membership",
    );
    return r;
  }
}
export class Identity {
  private invalidate: (session: string, reason: string) => void = () => {};
  private revalidate: (session: Session) => boolean = () => true;
  private extend: (session: Session, expires: number) => void = () => {};
  constructor(
    readonly store: Store,
    readonly policies: Policies,
    readonly repositories: Repositories,
  ) {}
  hooks(
    invalidate: typeof this.invalidate,
    revalidate: typeof this.revalidate,
    extend: typeof this.extend,
  ) {
    this.invalidate = invalidate;
    this.revalidate = revalidate;
    this.extend = extend;
  }
  pair(runtime: Integration["runtime"]): Integration {
    const record: Integration = {
      id: id(),
      secret: secret(),
      runtime,
      revoked: false,
    };
    this.store.transaction(() => {
      this.store.put("integration", record.id, record);
      this.store.audit("integration.paired", { id: record.id, runtime });
    });
    return record;
  }
  integration(integration: string) {
    const i = this.store.get<Integration>("integration", integration);
    check(i && !i.revoked, "integration_invalid");
    return i;
  }
  challenge(binding: Omit<Registration, "nonce">) {
    registrationSchema.omit({ nonce: true }).parse(binding);
    this.integration(binding.integration);
    this.repositories.verify(binding.repository);
    this.policies.effective(binding.repository);
    const nonce = id(),
      expires = this.store.clock.now() + 60_000;
    this.store.transaction(() =>
      this.store.db
        .prepare(
          "INSERT INTO nonces(id,integration,repository,runtime_session,connection,expires) VALUES(?,?,?,?,?,?)",
        )
        .run(
          nonce,
          binding.integration,
          binding.repository,
          binding.runtimeSession,
          binding.connection,
          expires,
        ),
    );
    return { ...binding, nonce, expires };
  }
  register(
    input: unknown,
    proof: string,
  ): { session: Session; capability: string; expires: number } {
    const binding = registrationSchema.parse(input);
    const integration = this.integration(binding.integration);
    check(
      equal(sign(integration.secret, binding), proof),
      "registration_proof",
    );
    this.repositories.verify(binding.repository);
    const policy = this.policies.effective(binding.repository);
    return this.store.transaction(() => {
      check(
        !this.store.get("specialist-nonce", binding.nonce),
        "nonce_purpose",
      );
      const nonce = this.store.db
        .prepare("SELECT * FROM nonces WHERE id=?")
        .get(binding.nonce);
      check(
        nonce &&
          nonce.integration === binding.integration &&
          nonce.repository === binding.repository &&
          nonce.runtime_session === binding.runtimeSession &&
          nonce.connection === binding.connection,
        "nonce_binding",
      );
      const sessionId = id();
      const result = this.store.db
        .prepare(
          "UPDATE nonces SET used=1,registration=? WHERE id=? AND used=0 AND expires>?",
        )
        .run(sessionId, binding.nonce, this.store.clock.now());
      check(result.changes === 1, "nonce_used_or_expired");
      check(
        !this.store
          .list<Session>("session", binding.repository)
          .some(
            (s) =>
              s.integration === binding.integration &&
              s.runtimeSession === binding.runtimeSession &&
              s.status !== "terminated",
          ),
        "session_already_registered",
      );
      const session: Session = {
        session: sessionId,
        root: sessionId,
        role: "Conductor",
        repository: binding.repository,
        connection: binding.connection,
        generation: 1,
        integration: integration.id,
        runtimeSession: binding.runtimeSession,
        depth: 0,
        status: "active",
        stage: "research",
        skills: this.approvedSkills(binding.repository),
        model: policy.policy.models.Conductor,
        policy: policy.id,
        enforcement: "unverified",
        created: this.store.clock.now(),
      };
      this.saveSession(session);
      const token = this.issue(session);
      this.store.audit(
        "session.registered",
        {
          session: sessionId,
          role: session.role,
          enforcement: session.enforcement,
        },
        session.repository,
        sessionId,
      );
      return { session, ...token };
    });
  }
  approvedSkills(repository: string): Record<string, string> {
    const loaded: Record<string, string> = {};
    for (const skill of this.store.list<{
      id: string;
      version: string;
      revoked: boolean;
      scope: string;
    }>("skill")) {
      if (
        !skill.revoked &&
        (skill.scope === repository || skill.scope === "global")
      )
        loaded[skill.scope === "global" ? `global/${skill.id}` : skill.id] =
          skill.version;
    }
    return loaded;
  }
  specialistChallenge(input: unknown) {
    const request = z
      .object({
        integration: z.string(),
        session: z.string(),
        connection: z.string(),
      })
      .strict()
      .parse(input);
    const child = this.session(request.session);
    check(
      child.parent &&
        child.role !== "Conductor" &&
        child.integration === request.integration &&
        child.connection === request.connection,
      "specialist_binding",
    );
    check(
      child.status === "active" && this.session(child.root).status === "active",
      "session_inactive",
    );
    return this.store.transaction(() => {
      check(
        !this.store.get("specialist-claimed", child.session),
        "specialist_already_claimed",
      );
      const challenge = this.challenge({
        integration: child.integration,
        repository: child.repository,
        runtimeSession: child.runtimeSession,
        connection: child.connection,
      });
      this.store.put(
        "specialist-nonce",
        challenge.nonce,
        { session: child.session },
        child.repository,
        child.session,
      );
      return challenge;
    });
  }
  claimSpecialist(input: unknown, proof: string) {
    const binding = registrationSchema.parse(input),
      integration = this.integration(binding.integration);
    check(
      equal(
        sign(integration.secret, {
          action: "specialist-registration",
          binding,
        }),
        proof,
      ),
      "registration_proof",
    );
    this.repositories.verify(binding.repository);
    return this.store.transaction(() => {
      const assignment = this.store.get<{ session: string }>(
        "specialist-nonce",
        binding.nonce,
      );
      check(assignment, "nonce_purpose");
      const child = this.session(assignment.session);
      check(
        child.parent &&
          child.status === "active" &&
          this.session(child.root).status === "active",
        "session_inactive",
      );
      check(
        child.integration === binding.integration &&
          child.repository === binding.repository &&
          child.runtimeSession === binding.runtimeSession &&
          child.connection === binding.connection,
        "specialist_binding",
      );
      check(
        child.policy === this.policies.effective(child.repository).id,
        "policy_changed",
      );
      check(
        !this.store.get("specialist-claimed", child.session),
        "specialist_already_claimed",
      );
      const consumed = this.store.db
        .prepare(
          "UPDATE nonces SET used=1,registration=? WHERE id=? AND integration=? AND repository=? AND runtime_session=? AND connection=? AND used=0 AND expires>?",
        )
        .run(
          child.session,
          binding.nonce,
          binding.integration,
          binding.repository,
          binding.runtimeSession,
          binding.connection,
          this.store.clock.now(),
        );
      check(consumed.changes === 1, "nonce_used_or_expired");
      this.store.put(
        "specialist-claimed",
        child.session,
        { nonce: binding.nonce },
        child.repository,
        child.session,
      );
      this.store.audit(
        "specialist.registered",
        { session: child.session, role: child.role },
        child.repository,
        child.session,
      );
      return { session: child, ...this.issue(child) };
    });
  }
  status(binding: Registration, time: number, proof: string) {
    const parsed = registrationSchema.parse(binding),
      integration = this.integration(parsed.integration);
    check(
      Math.abs(this.store.clock.now() - time) < 60_000 &&
        equal(
          sign(integration.secret, {
            action: "registration-status",
            binding: parsed,
            time,
          }),
          proof,
        ),
      "status_proof",
    );
    const nonce = this.store.db
      .prepare("SELECT * FROM nonces WHERE id=?")
      .get(parsed.nonce);
    check(
      nonce &&
        nonce.integration === parsed.integration &&
        nonce.repository === parsed.repository &&
        nonce.connection === parsed.connection &&
        nonce.runtime_session === parsed.runtimeSession,
      "nonce_binding",
    );
    if (!nonce.registration) return { registered: false as const };
    const session = this.session(nonce.registration as string);
    // Recover by minting a fresh capability, never exposing stored token plaintext.
    return this.store.transaction(() => {
      check(session.status === "active", "session_inactive");
      this.revokeTokens(session.session);
      return { registered: true as const, session, ...this.issue(session) };
    });
  }
  session(session: string): Session {
    const s = this.store.get<Session>("session", session);
    check(s, "session_unknown");
    return s;
  }
  saveSession(s: Session) {
    this.store.put("session", s.session, s, s.repository, s.session);
  }
  issue(session: Session) {
    const capability = secret(),
      expires = this.store.clock.now() + 300_000;
    const record: Capability = {
      id: id(),
      tokenHash: hash(capability),
      session: session.session,
      connection: session.connection,
      repository: session.repository,
      role: session.role,
      generation: session.generation,
      expires,
      revoked: false,
    };
    this.store.put(
      "capability",
      record.tokenHash,
      record,
      session.repository,
      session.session,
    );
    return { capability, expires };
  }
  authenticate(token: string, connection: string): Session {
    const c = this.store.get<Capability>("capability", hash(token));
    check(c && !c.revoked, "capability_invalid");
    if (c.expires <= this.store.clock.now()) {
      this.invalidate(c.session, "capability_expired");
      check(false, "capability_expired");
    }
    const s = this.session(c.session);
    this.integration(s.integration);
    check(
      c.connection === connection &&
        s.connection === connection &&
        c.repository === s.repository &&
        c.role === s.role &&
        c.generation === s.generation,
      "capability_scope",
    );
    check(s.status === "active", "session_inactive");
    check(
      this.policies.effective(s.repository).id === s.policy,
      "policy_changed",
    );
    check(this.revalidate(s), "enforcement_unhealthy");
    return s;
  }
  renew(token: string, connection: string) {
    try {
      return this.store.transaction(() => {
        const s = this.authenticate(token, connection);
        check(
          s.enforcement === "enforced" && this.revalidate(s),
          "enforcement_unhealthy",
        );
        const c = this.store.get<Capability>("capability", hash(token))!;
        check(
          c.expires - this.store.clock.now() <= 60_000,
          "renewal_too_early",
        );
        this.repositories.verify(s.repository);
        for (const [skill, version] of Object.entries(s.skills))
          check(
            this.store.get<{ version: string; revoked: boolean }>(
              "skill",
              skill.startsWith("global/")
                ? `global:${skill.slice(7)}`
                : `${s.repository}:${skill}`,
            )?.version === version &&
              !this.store.get<{ revoked: boolean }>(
                "skill",
                skill.startsWith("global/")
                  ? `global:${skill.slice(7)}`
                  : `${s.repository}:${skill}`,
              )?.revoked,
            "skill_revoked",
          );
        c.revoked = true;
        this.store.put("capability", c.tokenHash, c, s.repository, s.session);
        const next = this.issue(s);
        this.extend(s, next.expires);
        this.store.audit(
          "capability.renewed",
          { session: s.session, expires: next.expires },
          s.repository,
          s.session,
        );
        return next;
      });
    } catch (error) {
      const c = this.store.get<Capability>("capability", hash(token));
      if (c) {
        this.invalidate(c.session, "renewal_failed");
        this.store.audit(
          "capability.renewal_failed",
          { reason: String(error) },
          c.repository,
          c.session,
        );
      }
      throw error;
    }
  }
  revokeTokens(session: string) {
    for (const c of this.store.list<Capability>(
      "capability",
      undefined,
      session,
    )) {
      c.revoked = true;
      this.store.put("capability", c.tokenHash, c, c.repository, c.session);
    }
  }
  revoke(session: string, reason = "capability_revoked") {
    this.invalidate(session, reason);
  }
}
