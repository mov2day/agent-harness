import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, symlinkSync, linkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { hash, id, type Role, type Session } from '../src/core.js';
import { Operations, type Operation, type Tool } from '../src/operations.js';
import { NativeFiles } from '../src/files.js';
import { defaultPolicy } from '../src/policy.js';
import { publicAddress, researchUrl } from '../src/gateway.js';
import { fixture } from './helpers.js';
function setup(role:Role='Implementer'){
 const f=fixture();f.policies.publish('global',{...defaultPolicy,deletion:true,tools:['read','change','delete','rename','execute','research','artifact','review','compact','delegate'],domains:['example.com'],commands:[{executable:'/bin/echo',args:['ok'],env:{},cwd:'src'}]},true);
 const auth=f.register();auth.session.role=role;auth.session.enforcement='enforced';auth.session.stage=role==='Researcher'?'research':role==='Verifier'?'execution':'implementation';f.identity.saveSession(auth.session);f.identity.revokeTokens(auth.session.session);const token=f.identity.issue(auth.session).capability;
 const operations=new Operations(f.store,f.identity,f.policies,()=>true),files=new NativeFiles();
 const begin=(tool:Tool,args:Record<string,unknown>,key:string=id())=>operations.begin(token,f.binding.connection,{tool,args,idempotencyKey:key});
 const approve=(tool:Tool,args:Record<string,unknown>)=>{const approval=id();f.store.put('action-approval',approval,{id:approval,repository:f.repo.id,session:auth.session.root,action:operations.actionHash(tool,args),policy:auth.session.policy,human:true,valid:true,dependencies:[]});return {...args,approval};};
 return {...f,operations,files,begin,approve,token,session:auth.session};
}
test('file broker: reviewed create, replace, rename and exact deletion',async()=>{
 const f=setup();try{
  mkdirSync(join(f.repo.path,'src'));let op=f.begin('change',f.approve('change',{path:'src/file',base:null,content:'first'}));
  assert.equal((await f.operations.run(op,async()=>f.files.mutate(f.repo,op,f.operations))).status,'completed');assert.equal(readFileSync(join(f.repo.path,'src/file'),'utf8'),'first');
  op=f.begin('change',f.approve('change',{path:'src/file',base:hash('first'),content:'second'}));assert.equal((await f.operations.run(op,async()=>f.files.mutate(f.repo,op,f.operations))).status,'completed');
  op=f.begin('rename',f.approve('rename',{path:'src/file',to:'src/renamed',base:hash('second')}));assert.equal((await f.operations.run(op,async()=>f.files.mutate(f.repo,op,f.operations))).status,'completed');
  op=f.begin('delete',f.approve('delete',{path:'src/renamed',base:hash('second')}));assert.equal((await f.operations.run(op,async()=>f.files.mutate(f.repo,op,f.operations))).status,'completed');assert.equal(f.files.read(f.repo,'src/renamed'),null);
 }finally{f.close();}
});
test('file broker: leaf and intermediate symlinks, hard links, stale bases and root replacement',async()=>{
 const f=setup();try{
  mkdirSync(join(f.repo.path,'src'));writeFileSync(join(f.other.path,'private'),'private');symlinkSync(join(f.other.path,'private'),join(f.repo.path,'src/leaf'));symlinkSync(f.other.path,join(f.repo.path,'outside'));linkSync(join(f.other.path,'private'),join(f.repo.path,'src/hard'));
  for(const path of ['src/leaf','outside/private','src/hard'])assert.throws(()=>f.files.read(f.repo,path),/resolution|unsafe leaf/);
  writeFileSync(join(f.repo.path,'src/file'),'changed');const op=f.begin('change',f.approve('change',{path:'src/file',base:hash('old'),content:'replacement'}));assert.equal((await f.operations.run(op,async()=>f.files.mutate(f.repo,op,f.operations))).status,'failed');assert.equal(readFileSync(join(f.repo.path,'src/file'),'utf8'),'changed');
  renameSync(f.repo.path,join(f.dir,'moved'));mkdirSync(f.repo.path);assert.throws(()=>f.files.read(f.repo,'src/file'),/root identity/);assert.equal(readFileSync(join(f.other.path,'private'),'utf8'),'private');
 }finally{f.close();}
});
test('authority: reviewed arguments, roles, paths, stages, exact commands, environment and research injection',()=>{
 const f=setup();try{
  const approved=f.approve('delete',{path:'src/a',base:hash('a')});assert.throws(()=>f.begin('delete',{...approved,path:'src/b'}),/review_required/);
  assert.throws(()=>f.begin('change',f.approve('change',{path:'.env',base:null,content:'secret'})),/path_denied/);
  assert.throws(()=>f.begin('research',{url:'https://example.com/'}),/role_authority/);
  assert.throws(()=>f.begin('execute',{executable:'/bin/sh',args:['-c','rm -rf src'],env:{},cwd:'src',approval:'x'}),/role_authority/);
  assert.throws(()=>f.operations.begin(f.token,f.binding.connection,{tool:'shell',args:{},idempotencyKey:id()}),/tool_unlisted/);
 }finally{f.close();}
 const r=setup('Researcher');try{assert.throws(()=>r.begin('delete',r.approve('delete',{path:'src/tests',base:hash('weaken tests')})),/role_authority/);}finally{r.close();}
 const v=setup('Verifier');try{assert.throws(()=>v.begin('execute',v.approve('execute',{executable:'/bin/echo',args:['ok','; rm'],env:{},cwd:'src'})),/command_denied/);}finally{v.close();}
});
test('invalidation: before admission, while running, commit admission and completed effects',async()=>{
 for(const reason of ['policy_changed','skill_rollback','capability_expired','capability_revoked']){
  const f=setup();try{const op=f.begin('read',{path:'src/a'});f.operations.invalidate(f.session.session,reason);assert.throws(()=>f.operations.commit(op,()=>{throw new Error('MUST NOT RUN');}),/operation_authority_lost/);assert.equal(f.operations.current(op).invalidated?.outcome,'cancelled_without_effects');}finally{f.close();}
 }
 const f=setup();try{
  let finish!:(value:unknown)=>void;const op=f.begin('read',{path:'src/a'});const running=f.operations.run(op,()=>new Promise(resolve=>{finish=resolve;}));f.operations.invalidate(f.session.session,'capability_revoked');finish('observed partial result');const result=await running;assert.equal(result.status,'requires_reconciliation');assert.equal(result.invalidated?.outcome,'partially_completed');
 }finally{f.close();}
 const g=setup();try{const op=g.begin('read',{path:'src/a'});await g.operations.run(op,async()=>g.operations.commit(op,()=>({done:true})));g.operations.invalidate(g.session.session,'policy_changed');assert.equal(g.operations.current(op).invalidated?.outcome,'completed_before_invalidation');}finally{g.close();}
});
test('idempotency and crash reconciliation never rerun completed or interrupted effects',async()=>{
 const f=setup();try{const op=f.begin('read',{path:'src/a'},'same');let effects=0;await f.operations.run(op,async()=>++effects);await f.operations.run(f.begin('read',{path:'src/a'},'same'),async()=>++effects);assert.equal(effects,1);assert.throws(()=>f.begin('read',{path:'src/b'},'same'),/idempotency_conflict/);
 const pending=f.begin('read',{path:'src/b'});pending.status='admitted';f.operations.save(pending);f.operations.recover();assert.equal(f.operations.current(pending).status,'requires_reconciliation');assert.equal(f.identity.session(f.session.session).status,'paused');
 }finally{f.close();}
});
test('gateway: private, reserved, rebinding targets, credentials and insecure protocols',()=>{
 for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.2.1','192.168.1.1','100.64.0.1','0.0.0.0','::1','::ffff:127.0.0.1','fe80::1','fc00::1','2001:db8::1','2002:7f00:1::'])assert.equal(publicAddress(address),false,address);
 assert.equal(publicAddress('8.8.8.8'),true);assert.equal(publicAddress('2606:4700:4700::1111'),true);
 for(const url of ['http://example.com','https://user:pass@example.com','https://127.0.0.1','https://example.com:8443','https://example.org'])assert.throws(()=>researchUrl(url,['example.com']));
});
