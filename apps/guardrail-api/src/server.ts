import {localPool,enqueue,BufferedAuditSink} from '@lab/local-audit';
import {PromMetrics} from './infrastructure/metrics.js';
import { refreshSignedCache } from './infrastructure/signed-cache.js';
import { readFile } from 'node:fs/promises';
import { HttpInferenceClient } from './infrastructure/http-inference-client.js';
import { buildApp } from './app.js';
import { readConfig } from './config.js';
import { JwtVerifier } from './infrastructure/jwt.js';
import { MemoryPolicyStore } from './infrastructure/memory-policy-store.js';
const config=readConfig();
const pem=await readFile(config.JWT_PUBLIC_KEY_PATH,'utf8');
const auth=await JwtVerifier.fromPem({[config.JWT_KEY_ID]:pem},config.JWT_ISSUER,config.JWT_AUDIENCE);
const store=new MemoryPolicyStore(config.MAX_POLICY_AGE_MS,Date.now,config.SILO_TENANT);
let refreshTimer:ReturnType<typeof setInterval>|undefined;
if(process.env.SIGNED_BUNDLE_PATH){
 const publicKey=await readFile(process.env.BUNDLE_PUBLIC_KEY_PATH??'', 'utf8');const keys=new Map([[process.env.BUNDLE_KEY_ID??'bundle-key',publicKey]]);const path=process.env.SIGNED_BUNDLE_PATH;let refreshing=false;
 const refresh=async()=>{if(refreshing)return;refreshing=true;try{await refreshSignedCache(store,path,config.SILO_TENANT,keys);}catch{console.warn('Signed cache not refreshed');}finally{refreshing=false;}};
 await refresh();refreshTimer=setInterval(()=>{void refresh();},1000);refreshTimer.unref();
}else{if(process.env.NODE_ENV==='production')throw new Error('Signed bundle required in production');store.replace(JSON.parse(await readFile(config.POLICY_BUNDLE_PATH,'utf8')));}
const metrics=new PromMetrics(()=>({age:store.cacheAgeSeconds(config.SILO_TENANT),version:store.version(config.SILO_TENANT),stale:!store.ready()}));const auditPool=process.env.LOCAL_AUDIT_DATABASE_URL?localPool(process.env.LOCAL_AUDIT_DATABASE_URL):undefined;const audit=auditPool?new BufferedAuditSink(e=>enqueue(auditPool,e),()=>metrics.auditDrop()):undefined;
const app=buildApp({auth,store,metrics,audit,budgetMs:config.LATENCY_BUDGET_MS,logger:true,inference:new HttpInferenceClient(config.INFERENCE_URL),headroomMs:config.INFERENCE_HEADROOM_MS});
app.addHook('onClose',async()=>{if(refreshTimer)clearInterval(refreshTimer);await audit?.close();await auditPool?.end();});
for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,()=>{void app.close().catch(()=>{process.exitCode=1;});});
await app.listen({port:config.PORT,host:config.HOST});
