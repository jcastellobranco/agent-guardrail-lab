import type {AuditEvent} from '@lab/contracts';
import Fastify from 'fastify';
import { performance } from 'node:perf_hooks';
import { CheckToolCall } from './application/check-tool-call.js';
import type { PolicyStore,TokenVerifier,InferenceClient } from './application/ports.js';
import { HttpError } from './domain/errors.js';
import { PromMetrics } from './infrastructure/metrics.js';
export function buildApp(deps:{auth:TokenVerifier;store:PolicyStore;metrics?:PromMetrics;budgetMs?:number;logger?:boolean;inference?:InferenceClient;headroomMs?:number;audit?:{offer(event:AuditEvent):void}}) {
  const app=Fastify({logger:deps.logger??false,bodyLimit:65536,requestTimeout:10000,disableRequestLogging:true});
  const metrics=deps.metrics??new PromMetrics();
  const check=new CheckToolCall(deps.auth,deps.store,metrics,deps.budgetMs,undefined,deps.inference,deps.headroomMs);
  const pending=new WeakMap<object,AuditEvent>();
  app.addHook('onResponse',async request=>{const event=pending.get(request);if(event){pending.delete(request);deps.audit?.offer(event);}});
  const starts=new WeakMap<object,number>();
  app.addHook('onRequest',async request=>{ starts.set(request,performance.now()); });
  app.setErrorHandler((err,req,reply)=>{
    if (err instanceof HttpError) return reply.code(err.status).send({error:err.code});
    const status = (err as {statusCode?:number}).statusCode;
    if (status && status>=400 && status<500) return reply.code(status).send({error:status===413?'PAYLOAD_TOO_LARGE':'INVALID_REQUEST'});
    req.log.error({code:'INTERNAL_ERROR'},'Guardrail request failed');
    return reply.code(503).send({error:'EVALUATION_UNAVAILABLE'});
  });
  app.post('/v1/check',async (request,reply)=>{
    const authorization=request.headers.authorization;
    if (!authorization?.startsWith('Bearer ') || !authorization.slice(7)) throw new HttpError(401,'TOKEN_REQUIRED');
    const decision=await check.execute(authorization.slice(7),request.body,starts.get(request),deps.audit?event=>{pending.set(request,event);}:undefined);
    return reply.code(200).send(decision);
  });
  app.get('/health/live',async()=>({status:'ok'}));
  app.get('/health/ready',async(_req,reply)=>{const ready=deps.store.ready();return reply.code(ready?200:503).send({status:ready?'ready':'not_ready'});});
  app.get('/health/serving',async(_req,reply)=>{const loaded=deps.store.hasSnapshot?.()??deps.store.ready();return reply.code(loaded?200:503).send({status:loaded?'serving':'not_ready',fresh:deps.store.ready()});});
  app.get('/metrics',async(_req,reply)=>reply.type(metrics.registry.contentType).send(await metrics.registry.metrics()));
  return app;
}
