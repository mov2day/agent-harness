import { z } from 'zod';
import { check, digest, id, type Session } from './core.js';
import type { Store } from './store.js';
import type { Identity } from './identity.js';
import type { Artifact, Artifacts } from './workflow.js';
import type { Operation } from './operations.js';
export interface AuthoritativeState {goals:string[];constraints:string[];decisions:string[];findings:string[];artifacts:Record<string,string>;approvals:string[];pending:string[];policy:string;skills:Record<string,string>;stage:string}
export interface ContextState {session:string;capacity:number;reserved:number;used:number;exchange?:{id:string;reserved:number};failures:number;checkpoint?:string;paused:boolean}
const checkpointSchema=z.object({state:z.object({goals:z.array(z.string()),constraints:z.array(z.string()),decisions:z.array(z.string()),findings:z.array(z.string()),artifacts:z.record(z.string()),approvals:z.array(z.string()),pending:z.array(z.string()),policy:z.string(),skills:z.record(z.string()),stage:z.string()}).strict(),segments:z.array(z.object({text:z.string().max(16000),sources:z.array(z.string()),trust:z.literal('untrusted')}).strict()).max(128)}).strict();
export type Checkpoint= z.infer<typeof checkpointSchema>&{id:string;session:string;repository:string;created:number};
export class Compaction {
 constructor(readonly store:Store,readonly identity:Identity,readonly artifacts:Artifacts){}
 configure(scope:Session,capacity:number,reserved=8192){check(Number.isInteger(capacity)&&capacity>=1024&&Number.isInteger(reserved)&&reserved>0&&reserved<capacity,'context_capacity');const value:ContextState={session:scope.session,capacity,reserved,used:0,failures:0,paused:false};this.store.put('context',scope.session,value,scope.repository,scope.session);return value;}
 context(scope:Session){const c=this.store.get<ContextState>('context',scope.session);check(c,'context_not_configured');return c;}
 authoritative(scope:Session):AuthoritativeState {
  const root=this.identity.session(scope.root),base=this.store.get<Pick<AuthoritativeState,'goals'|'constraints'|'decisions'|'findings'>>('authority',scope.root)??{goals:[],constraints:[],decisions:[],findings:[]};
  const artifacts=this.store.list<Artifact>('artifact',scope.repository).filter(a=>a.valid&&(a.session===scope.session||a.sharedWith.includes(scope.session)));
  return {...base,artifacts:Object.fromEntries(artifacts.map(a=>[a.id,a.hash])),approvals:this.store.list<{id:string;valid:boolean;session:string}>('action-approval',scope.repository).filter(a=>a.valid&&a.session===scope.root).map(a=>a.id).sort(),pending:this.store.list<Operation>('operation',scope.repository,scope.session).filter(o=>!['completed','failed','cancelled'].includes(o.status)&&o.tool!=='compact').map(o=>o.id).sort(),policy:root.policy,skills:scope.skills,stage:root.stage};
 }
 budget(scope:Session){const c=this.context(scope),ratio=c.used/(c.capacity-c.reserved);return {used:c.used,usable:c.capacity-c.reserved,reserved:c.reserved,requestCompaction:ratio>=0.7,admitOptional:ratio<0.9&&!c.paused,pause:c.paused||c.used>=c.capacity-c.reserved,incompleteExchange:!!c.exchange};}
 addOptional(scope:Session,tokens:number){check(Number.isInteger(tokens)&&tokens>=0,'context_tokens');return this.store.transaction(()=>{const c=this.context(scope);check(this.budget(scope).admitOptional&&c.used+tokens<=0.9*(c.capacity-c.reserved),'optional_context_stopped');c.used+=tokens;this.store.put('context',scope.session,c,scope.repository,scope.session);return this.budget(scope);});}
 startExchange(scope:Session,call:string,reserved:number){this.store.transaction(()=>{const c=this.context(scope);check(!c.exchange,'tool_exchange_incomplete');check(!c.paused&&reserved>0&&reserved<=c.reserved&&c.used+reserved<=c.capacity,'tool_context_unavailable');c.exchange={id:call,reserved};this.store.put('context',scope.session,c,scope.repository,scope.session);});}
 finishExchange(scope:Session,call:string,output:string){return this.store.transaction(()=>{const c=this.context(scope);check(c.exchange?.id===call,'tool_exchange_identity');const estimate=Math.ceil(Buffer.byteLength(output)/3);let result:unknown=output;
   if(estimate>c.exchange.reserved){const a=this.artifacts.create(scope,{kind:'tool-output',content:output,dependencies:[],sources:[]});result={artifact:a.id,hash:a.hash,bytes:Buffer.byteLength(output),trust:a.trust};}
   c.used+=Math.min(estimate,c.exchange.reserved);delete c.exchange;if(c.used>=c.capacity-c.reserved)c.paused=true;this.store.put('context',scope.session,c,scope.repository,scope.session);return result;
 });}
 accept(scope:Session,input:unknown):Checkpoint {
  const context=this.context(scope);check(!context.exchange,'tool_exchange_incomplete');
  try{return this.store.transaction(()=>{
    const candidate=checkpointSchema.parse(input),state=this.authoritative(scope);check(digest(candidate.state)===digest(state),'checkpoint_state_mismatch');
    const sources=new Set<string>();for(const segment of candidate.segments){for(const source of segment.sources){this.artifacts.source(scope,source);sources.add(source);}}
    const previous=context.checkpoint?this.get(scope,context.checkpoint):undefined;
    for(const source of previous?.segments.flatMap(s=>s.sources)??[])check(sources.has(source),'checkpoint_lineage_missing');
    for(const artifact of Object.keys(state.artifacts)){const a=this.artifacts.get(scope,artifact);for(const source of a.sources)check(sources.has(source),'checkpoint_lineage_missing');}
    const checkpoint:Checkpoint={...candidate,id:id(),session:scope.session,repository:scope.repository,created:this.store.clock.now()};
    const size=Math.ceil(Buffer.byteLength(JSON.stringify(checkpoint))/3);check(size<0.7*(context.capacity-context.reserved),'checkpoint_too_large');
    this.store.put('checkpoint',checkpoint.id,checkpoint,scope.repository,scope.session);context.checkpoint=checkpoint.id;context.failures=0;context.paused=false;context.used=size;this.store.put('context',scope.session,context,scope.repository,scope.session);this.store.audit('context.compacted',{checkpoint:checkpoint.id,stateHash:digest(state),lineage:[...sources]},scope.repository,scope.session);return checkpoint;
  });}catch(error){this.store.transaction(()=>{const latest=this.context(scope);latest.failures++;if(latest.failures>=2){latest.paused=true;const session=this.identity.session(scope.session);session.status='paused';this.identity.saveSession(session);}this.store.put('context',scope.session,latest,scope.repository,scope.session);this.store.audit('context.compaction_failed',{attempt:latest.failures,paused:latest.paused,error:String(error)},scope.repository,scope.session);});throw error;}
 }
 get(scope:Session,key:string){const c=this.store.get<Checkpoint>('checkpoint',key);check(c&&c.repository===scope.repository&&c.session===scope.session,'checkpoint_not_found');return c;}
}
