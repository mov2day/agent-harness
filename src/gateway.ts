import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { check, digest, hash, id } from './core.js';
import type { Operation, Operations } from './operations.js';
import type { Store } from './store.js';
export function publicAddress(address:string):boolean {
  if(isIP(address)===4){const p=address.split('.').map(Number),a=p[0]!,b=p[1]!;
    return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0||b===2))||(a===198&&(b===18||b===19||b===51))||(a===203&&b===0));}
  if(isIP(address)===6){const a=address.toLowerCase();return /^[23][0-9a-f]{3}:/.test(a)&&!a.startsWith('2001:')&&!a.startsWith('2002:')&&!a.startsWith('3fff:');}
  return false;
}
export function researchUrl(value:string,domains:string[]) {
  const url=new URL(value);check(url.protocol==='https:'&&!url.username&&!url.password&&!url.hash&&(!url.port||url.port==='443'),'research_url');
  check(domains.includes(url.hostname)&&!isIP(url.hostname.replace(/^\[|\]$/g,'')),'domain_denied');return url;
}
export interface Evidence {id:string;repository:string;session:string;url:string;chain:string[];address:string;fetched:number;hash:string;content:string;trust:'untrusted';sources:string[]}
export class Gateway {
  constructor(readonly store:Store,readonly operations:Operations,private resolve=lookup) {}
  async fetch(op:Operation,signal:AbortSignal):Promise<Evidence> {
    const cacheKey=digest([op.repository,op.session,op.args.url]);
    const cached=this.store.get<Evidence>('gateway-cache',cacheKey);
    this.operations.validate(op);if(cached){check(cached.repository===op.repository&&cached.session===op.session,'cache_scope');return cached;}
    const chain:string[]=[];let target=op.args.url;
    for(let redirects=0;redirects<=5;redirects++){
      const e=this.operations.validate(op),policy=this.operations.policies.effective(e.repository).policy;
      const url=researchUrl(target,policy.domains);const records=await this.resolve(url.hostname,{all:true,verbatim:true});
      check(records.length>0&&records.every(r=>publicAddress(r.address)),'prohibited_address');const destination=records[0]!;
      this.operations.validate(op);signal.throwIfAborted();chain.push(url.href);
      const response=await this.connect(url,destination.address,destination.family,signal);
      if([301,302,303,307,308].includes(response.status)){check(redirects<5&&response.location,'redirect_limit');target=new URL(response.location,url).href;continue;}
      check(response.status>=200&&response.status<300,'research_http_status',`Research server returned ${response.status}`);
      this.operations.validate(op);
      const evidence:Evidence={id:id(),repository:op.repository,session:op.session,url:url.href,chain,address:destination.address,fetched:this.store.clock.now(),hash:hash(response.body),content:response.body.toString('utf8'),trust:'untrusted',sources:[]};
      this.store.transaction(()=>{this.store.put('evidence',evidence.id,evidence,op.repository,op.session);this.store.put('gateway-cache',cacheKey,evidence,op.repository,op.session);this.store.audit('research.fetched',{id:evidence.id,url:evidence.url,hash:evidence.hash,chain,address:destination.address},op.repository,op.session);});return evidence;
    }throw new Error('redirect_limit');
  }
  private connect(url:URL,address:string,family:number,signal:AbortSignal):Promise<{status:number;location?:string;body:Buffer}> {
    return new Promise((resolve,reject)=>{
      // The TLS peer is validated against url.hostname; DNS is never looked up a second time.
      const pinnedLookup:LookupFunction=(_host,_options,callback)=>callback(null,address,family);
      const req=request(url,{method:'GET',lookup:pinnedLookup,servername:url.hostname,rejectUnauthorized:true,signal,agent:false,headers:{'accept-encoding':'identity','user-agent':'agent-harness/0.1'}},res=>{
        const chunks:Buffer[]=[];let bytes=0;
        res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>256*1024){res.destroy(new Error('research_result_limit'));return;}chunks.push(chunk);});
        res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode??0,location:res.headers.location,body:Buffer.concat(chunks)}));
      });req.setTimeout(10_000,()=>req.destroy(new Error('research_timeout')));req.on('error',reject);req.end();
    });
  }
}
