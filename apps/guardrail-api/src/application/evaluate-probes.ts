import { InferenceRequestSchema, InferenceResponseSchema, type AgentPolicy, type ToolCall } from '@lab/contracts';
import type { Finding } from '@lab/policy-engine';
import type { InferenceClient } from './ports.js';
import { performance } from 'node:perf_hooks';

export class InferenceFailure extends Error {
  constructor(readonly code: string) { super(code); }
}

export function encodeToolText(call: ToolCall): string {
  // No tenant ID or token; the model sees tool data only inside the data plane.
  return JSON.stringify({tool:call.tool,arguments:call.arguments,context:call.context??{}});
}

export async function evaluateProbes(call: ToolCall, policy: AgentPolicy, client: InferenceClient|undefined, budgetMs: number, onModelVersion?:(version:string)=>void): Promise<Finding[]> {
  const deadline=performance.now()+budgetMs;
  if (budgetMs<=0) throw new InferenceFailure('INFERENCE_TIMEOUT');
  if (!client) throw new InferenceFailure('INFERENCE_UNAVAILABLE');
  const configs=policy.probes.configurations;
  const request=InferenceRequestSchema.safeParse({text:encodeToolText(call),probeIds:configs.map(c=>`${c.probeId}:${c.version}`)});
  if (!request.success) throw new InferenceFailure('INFERENCE_INPUT_LIMIT');
  const remaining=deadline-performance.now();
  if (remaining<=0) throw new InferenceFailure('INFERENCE_TIMEOUT');
  const controller=new AbortController();
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const timeout=new Promise<never>((_resolve,reject)=>{
      timer=setTimeout(()=>{reject(new InferenceFailure('INFERENCE_TIMEOUT'));controller.abort();},Math.max(1,Math.floor(remaining)));
    });
    const raw=await Promise.race([timeout,client.score(request.data,controller.signal)]);
    if (performance.now()>=deadline) throw new InferenceFailure('INFERENCE_TIMEOUT');
    const response=InferenceResponseSchema.safeParse(raw);
    if (!response.success) throw new InferenceFailure('INFERENCE_INVALID_RESPONSE');
    const scores=response.data.scores;
    if (Object.keys(scores).length!==request.data.probeIds.length || request.data.probeIds.some(id=>!Object.hasOwn(scores,id))) throw new InferenceFailure('INFERENCE_INVALID_RESPONSE');
    const findings=configs.map<Finding>(c=>{
      const id=`${c.probeId}:${c.version}`, score=scores[id]!;
      const outcome=score>=c.blockThreshold?'block':score>=c.flagThreshold?'flag':'allow';
      return {outcome,reason:{source:'probe',code:outcome==='block'?'PROBE_BLOCK':outcome==='flag'?'PROBE_FLAG':'PROBE_ALLOWED',probeId:id,score}};
    });
    if(performance.now()>=deadline) throw new InferenceFailure('INFERENCE_TIMEOUT');
    onModelVersion?.(response.data.modelVersion);
    return findings;
  } catch (error) {
    if (error instanceof InferenceFailure) throw error;
    throw new InferenceFailure(controller.signal.aborted?'INFERENCE_TIMEOUT':'INFERENCE_UNAVAILABLE');
  } finally {
    if(timer!==undefined) clearTimeout(timer);
    controller.abort();
  }
}
