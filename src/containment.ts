import { execFileSync } from 'node:child_process';
import { check, digest, type Session } from './core.js';
import type { Store } from './store.js';
export const runtimeScenarios=['identity','interception','overrides','plugins','aliases','delegation','network','filesystem','host-control','lifecycle','compaction'] as const;
export interface RuntimeCertificate {
  id:string; runtime:'opencode'|'codex'; version:string; platform:'linux'|'darwin'; image:string;
  sourceHash:string; author:string; reviewer:string; scenarios:Record<typeof runtimeScenarios[number],{passed:boolean;evidence:string}>;
  approved:boolean; expires:number;
}
export interface ContainerInspection {
  Id:string; Image:string; State:{Running:boolean};
  Config:{User:string; Env:string[]; Labels:Record<string,string>};
  HostConfig:{NetworkMode:string;Privileged:boolean;ReadonlyRootfs:boolean;CapDrop:string[];CapAdd:string[]|null;SecurityOpt:string[];PidMode:string;IpcMode:string;Devices:unknown[]|null;DeviceRequests:unknown[]|null;Binds:string[]|null;VolumesFrom:string[]|null;PidsLimit:number;Memory:number;PortBindings:Record<string,unknown>|null};
  Mounts:unknown[];
}
export function validateContainer(c:ContainerInspection,expected:{container:string;image:string;session:string;connection:string}) {
  check(c.Id===expected.container&&c.Image===expected.image&&c.State.Running,'container_identity');
  const h=c.HostConfig;
  check(h.NetworkMode==='none'&&!h.Privileged&&h.ReadonlyRootfs,'container_isolation');
  check(h.CapDrop?.includes('ALL')&&!h.CapAdd?.length&&h.SecurityOpt?.includes('no-new-privileges'),'container_privilege');
  check(!['host','container'].some(x=>h.PidMode.startsWith(x)||h.IpcMode.startsWith(x)),'container_namespace');
  check(!h.Devices?.length&&!h.DeviceRequests?.length&&!h.Binds?.length&&!h.VolumesFrom?.length&&!c.Mounts.length&&!Object.keys(h.PortBindings??{}).length,'container_host_access');
  check(h.PidsLimit>0&&h.PidsLimit<=256&&h.Memory>0&&h.Memory<=4*1024**3,'container_limits');
  check(/^\d+:\d+$/.test(c.Config.User)&&!c.Config.User.startsWith('0:'),'container_user');
  check(c.Config.Labels['agent-harness.session']===expected.session&&c.Config.Labels['agent-harness.connection']===expected.connection,'container_binding');
  check(!c.Config.Env.some(e=>/^(DOCKER_HOST|CONTAINER_HOST|HARNESS_.*(?:TOKEN|CREDENTIAL|SECRET)|AWS_|SSH_AUTH_SOCK|OPENAI_API_KEY|ANTHROPIC_API_KEY)/.test(e)),'container_credentials');
}
export const inspectContainer=(container:string):ContainerInspection=>{
  check(/^[a-f0-9]{64}$/.test(container),'container_id');
  const results=JSON.parse(execFileSync('docker',['inspect','--type','container',container],{encoding:'utf8',timeout:5000,maxBuffer:1024*1024}));
  check(Array.isArray(results)&&results.length===1,'container_inspection');return results[0];
};
export interface RuntimeBinding { session:string; connection:string; container:string; certificate:string; image:string; checked:number; healthy:boolean }
export class Containment {
  constructor(readonly store:Store,private sourceHash:string,private inspect=inspectContainer) {}
  certificate(c:RuntimeCertificate) {
    check(c.approved&&c.author!==c.reviewer&&c.reviewer.length>0,'independent_runtime_review');
    check(c.sourceHash===this.sourceHash&&c.expires>this.store.clock.now()&&/^sha256:[a-f0-9]{64}$/.test(c.image),'stale_runtime_certificate');
    for(const scenario of runtimeScenarios) check(c.scenarios[scenario]?.passed&&/^[a-f0-9]{64}$/.test(c.scenarios[scenario].evidence),'runtime_evidence',`Missing ${scenario} evidence`);
    check(c.id===digest({...c,id:undefined}),'certificate_hash');
    return c;
  }
  // Only the authenticated owner control plane installs certificates. Runtime callers cannot self-attest.
  install(c:RuntimeCertificate) {this.certificate(c);this.store.transaction(()=>{this.store.put('runtime-certificate',c.id,c);this.store.audit('runtime.certificate_installed',{id:c.id,reviewer:c.reviewer});});}
  attach(session:Session,container:string,certificate:string) {
    const c=this.store.get<RuntimeCertificate>('runtime-certificate',certificate);check(c,'runtime_uncertified');this.certificate(c);
    check(c.platform===process.platform,'runtime_platform');
    const integration=this.store.get<{runtime:string}>('integration',session.integration);check(integration?.runtime===c.runtime,'runtime_identity');
    validateContainer(this.inspect(container),{container,image:c.image,session:session.runtimeSession,connection:session.connection});
    const binding:RuntimeBinding={session:session.session,connection:session.connection,container,certificate,image:c.image,checked:this.store.clock.now(),healthy:true};
    this.store.transaction(()=>{this.store.put('runtime-binding',session.session,binding,session.repository,session.session);session.enforcement='enforced';this.store.put('session',session.session,session,session.repository,session.session);this.store.audit('runtime.attached',{container,certificate},session.repository,session.session);});return binding;
  }
  healthy(session:Session):boolean {
    if(session.enforcement!=='enforced')return false;
    const b=this.store.get<RuntimeBinding>('runtime-binding',session.session);if(!b||!b.healthy||b.connection!==session.connection)return false;
    try {
      const c=this.store.get<RuntimeCertificate>('runtime-certificate',b.certificate);check(c,'runtime_uncertified');this.certificate(c);
      validateContainer(this.inspect(b.container),{container:b.container,image:b.image,session:session.runtimeSession,connection:session.connection});return true;
    } catch(error) {b.healthy=false;this.store.put('runtime-binding',session.session,b,session.repository,session.session);this.store.audit('runtime.health_failed',{reason:String(error)},session.repository,session.session);return false;}
  }
}
