import { z } from "zod";
import { check, digest, type Session } from "./core.js";
import type { Store } from "./store.js";

const materialSchema = z
  .object({
    format: z.literal(1),
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
    version: z.string().regex(/^[a-f0-9]{64}$/),
    content: z.string().min(1).max(100_000),
    revoked: z.boolean(),
    kind: z.enum(["skill", "instruction", "knowledge"]),
    scope: z.union([z.literal("global"), z.string().regex(/^[a-f0-9]{64}$/)]),
  })
  .strict();
export type ApprovedMaterial = z.infer<typeof materialSchema>;
export function materialVersion(
  material: Pick<ApprovedMaterial, "id" | "kind" | "scope" | "content">,
) {
  return digest([material.id, material.kind, material.scope, material.content]);
}
export function validateMaterial(input: unknown): ApprovedMaterial {
  const parsed = materialSchema.safeParse(input);
  check(parsed.success, "approved_material_invalid");
  check(
    parsed.data.version === materialVersion(parsed.data),
    "approved_material_integrity",
  );
  return parsed.data;
}
export function approvedVersions(store: Store, repository: string) {
  const bindings: Record<string, string> = Object.create(null);
  for (const raw of store.list<ApprovedMaterial>("skill")) {
    if (
      raw.revoked === true ||
      (raw.scope !== repository && raw.scope !== "global")
    )
      continue;
    const material = validateMaterial(raw);
    const name =
      material.scope === "global" ? `global/${material.id}` : material.id;
    check(!Object.hasOwn(bindings, name), "approved_material_duplicate");
    check(
      digest(store.get("skill", `${material.scope}:${material.id}`)) ===
        digest(material),
      "approved_material_scope",
    );
    bindings[name] = material.version;
  }
  return { ...bindings };
}
/** Only the exact publication captured at registration may reach a model.
 * No private candidate/source metadata is added to global publications. */
export function loadedMaterials(store: Store, session: Session) {
  return Object.entries(session.skills)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, version]) => {
      const global = name.startsWith("global/"),
        id = global ? name.slice(7) : name;
      const scope = global ? "global" : session.repository;
      const material = validateMaterial(store.get("skill", `${scope}:${id}`));
      check(
        material.id === id && material.scope === scope,
        "approved_material_scope",
      );
      check(!material.revoked && material.version === version, "skill_revoked");
      return {
        name,
        version,
        kind: material.kind,
        content: material.content,
        scope: global ? "global" : "repository",
      };
    });
}
