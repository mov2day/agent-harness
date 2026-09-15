import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { DenialMonitor, type Alert } from '../src/monitoring.js';
import type { Scope } from '../src/core.js';
import { TestClock } from './helpers.js';
const scope:Scope={repository:'repo',session:'child',root:'root',role:'Implementer',generation:1,connection:'bridge'};
test('denial windows: bursts across minutes, exact open boundary, all scopes and coalescing',()=>{
 const clock=new TestClock();clock.time=59_999;const store=new Store(':memory:',clock),monitor=new DenialMonitor(store);
 try{for(let i=0;i<9;i++)monitor.record(scope,'path');assert.equal(store.list('alert').length,0);clock.tick(2);monitor.record(scope,'path');assert.equal(store.get<Alert>('alert','session:child:60000')?.count,10);
 for(let i=0;i<40;i++)monitor.record({...scope,session:`child-${i%4}`},'tool');assert.ok(store.get('alert','root:root:60000'));assert.ok(store.get('alert','repository:repo:60000'));assert.ok(store.get('alert','user::60000'));
 clock.time=119_999;const alerts=monitor.record(scope,'boundary');assert.equal(alerts.find(a=>a.scope==='session:child'),undefined);
 assert.equal(store.get<Alert>('alert','root:root:60000')?.sessions.includes('child-3'),true);
 }finally{store.close();}
});
test('denial windows: concurrent events, sustained activity, child attribution and restart recovery',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'harness-alert-')),clock=new TestClock();let store=new Store(join(dir,'state.sqlite'),clock);
 try{let monitor=new DenialMonitor(store);await Promise.all(Array.from({length:99},(_,i)=>Promise.resolve().then(()=>monitor.record({...scope,session:`terminated-child-${i}`},'denied'))));store.close();store=new Store(join(dir,'state.sqlite'),clock);monitor=new DenialMonitor(store);clock.tick(60_001);const alerts=monitor.record(scope,'denied');assert.equal(alerts.find(a=>a.scope==='repository:repo'&&a.window===900_000)?.count,100);assert.equal(alerts.find(a=>a.scope==='user:'&&a.window===900_000)?.sessions.length,100);clock.tick(900_000);assert.equal(monitor.record(scope,'expired').length,0);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
