import { z } from "zod";
import { minimatch } from "minimatch";
import { check, digest, HarnessError, roles, type Role } from "./core.js";
import type { Store } from "./store.js";
import {
  agentReferenceIssues,
  agentSchema,
  agentStructureIssues,
  agentGrants,
  builtinAgents,
  defaultHumanReview,
  defaultOrchestration,
  externalStrength,
  humanReviewSchema,
  mandatoryIssues,
  mergeAgents,
  orchestrationSchema,
  policyTools,
} from "./agents.js";
const pattern = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.split("/").includes("..") &&
      !p.includes("\\") &&
      !p.includes("\0") &&
      !p.startsWith("!"),
    "Expected a relative path pattern",
  );
const resource = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/);
export const policySchema = z
  .object({
    version: z.literal(1),
    allowPaths: z.array(pattern),
    denyPaths: z.array(pattern),
    tools: z.array(z.enum(policyTools)),
    commands: z.array(
      z
        .object({
          executable: z.string().startsWith("/"),
          args: z.array(z.string()),
          env: z.record(z.string()),
          cwd: pattern,
        })
        .strict(),
    ),
    domains: z.array(z.string().regex(/^[a-z0-9.-]+$/)),
    deletion: z.boolean(),
    maxSpecialists: z.number().int().min(0).max(32),
    maxDepth: z.number().int().min(0).max(8),
    revisionLimit: z.number().int().min(0).max(10),
    timeoutMs: z.number().int().min(10).max(3_600_000),
    humanGates: z.array(
      z.enum([
        "research",
        "plan",
        "implementation",
        "execution",
        "verification",
      ]),
    ),
    models: z.record(
      z.enum(roles),
      z.object({ model: z.string(), reasoning: z.string() }).strict(),
    ),
    /** Agent definitions. Global is the catalogue; a repository overrides by id. */
    agents: z.array(agentSchema),
    allowedSkills: z.array(resource),
    deniedSkills: z.array(resource),
    allowedMcps: z.array(resource),
    deniedMcps: z.array(resource),
    orchestration: orchestrationSchema,
    humanReview: humanReviewSchema,
    /** Never allowed in any repository, whatever a repository asks for. */
    forbiddenTools: z.array(z.enum(policyTools)),
    forbiddenDomains: z.array(z.string().regex(/^[a-z0-9.-]+$/)),
  })
  .strict()
  .superRefine((p, ctx) => {
    for (const issue of agentStructureIssues(p.agents))
      ctx.addIssue({ code: "custom", ...issue });
  });
export type Policy = z.infer<typeof policySchema>;
export const modelCapabilitiesSchema = z.record(
  z.enum(roles),
  z.record(z.array(z.string().min(1)).min(1)),
);
export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;
export interface PolicyRecord {
  id: string;
  policy: Policy;
  activated: boolean;
  created: number;
}
export interface Effective {
  repositoryId: string;
  id: string;
  global: PolicyRecord;
  repository?: PolicyRecord;
  policy: Policy;
  rules: string[];
}
export const defaultPolicy: Policy = {
  version: 1,
  allowPaths: ["**"],
  denyPaths: [".git/**", ".env", ".env.*", "**/secrets/**"],
  tools: ["read", "artifact", "delegate", "review", "compact", "model"],
  commands: [],
  domains: [],
  deletion: false,
  maxSpecialists: 4,
  maxDepth: 2,
  revisionLimit: 1,
  timeoutMs: 60_000,
  humanGates: ["implementation"],
  models: {},
  agents: builtinAgents,
  allowedSkills: [],
  deniedSkills: [],
  allowedMcps: [],
  deniedMcps: [],
  orchestration: defaultOrchestration,
  humanReview: defaultHumanReview,
  forbiddenTools: [],
  forbiddenDomains: [],
};
const ceilings = [
  "maxSpecialists",
  "maxDepth",
  "revisionLimit",
  "timeoutMs",
] as const;
export class Policies {
  private modelCapabilities: (scope: string) => ModelCapabilities = () => ({});
  constructor(
    readonly store: Store,
    private onChange: (repository?: string) => void = () => {},
  ) {}
  setInvalidator(fn: (repository?: string) => void) {
    this.onChange = fn;
  }
  setModelCapabilities(fn: (scope: string) => ModelCapabilities) {
    this.modelCapabilities = fn;
  }
  /** Every publication check, without writing anything. */
  validate(scope: string, candidate: unknown): Policy {
    const parsed = policySchema.safeParse(candidate);
    if (!parsed.success)
      throw new HarnessError(
        "invalid_policy",
        "Policy validation failed",
        400,
        parsed.error.flatten(),
      );
    const p = parsed.data;
    this.validateModels(p, this.modelCapabilities(scope));
    if (scope !== "global") this.assertLimits(this.active("global").policy, p);
    this.validateAgents(scope, p);
    if (scope === "global") {
      const both = [
        ...p.tools.filter((t) => p.forbiddenTools.includes(t)),
        ...p.domains.filter((d) => p.forbiddenDomains.includes(d)),
      ];
      if (both.length)
        throw new HarnessError(
          "invalid_forbidden",
          "A tool or domain cannot be both allowed and forbidden",
          400,
          { forbidden: `Allowed and forbidden: ${both.join(", ")}` },
        );
    }
    for (const d of p.humanReview.trustedDomains)
      if (!p.domains.includes(d))
        throw new HarnessError(
          "invalid_human_review",
          "Trusted domains must also be allowed research domains",
          400,
          { "humanReview.trustedDomains": `${d} is not an allowed domain` },
        );
    return p;
  }
  /** Repositories whose policy would exceed `global` once it is active. */
  affectedRepositories(global: Policy) {
    return this.store
      .list<{ id: string; path: string }>("repository")
      .flatMap((r) => {
        if (!this.store.get("policy-required", r.id)) return [];
        try {
          const fields = this.hardErrors(global, this.active(r.id).policy);
          return Object.keys(fields).length
            ? [{ id: r.id, path: r.path, fields }]
            : [];
        } catch {
          return [];
        }
      });
  }
  /** `repair` also tightens the repositories a stricter global policy would
   * otherwise leave blocked, in the same step. Without it, such a publish is
   * refused and the affected repositories and fields are listed. */
  publish(
    scope: string,
    candidate: unknown,
    activate: boolean,
    options: { repair?: boolean; acknowledgeGrants?: boolean } = {},
  ): PolicyRecord {
    const p = this.validate(scope, candidate);
    const affected =
      scope === "global" && activate ? this.affectedRepositories(p) : [];
    if (affected.length && !options.repair)
      throw new HarnessError(
        "global_breaks_repositories",
        `This change would block ${affected.length} repositor${affected.length === 1 ? "y" : "ies"} whose policy breaks a new global limit (a denial or prohibition). Publish with "also fix these repositories" to remove what breaks it.`,
        400,
        { repositories: affected },
      );
    // Granting one repository more than the defaults is deliberate: the owner
    // confirms each new grant once, and no other repository is affected.
    const grants =
      scope !== "global" && activate
        ? this.grantsBeyond(this.active("global").policy, p)
        : {};
    const fresh = Object.entries(grants).filter(
      ([key]) =>
        !(
          this.store.get<{ fields: string[] }>("policy-grants", scope)
            ?.fields ?? []
        ).includes(key),
    );
    if (fresh.length && !options.acknowledgeGrants)
      throw new HarnessError(
        "grants_need_confirmation",
        `Needs your confirmation: this gives this repository more than the global defaults (${fresh.map(([, why]) => why).join("; ")}). Other repositories are not affected.`,
        400,
        { grants: Object.fromEntries(fresh) },
      );
    return this.store.transaction(() => {
      const record = {
        id: digest(p),
        policy: p,
        activated: activate,
        created: this.store.clock.now(),
      };
      this.store.put(
        "policy",
        `${scope}:${record.id}`,
        record,
        scope === "global" ? "" : scope,
      );
      if (activate) {
        this.store.put("policy-active", scope, { id: record.id });
        this.store.put("policy-required", scope, { required: true });
        if (scope !== "global") {
          this.store.put("policy-grants", scope, {
            fields: Object.keys(grants),
          });
          if (fresh.length)
            this.store.audit(
              "policy.granted",
              { repository: scope, grants: Object.fromEntries(fresh) },
              scope,
            );
        }
        this.onChange(scope === "global" ? undefined : scope);
      }
      this.store.audit(
        "policy.published",
        { scope, id: record.id, activate },
        scope === "global" ? "" : scope,
      );
      // Repositories the new global policy would leave blocked are tightened
      // in the same step, each recorded in the audit trail.
      for (const r of affected) this.repair(r.id);
      return record;
    });
  }
  /** Limits no repository can pass, however explicitly it asks. */
  private assertLimits(g: Policy, p: Policy) {
    const errors = this.hardErrors(g, p);
    if (Object.keys(errors).length)
      throw new HarnessError(
        "policy_escalation",
        "Repository policy breaks a global limit",
        400,
        errors,
      );
  }
  /** The few things the global policy holds for every repository: what is
   * denied or forbidden everywhere, and where files may be touched at all.
   * Everything else a repository may be granted beyond the defaults. */
  hardErrors(g: Policy, p: Policy) {
    const errors: Record<string, string> = {};
    for (const [field, denied] of [
      ["Skills", g.deniedSkills],
      ["Mcps", g.deniedMcps],
    ] as const) {
      const allow = p[`allowed${field}`],
        deny = p[`denied${field}`];
      if (denied.some((x) => !deny.includes(x)))
        errors[`denied${field}`] = "Cannot drop a global denial";
      if (allow.some((x) => denied.includes(x)))
        errors[`allowed${field}`] = "Cannot allow a globally denied entry";
    }
    const tools = p.tools.filter((t) => g.forbiddenTools.includes(t)),
      domains = p.domains.filter((d) => g.forbiddenDomains.includes(d));
    if (tools.length)
      errors.tools = `Forbidden in every repository: ${tools.join(", ")}`;
    if (domains.length)
      errors.domains = `Forbidden in every repository: ${domains.join(", ")}`;
    if (g.forbiddenTools.some((x) => !p.forbiddenTools.includes(x)))
      errors.forbiddenTools = "Cannot drop a global prohibition";
    if (g.forbiddenDomains.some((x) => !p.forbiddenDomains.includes(x)))
      errors.forbiddenDomains = "Cannot drop a global prohibition";
    // Arbitrary glob inclusion is undecidable here; resource-time intersection is authoritative.
    // Require identical or concrete subpaths of an existing global pattern for publication.
    if (
      p.allowPaths.some(
        (x) =>
          !g.allowPaths.includes(x) &&
          (/[*!?{[\]]/.test(x) || !g.allowPaths.some((gp) => matches(x, gp))),
      )
    )
      errors.allowPaths = "Use a global pattern or a permitted concrete path";
    return errors;
  }
  /** What a repository policy gives it beyond the global defaults, one entry
   * per permission. Not a violation: the owner grants these to one repository
   * on purpose, confirms them once, and no other repository is affected. */
  grantsBeyond(g: Policy, p: Policy) {
    const grants: Record<string, string> = {};
    for (const f of ceilings)
      if (p[f] > g[f]) grants[f] = `${f} ${g[f]} → ${p[f]}`;
    if (p.deletion && !g.deletion) grants.deletion = "Reviewed deletion";
    for (const tool of p.tools)
      if (!g.tools.includes(tool)) grants[`tools.${tool}`] = `The ${tool} tool`;
    for (const domain of p.domains)
      if (!g.domains.includes(domain))
        grants[`domains.${domain}`] = `Fetching from ${domain}`;
    for (const c of p.commands)
      if (!g.commands.some((gc) => digest(gc) === digest(c)))
        grants[`commands.${digest(c).slice(0, 8)}`] =
          `Running ${c.executable} ${c.args.join(" ")}`.trim();
    for (const stage of g.humanGates)
      if (!p.humanGates.includes(stage))
        grants[`humanGates.${stage}`] = `No approval after ${stage}`;
    for (const key of ["verifyStages", "reviewStages"] as const)
      for (const stage of g.orchestration[key])
        if (!p.orchestration[key].includes(stage))
          grants[`orchestration.${key}.${stage}`] =
            `No ${key === "verifyStages" ? "Verifier check" : "Reviewer review"} after ${stage}`;
    for (const stage of g.humanReview.beforeStages)
      if (!p.humanReview.beforeStages.includes(stage))
        grants[`humanReview.beforeStages.${stage}`] =
          `No approval before ${stage} starts`;
    if (
      externalStrength(p.humanReview.externalContent) <
      externalStrength(g.humanReview.externalContent)
    )
      grants["humanReview.externalContent"] =
        `External content review ${g.humanReview.externalContent} → ${p.humanReview.externalContent}`;
    for (const d of p.humanReview.trustedDomains)
      if (!g.humanReview.trustedDomains.includes(d))
        grants[`humanReview.trustedDomains.${d}`] = `Skip review for ${d}`;
    agentGrants(g.agents, p.agents, grants);
    return grants;
  }
  /** What the repository policy would newly grant, for the owner to confirm. */
  grantPreview(repository: string, candidate: unknown) {
    const p = this.validate(repository, candidate),
      all = this.grantsBeyond(this.active("global").policy, p),
      acked =
        this.store.get<{ fields: string[] }>("policy-grants", repository)
          ?.fields ?? [];
    return {
      grants: all,
      fresh: Object.fromEntries(
        Object.entries(all).filter(([key]) => !acked.includes(key)),
      ),
    };
  }
  /** The grants an active repository policy holds. */
  grantsFor(repository: string) {
    try {
      if (!this.store.get("policy-required", repository)) return {};
      return this.grantsBeyond(
        this.active("global").policy,
        this.active(repository).policy,
      );
    } catch {
      return {};
    }
  }
  /** The repository policy with only the hard-limit excess removed. */
  clamp(g: Policy, p: Policy): Policy {
    const out: Policy = JSON.parse(JSON.stringify(p));
    const union = <T>(a: T[], b: T[]) => [...new Set([...a, ...b])];
    out.forbiddenTools = union(p.forbiddenTools, g.forbiddenTools);
    out.forbiddenDomains = union(p.forbiddenDomains, g.forbiddenDomains);
    out.tools = p.tools.filter((t) => !out.forbiddenTools.includes(t));
    out.domains = p.domains.filter((d) => !out.forbiddenDomains.includes(d));
    out.deniedSkills = union(p.deniedSkills, g.deniedSkills);
    out.deniedMcps = union(p.deniedMcps, g.deniedMcps);
    out.allowedSkills = p.allowedSkills.filter(
      (x) => !out.deniedSkills.includes(x),
    );
    out.allowedMcps = p.allowedMcps.filter((x) => !out.deniedMcps.includes(x));
    out.allowPaths = p.allowPaths.filter(
      (x) =>
        g.allowPaths.includes(x) ||
        (!/[*!?{[\]]/.test(x) && g.allowPaths.some((gp) => matches(x, gp))),
    );
    out.humanReview = {
      ...p.humanReview,
      trustedDomains: p.humanReview.trustedDomains.filter((d) =>
        out.domains.includes(d),
      ),
    };
    return out;
  }
  /** What a repository's active policy breaks in the global limits, if anything. */
  violations(repository: string): Record<string, string> | undefined {
    try {
      if (!this.store.get("policy-required", repository)) return undefined;
      const errors = this.hardErrors(
        this.active("global").policy,
        this.active(repository).policy,
      );
      return Object.keys(errors).length ? errors : undefined;
    } catch {
      return undefined;
    }
  }
  /** Owner action: publish the repository's policy with whatever now breaks a
   * global limit removed. Recorded with the fields it changed. */
  repair(repository: string): PolicyRecord {
    const fields = this.violations(repository);
    check(fields, "policy_not_broken", "Nothing to repair", 400);
    const record = this.publish(
      repository,
      this.clamp(this.active("global").policy, this.active(repository).policy),
      true,
      { acknowledgeGrants: true },
    );
    this.store.audit(
      "policy.repaired",
      { repository, to: record.id, fields: Object.keys(fields) },
      repository,
    );
    return record;
  }
  /** Policies published before agents existed lack the agent fields and would
   * leave the engine blocked after an upgrade. Fill them with the restrictive
   * defaults (built-in agents bounded by role and the policy's own tools, no
   * skills or MCP servers) and activate the result. Policies that are invalid
   * for any other reason keep failing closed. Global is upgraded first. */
  migrateLegacy(): string[] {
    const migrated: string[] = [];
    const repositories = this.store
      .list<{ id: string }>("repository")
      .map((r) => r.id);
    for (const scope of ["global", ...repositories]) {
      const pointer = this.store.get<{ id: string }>("policy-active", scope);
      const record =
        pointer &&
        this.store.get<PolicyRecord>("policy", `${scope}:${pointer.id}`);
      if (!record || policySchema.safeParse(record.policy).success) continue;
      const upgraded = {
        agents: scope === "global" ? builtinAgents : [],
        allowedSkills: [],
        deniedSkills: [],
        allowedMcps: [],
        deniedMcps: [],
        orchestration: defaultOrchestration,
        humanReview: defaultHumanReview,
        forbiddenTools: [],
        forbiddenDomains: [],
        ...(record.policy as Record<string, unknown>),
      };
      const parsed = policySchema.safeParse(upgraded);
      if (!parsed.success) continue;
      this.store.transaction(() => {
        const next = {
          id: digest(parsed.data),
          policy: parsed.data,
          activated: true,
          created: this.store.clock.now(),
        };
        this.store.put(
          "policy",
          `${scope}:${next.id}`,
          next,
          scope === "global" ? "" : scope,
        );
        this.store.put("policy-active", scope, { id: next.id });
        this.store.audit(
          "policy.migrated",
          { scope, from: record.id, to: next.id },
          scope === "global" ? "" : scope,
        );
      });
      migrated.push(scope);
    }
    return migrated;
  }
  /** Mandatory agents and skill/MCP references are checked on the policy as it
   * will be effective: a repository policy is merged over the global agents. */
  private validateAgents(scope: string, p: Policy) {
    const agents =
      scope === "global"
        ? p.agents
        : mergeAgents(this.active("global").policy.agents, p.agents);
    const errors = {
      ...mandatoryIssues(agents),
      ...agentReferenceIssues(scope === "global" ? agents : p.agents, p),
    };
    if (Object.keys(errors).length)
      throw new HarnessError(
        "invalid_agents",
        "Agent configuration is invalid",
        400,
        errors,
      );
  }
  active(scope: string): PolicyRecord {
    const pointer = this.store.get<{ id: string }>("policy-active", scope);
    check(pointer, "policy_unavailable", `Active ${scope} policy missing`);
    const record = this.store.get<PolicyRecord>(
      "policy",
      `${scope}:${pointer.id}`,
    );
    check(
      record &&
        policySchema.safeParse(record.policy).success &&
        digest(record.policy) === record.id,
      "policy_unavailable",
      "Active policy is invalid",
    );
    return record;
  }
  effective(repository: string): Effective {
    const global = this.active("global");
    const required = this.store.get("policy-required", repository);
    const local = required ? this.active(repository) : undefined;
    if (local) this.assertLimits(global.policy, local.policy);
    const policy = local
      ? {
          ...local.policy,
          agents: mergeAgents(global.policy.agents, local.policy.agents),
        }
      : global.policy;
    return {
      repositoryId: repository,
      id: digest([global.id, local?.id ?? null]),
      global,
      repository: local,
      policy,
      rules: [
        `global:${global.id}`,
        ...(local ? [`repository:${local.id}`] : []),
      ],
    };
  }
  path(e: Effective, path: string): boolean {
    check(
      path &&
        !path.startsWith("/") &&
        !path.includes("\\") &&
        !path.includes("\0") &&
        path.split("/").every((x) => x !== "." && x !== ".." && x !== ""),
      "invalid_path",
    );
    const nocase =
      this.store.get<{ caseSensitive: boolean }>("repository", e.repositoryId)
        ?.caseSensitive === false;
    return [e.global, ...(e.repository ? [e.repository] : [])].every(
      (r) =>
        r.policy.allowPaths.some((p) => matches(path, p, nocase)) &&
        !r.policy.denyPaths.some((p) => matches(path, p, nocase)),
    );
  }
  validateModels(p: Policy, capabilities: ModelCapabilities) {
    const errors: Record<string, string> = {};
    for (const [role, setting] of Object.entries(p.models))
      if (
        !capabilities[role as Role]?.[setting.model]?.includes(
          setting.reasoning,
        )
      )
        errors[`models.${role}`] =
          `Unsupported model/reasoning: ${setting.model} / ${setting.reasoning}`;
    if (Object.keys(errors).length)
      throw new HarnessError(
        "unsupported_model",
        "Unsupported model/reasoning settings",
        400,
        errors,
      );
  }
}
export const matches = (path: string, glob: string, nocase = false) =>
  minimatch(path, glob, {
    dot: true,
    nocase,
    nonegate: true,
    nocomment: true,
  }) ||
  (glob.endsWith("/**") &&
    minimatch(path, glob.slice(0, -3), {
      dot: true,
      nocase,
      nonegate: true,
      nocomment: true,
    }));
