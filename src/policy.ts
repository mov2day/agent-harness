import { z } from 'zod';
import { minimatch } from 'minimatch';
import { check, digest, HarnessError, roles, type Role } from './core.js';
import type { Store } from './store.js';
const pattern = z.string().min(1).max(512).refine(p => !p.startsWith('/') && !p.split('/').includes('..') && !p.includes('\\') && !p.includes('\0') && !p.startsWith('!'), 'Expected a relative path pattern');
export const policySchema = z.object({
  version: z.literal(1),
  allowPaths: z.array(pattern), denyPaths: z.array(pattern),
  tools: z.array(z.enum(['read','change','delete','rename','research','execute','delegate','artifact','review','compact','learn'])),
  commands: z.array(z.object({executable:z.string().startsWith('/'), args:z.array(z.string()), env:z.record(z.string()), cwd:pattern}).strict()),
  domains:z.array(z.string().regex(/^[a-z0-9.-]+$/)),
  deletion:z.boolean(), maxSpecialists:z.number().int().min(0).max(32), maxDepth:z.number().int().min(0).max(8),
  revisionLimit:z.number().int().min(0).max(10), timeoutMs:z.number().int().min(10).max(3_600_000),
  humanGates:z.array(z.enum(['research','plan','implementation','execution','verification'])),
  models:z.record(z.enum(roles),z.object({model:z.string(),reasoning:z.string()}).strict())
}).strict();
export type Policy = z.infer<typeof policySchema>;
export interface PolicyRecord { id:string; policy:Policy; activated:boolean; created:number }
export interface Effective { id:string; global:PolicyRecord; repository?:PolicyRecord; policy:Policy; rules:string[] }
export const defaultPolicy: Policy = {version:1,allowPaths:['**'],denyPaths:['.git/**','.env','.env.*','**/secrets/**'],tools:['read','artifact','delegate','review','compact'],commands:[],domains:[],deletion:false,maxSpecialists:4,maxDepth:2,revisionLimit:1,timeoutMs:60_000,humanGates:['implementation'],models:{}};
const ceilings = ['maxSpecialists','maxDepth','revisionLimit','timeoutMs'] as const;
export class Policies {
  constructor(readonly store:Store, private onChange:(repository?:string)=>void = () => {}) {}
  setInvalidator(fn:(repository?:string)=>void) { this.onChange=fn; }
  publish(scope:string, candidate:unknown, activate:boolean):PolicyRecord {
    const parsed = policySchema.safeParse(candidate);
    if (!parsed.success) throw new HarnessError('invalid_policy','Policy validation failed',400,parsed.error.flatten());
    const p = parsed.data;
    if (scope !== 'global') this.assertTightening(this.active('global').policy,p);
    return this.store.transaction(() => {
      const record = {id:digest(p),policy:p,activated:activate,created:this.store.clock.now()};
      this.store.put('policy',`${scope}:${record.id}`,record,scope === 'global' ? '' : scope);
      if (activate) {
        this.store.put('policy-active',scope,{id:record.id});
        this.store.put('policy-required',scope,{required:true});
        this.onChange(scope === 'global' ? undefined : scope);
      }
      this.store.audit('policy.published',{scope,id:record.id,activate},scope === 'global' ? '' : scope);
      return record;
    });
  }
  private assertTightening(g:Policy,p:Policy) {
    const errors:Record<string,string> = {};
    for (const f of ceilings) if (p[f] > g[f]) errors[f] = 'Cannot raise the global ceiling';
    if(p.deletion && !g.deletion) errors.deletion='Globally forbidden';
    for(const field of ['tools','domains'] as const) if(p[field].some(x => !(g[field] as string[]).includes(x))) errors[field]='Cannot enable globally forbidden resources';
    if(p.commands.some(c => !g.commands.some(gc => digest(gc)===digest(c)))) errors.commands='Command must be globally approved with identical constraints';
    if(g.humanGates.some(s=>!p.humanGates.includes(s))) errors.humanGates='Cannot remove a global human gate';
    // Arbitrary glob inclusion is undecidable here; resource-time intersection is authoritative.
    // Require identical or concrete subpaths of an existing global pattern for publication.
    if(p.allowPaths.some(x=>!g.allowPaths.includes(x) && (/[*!?{[\]]/.test(x) || !g.allowPaths.some(gp=>matches(x,gp))))) errors.allowPaths='Use a global pattern or a permitted concrete path';
    if(Object.keys(errors).length) throw new HarnessError('policy_escalation','Repository policy exceeds global authority',400,errors);
  }
  active(scope:string):PolicyRecord {
    const pointer=this.store.get<{id:string}>('policy-active',scope);
    check(pointer,'policy_unavailable',`Active ${scope} policy missing`);
    const record=this.store.get<PolicyRecord>('policy',`${scope}:${pointer.id}`);
    check(record && policySchema.safeParse(record.policy).success && digest(record.policy)===record.id,'policy_unavailable','Active policy is invalid');
    return record;
  }
  effective(repository:string):Effective {
    const global=this.active('global');
    const required=this.store.get('policy-required',repository);
    const local=required ? this.active(repository) : undefined;
    if(local) this.assertTightening(global.policy,local.policy);
    const policy=local?.policy ?? global.policy;
    return {id:digest([global.id,local?.id ?? null]),global,repository:local,policy,rules:[`global:${global.id}`,...(local?[`repository:${local.id}`]:[])]};
  }
  path(e:Effective,path:string):boolean {
    check(path && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0') && path.split('/').every(x=>x!=='.'&&x!=='..'&&x!==''),'invalid_path');
    return [e.global,...(e.repository?[e.repository]:[])].every(r => r.policy.allowPaths.some(p=>matches(path,p)) && !r.policy.denyPaths.some(p=>matches(path,p)));
  }
  validateModels(p:Policy, capabilities:Partial<Record<Role,Record<string,string[]>>>) {
    for(const [role,setting] of Object.entries(p.models)) check(capabilities[role as Role]?.[setting.model]?.includes(setting.reasoning),'unsupported_model',`Unsupported model/reasoning for ${role}`);
  }
}
export const matches = (path:string,glob:string) => minimatch(path,glob,{dot:true,nocase:false,nonegate:true,nocomment:true}) || (glob.endsWith('/**') && path===glob.slice(0,-3));
