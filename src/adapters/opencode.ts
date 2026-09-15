import { check } from '../core.js';
import type { RuntimeRelay } from './bridge.js';
const harnessTools=new Set(['harness_read','harness_change','harness_delete','harness_rename','harness_research','harness_execute','harness_delegate','harness_artifact','harness_review','harness_compact','harness_learn']);
/** OpenCode 1.x plugin hook contract. Install in an immutable certified runtime image, with a scoped relay. */
export function openCodeHooks(relay:RuntimeRelay,sessionID:string) {
  return {
    'tool.execute.before': async(input:{tool:string;sessionID:string;callID:string},_output:{args:unknown})=>{
      check(input.sessionID===sessionID,'runtime_session_spoof');
      check(harnessTools.has(input.tool),'native_tool_denied',`Tool ${input.tool} must use the engine broker`);
    },
    'experimental.session.compacting':async(input:{sessionID:string},output:{context:string[]})=>{
      check(input.sessionID===sessionID,'runtime_session_spoof');
      const context=await relay.context(sessionID);output.context.push(JSON.stringify({authoritativeCheckpoint:context}));
    },
    dispatch:async(tool:string,args:unknown,callID:string)=>{
      check(harnessTools.has(tool),'native_tool_denied');
      return relay.execute({session:sessionID,tool:tool.slice('harness_'.length),args,call:callID});
    }
  };
}
export const openCodeRuntimeProfile={runtime:'opencode',protocol:'plugin-1.x',requiredHooks:['tool.execute.before','experimental.session.compacting'],nativeTools:'deny',rootSessionLaunch:false} as const;
