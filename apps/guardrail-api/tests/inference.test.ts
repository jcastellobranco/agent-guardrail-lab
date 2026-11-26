import { describe,expect,it,vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { MemoryPolicyStore } from '../src/infrastructure/memory-policy-store.js';
import { HttpInferenceClient } from '../src/infrastructure/http-inference-client.js';
import { encodeToolText,evaluateProbes } from '../src/application/evaluate-probes.js';
import type { InferenceClient } from '../src/application/ports.js';
import type { AgentPolicy,InferenceRequest,InferenceResponse } from '@lab/contracts';
import { bundle,call,policy } from './fixtures.js';
const p:AgentPolicy={...policy,probes:{enabled:true,configurations:[{probeId:'jailbreak',version:'1.0.0',flagThreshold:.5,blockThreshold:.8}]},latencyBudgetMs:200};
const response=(score:number):InferenceResponse=>({scores:{'jailbreak:1.0.0':score},modelVersion:'test:v1',latencyMs:1});
const tokenVerifier={verify:async()=>({sub:'agent-a',tenantId:'tenant-a',agentId:'agent-a',jti:'token',iss:'i',aud:'a',iat:0,exp:9999999999})};
async function check(client:InferenceClient|undefined,policy:AgentPolicy=p,payload:unknown=call){
  const store=new MemoryPolicyStore();store.replace(bundle(policy));
  const app=buildApp({auth:tokenVerifier,store,inference:client,budgetMs:200});
  try { const res=await app.inject({method:'POST',url:'/v1/check',payload:JSON.stringify(payload),headers:{authorization:'Bearer token','content-type':'application/json'}});expect(res.statusCode).toBe(200);return res.json(); } finally {await app.close();}
}

describe('probe enforcement',()=>{
  it.each([[.2,'allow'],[.5,'flag'],[.8,'block']] as const)('maps %s to %s',async(score,outcome)=>{
    expect(await check({score:async()=>response(score)})).toMatchObject({outcome,degraded:false});
  });
  it('skips inference on a deterministic block',async()=>{
    const score=vi.fn(async()=>response(0));expect(await check({score},p,{...call,arguments:{amount:999}})).toMatchObject({outcome:'block'});expect(score).not.toHaveBeenCalled();
  });
  it('preserves deterministic flag even when probe allows',async()=>{
    const flagPolicy:AgentPolicy={...p,rules:[{id:'flag',type:'numeric_limit',tool:'transfer',argumentPath:'amount',operator:'gt',value:1,action:'flag'}]};
    expect(await check({score:async()=>response(0)},flagPolicy)).toMatchObject({outcome:'flag'});
  });
  it.each(['open','closed'] as const)('handles a timed-out probe in %s mode',async(failMode)=>{
    let signal:AbortSignal|undefined;
    const score=vi.fn((_req:InferenceRequest,s:AbortSignal)=>{signal=s;return new Promise<InferenceResponse>(()=>{});});
    const res=await check({score},{...p,failMode,latencyBudgetMs:100});
    expect(res).toMatchObject({outcome:failMode==='open'?'allow':'block',degraded:true});expect(res.reasons).toContainEqual({code:'INFERENCE_TIMEOUT',source:'system'});expect(signal?.aborted).toBe(true);
  });
  it('fails closed on missing or extra probe scores',async()=>{
    const cases:Record<string,number>[]=[{},{'jailbreak:1.0.0':0,'other:1.0.0':0}];
    for(const scores of cases){
      expect(await check({score:async()=>({...response(0),scores})})).toMatchObject({outcome:'block',degraded:true});
    }
  });
  it('degrades if inference is not configured',async()=>expect(await check(undefined)).toMatchObject({outcome:'block',degraded:true}));
  it('does not dispatch after the deadline is exhausted',async()=>{
    const score=vi.fn(async()=>response(0));await expect(evaluateProbes(call,p,{score},0)).rejects.toThrow('INFERENCE_TIMEOUT');expect(score).not.toHaveBeenCalled();
  });
  it('does not include agent ID or credentials in model text',()=>expect(encodeToolText({...call,context:{prompt:'hello'}})).toBe('{"tool":"transfer","arguments":{"amount":5},"context":{"prompt":"hello"}}'));
  it('HTTP adapter validates body and forwards cancellation signal',async()=>{
    const transport=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify(response(.7))));
    const client=new HttpInferenceClient('http://localhost:8001',transport);const c=new AbortController();
    expect(await client.score({text:'hello',probeIds:['jailbreak:1.0.0']},c.signal)).toEqual(response(.7));
    expect(transport.mock.calls[0]?.[1]?.signal).toBe(c.signal);
  });
  it('HTTP adapter rejects bad response',async()=>{
    const client=new HttpInferenceClient('http://localhost:8001',async()=>new Response('invalid'));await expect(client.score({text:'x',probeIds:['jailbreak:1.0.0']},new AbortController().signal)).rejects.toThrow('INFERENCE_INVALID_RESPONSE');
  });
});
