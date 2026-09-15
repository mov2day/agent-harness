import { check, digest, id, type Session } from './core.js';
import type { Store } from './store.js';
import type { Artifacts } from './workflow.js';
import type { Operations } from './operations.js';
export interface Suite {id:string;version:string;cases:Array<{id:string;kind:'control'|'quality';split:'fixture'|'heldout';modelDependent:boolean}>}
export interface Score {passed:boolean;score:number}
export interface Evaluation {id:string;candidate:string;suite:string;baselineVersion:string;baseline:Record<string,Score[]>;proposed:Record<string,Score[]>;eligible:boolean;reasons:string[]}
export interface Candidate {id:string;repository:string;session:string;kind:'skill'|'instruction'|'knowledge';target:string;baseVersion:string;before:string;after:string;diff:{before:string;after:string};sources:string[];trust:'untrusted';private:boolean;status:'candidate'|'rejected'|'eligible'|'promoted'|'revoked';evaluation?:string;version:string}
export interface Skill {id:string;version:string;content:string;revoked:boolean;kind:Candidate['kind'];scope:string}
export class Learning {
 constructor(readonly store:Store,readonly artifacts:Artifacts,readonly operations:Operations){}
 propose(scope:Session,input:{kind:Candidate['kind'];target:string;baseVersion:string;before:string;after:string;sources:string[]}):Candidate {
  check(['skill','instruction','knowledge'].includes(input.kind),'learning_target');check(/^[a-z][a-z0-9_-]{0,79}$/.test(input.target),'learning_target');check(input.sources.length>0,'learning_provenance');
  for(const source of input.sources)this.artifacts.source(scope,source);
  const current=this.store.get<Skill>('skill',`${scope.repository}:${input.target}`);check((current?.version??'initial')===input.baseVersion&&(current?.content??'')===input.before,'learning_baseline');check(input.before!==input.after&&input.after.length>0&&input.after.length<=100_000,'learning_diff');
  const candidate:Candidate={...input,id:id(),repository:scope.repository,session:scope.session,diff:{before:input.before,after:input.after},trust:'untrusted',private:true,status:'candidate',version:digest([input.kind,input.target,input.after])};
  this.store.transaction(()=>{this.store.put('candidate',candidate.id,candidate,scope.repository,scope.session);this.store.audit('learning.proposed',{id:candidate.id,version:candidate.version,base:candidate.baseVersion},scope.repository,scope.session);});return candidate;
 }
 installSuite(suite:Suite){check(suite.id===digest({version:suite.version,cases:suite.cases}),'suite_hash');check(suite.cases.some(c=>c.split==='fixture')&&suite.cases.some(c=>c.split==='heldout')&&suite.cases.some(c=>c.kind==='control')&&suite.cases.some(c=>c.kind==='quality'),'suite_coverage');check(new Set(suite.cases.map(c=>c.id)).size===suite.cases.length,'suite_duplicate_case');this.store.put('suite',suite.id,suite);}
 async evaluate(scope:Session,key:string,suiteId:string,runner:(content:string,test:Suite['cases'][number],run:number)=>Promise<Score>) {
  const candidate=this.get(scope,key),suite=this.store.get<Suite>('suite',suiteId);check(suite,'suite_missing');check(candidate.status==='candidate'||candidate.status==='rejected','candidate_state');
  const baseline:Evaluation['baseline']={},proposed:Evaluation['proposed']={};
  for(const test of suite.cases){baseline[test.id]=[];proposed[test.id]=[];for(let run=0;run<(test.modelDependent?3:1);run++){baseline[test.id]!.push(await runner(candidate.before,test,run));proposed[test.id]!.push(await runner(candidate.after,test,run));}}
  const result=this.assess(suite,baseline,proposed);const evaluation:Evaluation={...result,id:id(),candidate:key,suite:suiteId,baselineVersion:candidate.baseVersion,baseline,proposed};
  this.store.transaction(()=>{candidate.evaluation=evaluation.id;candidate.status=evaluation.eligible?'eligible':'rejected';this.store.put('evaluation',evaluation.id,evaluation,scope.repository,scope.session);this.store.put('candidate',key,candidate,scope.repository,scope.session);this.store.audit('learning.evaluated',{candidate:key,evaluation:evaluation.id,eligible:evaluation.eligible,reasons:evaluation.reasons},scope.repository,scope.session);});return evaluation;
 }
 assess(suite:Suite,baseline:Evaluation['baseline'],proposed:Evaluation['proposed']):{eligible:boolean;reasons:string[]} {
  const reasons:string[]=[];let improved=false;
  for(const c of suite.cases){const b=baseline[c.id],p=proposed[c.id],runs=c.modelDependent?3:1;
   if(!b||!p||b.length!==runs||p.length!==runs||[...b,...p].some(s=>!Number.isFinite(s.score)||s.score<0||s.score>1||typeof s.passed!=='boolean')){reasons.push(`${c.id}: incomplete runs`);continue;}
   if(c.kind==='control'){if(p.some(s=>!s.passed))reasons.push(`${c.id}: mandatory control failed`);continue;}
   const stats=(a:Score[])=>{const sorted=a.map(s=>s.score).sort((a,b)=>a-b);return {median:sorted[Math.floor(sorted.length/2)]!,lowest:sorted[0]!};};const old=stats(b),next=stats(p);
   if(next.median<old.median||next.lowest<old.lowest)reasons.push(`${c.id}: quality regression`);if(next.median>old.median)improved=true;
  }
  if(!improved)reasons.push('No predefined median quality improvement');return {eligible:reasons.length===0,reasons};
 }
 get(scope:Session,key:string){const c=this.store.get<Candidate>('candidate',key);check(c&&c.repository===scope.repository&&c.session===scope.session,'candidate_not_found');return c;}
 privacyReview(scope:Session,key:string,reviewer:string,decision:{candidateHash:string;publicSources:boolean;noPrivateContent:boolean;metadataReviewed:boolean;uncertain:boolean}) {
  const c=this.get(scope,key);check(reviewer!==scope.session&&reviewer.length>0,'independent_privacy_review');check(decision.candidateHash===digest(c.after)&&decision.publicSources&&decision.noPrivateContent&&decision.metadataReviewed&&!decision.uncertain,'privacy_review_failed');
  this.store.put('privacy-review',key,{...decision,reviewer,repository:scope.repository},scope.repository,scope.session);
 }
 promote(scope:Session,key:string,human:boolean,global=false):Skill {
  return this.store.transaction(()=>{
   const c=this.get(scope,key),e=this.store.get<Evaluation>('evaluation',c.evaluation??'');check(human,'human_approval_required');check(c.status==='eligible'&&e?.eligible&&e.candidate===c.id&&e.baselineVersion===c.baseVersion,'learning_ineligible');
   const suite=this.store.get<Suite>('suite',e.suite);check(suite,'suite_missing');check(this.assess(suite,e.baseline,e.proposed).eligible,'learning_ineligible');
   const localKey=`${scope.repository}:${c.target}`,current=this.store.get<Skill>('skill',localKey);check((current?.version??'initial')===c.baseVersion,'learning_baseline');
   if(global){const privacy=this.store.get<{candidateHash:string;repository:string}>('privacy-review',key);check(privacy?.repository===scope.repository&&privacy.candidateHash===digest(c.after),'global_privacy_required');}
   const targetScope=global?'global':scope.repository;
   // Global metadata deliberately contains no repository identity, candidate id, source references, or private lineage.
   const skill:Skill={id:global?id():c.target,version:c.version,content:c.after,kind:c.kind,revoked:false,scope:targetScope};
   if(current)this.store.put('skill-history',`${localKey}:${current.version}`,current,scope.repository);
   this.store.put('skill',global?`global:${skill.id}`:localKey,skill,global?'':scope.repository);
   c.status='promoted';this.store.put('candidate',key,c,scope.repository,scope.session);this.store.put('promotion',key,{skill:skill.id,scope:targetScope,version:skill.version},scope.repository,scope.session);
   this.store.audit('learning.promoted',{candidate:key,global,version:skill.version},scope.repository,scope.session);
   // Active specialists must start clean under the new instructions, never silently hot-reload.
   for(const s of this.store.list<Session>('session',global?undefined:scope.repository).filter(s=>!s.parent&&s.status!=='terminated'))this.operations.invalidate(s.session,'skill_changed');return skill;
  });
 }
 rollback(scope:Session,key:string){this.store.transaction(()=>{const c=this.get(scope,key),p=this.store.get<{skill:string;scope:string;version:string}>('promotion',key);check(c.status==='promoted'&&p,'promotion_missing');const skill=this.store.get<Skill>('skill',`${p.scope}:${p.skill}`);check(skill?.version===p.version,'rollback_version');skill.revoked=true;this.store.put('skill',`${p.scope}:${p.skill}`,skill,p.scope==='global'?'':scope.repository);c.status='revoked';this.store.put('candidate',key,c,scope.repository,scope.session);
   for(const s of this.store.list<Session>('session',p.scope==='global'?undefined:scope.repository).filter(s=>!s.parent&&s.status!=='terminated'))this.operations.invalidate(s.session,'skill_rollback');this.store.audit('learning.rolled_back',{candidate:key,version:p.version,restartRequired:true},scope.repository,scope.session);
 });}
}
