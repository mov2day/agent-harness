import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { check, id } from './core.js';
import type { Operation, Operations } from './operations.js';
const exec=promisify(execFile);
export interface WorkerResult {exitCode:number;output:string;truncated:boolean;container:string}
/** A new container is used for every request. It receives no host mounts, runtime credentials, or network. */
export class CommandWorkers {
  constructor(private operations:Operations,private image:string) {check(/^sha256:[a-f0-9]{64}$/.test(image),'worker_image_digest');}
  async execute(op:Operation,signal:AbortSignal):Promise<WorkerResult> {
    this.operations.validate(op);const name=`harness-worker-${id()}`;
    const args=['run','--rm','--name',name,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','64','--memory','512m','--cpus','1','--user','1000:1000','--ipc','private','--tmpfs','/tmp:rw,noexec,nosuid,size=64m','--workdir',`/workspace/${op.args.cwd}`];
    for(const [key,value] of Object.entries(op.args.env)){check(/^[A-Z_][A-Z0-9_]*$/.test(key)&&!['LD_PRELOAD','LD_LIBRARY_PATH','DYLD_INSERT_LIBRARIES','DOCKER_HOST','SSH_AUTH_SOCK','NODE_OPTIONS','BASH_ENV','ENV'].includes(key),'worker_environment');args.push('--env',`${key}=${value}`);}
    args.push('--entrypoint',op.args.executable,this.image,...op.args.args);
    let killRequested=false;
    const cancel=async()=>{killRequested=true;try{await exec('docker',['kill',name],{timeout:5000});return true;}catch{return false;}};
    this.operations.onCancel(op,cancel);signal.throwIfAborted();
    return new Promise((resolve,reject)=>{
      const child=spawn('docker',args,{stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,HOME:process.env.HOME},detached:false});
      let output='',truncated=false;const append=(data:Buffer)=>{const remaining=256*1024-Buffer.byteLength(output);if(data.length>remaining)truncated=true;if(remaining>0)output+=data.subarray(0,remaining).toString('utf8');};
      child.stdout.on('data',append);child.stderr.on('data',append);child.on('error',reject);
      const abort=()=>{void cancel();};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
      child.on('close',code=>{signal.removeEventListener('abort',abort);if(killRequested)reject(new Error('worker_cancelled'));else resolve({exitCode:code??-1,output,truncated,container:name});});
    });
  }
}
