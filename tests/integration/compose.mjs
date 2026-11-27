import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {check,proxy,token,setPolicy,waitPolicy} from '../../scripts/compose-demo.mjs';
const jwt=await token();const version=await setPolicy({budget:50});await waitPolicy(jwt,version);
assert.equal((await check(jwt)).data.outcome,'allow');assert.equal((await check(jwt,15000)).data.outcome,'block');assert.equal((await check(jwt,500,'SECRET-123')).data.outcome,'flag');

// Proxy mode: only permitted calls reach the mock tool, which has no published port.
const toolExecutions=()=>JSON.parse(execFileSync('docker',['compose','exec','-T','mock-tool','node','-e',"fetch('http://127.0.0.1:9000/executions').then(r=>r.text()).then(t=>process.stdout.write(t))"],{encoding:'utf8'})).count;
async function assertProxy(amount,note,{status,forwarded,outcome}){
  const before=toolExecutions();
  const r=await proxy(jwt,amount,note);
  assert.equal(r.status,status);
  assert.equal(r.data.forwarded,forwarded);
  assert.equal(r.data.decision.outcome,outcome);
  assert.equal(toolExecutions()-before,forwarded?1:0);
  return r;
}
const allowed=await assertProxy(500,'ordinary',{status:200,forwarded:true,outcome:'allow'});
assert.equal(allowed.data.upstream.body.decisionId,allowed.data.decision.decisionId);
await assertProxy(15000,'ordinary',{status:403,forwarded:false,outcome:'block'});
await assertProxy(500,'SECRET-123',{status:200,forwarded:true,outcome:'flag'});
for(const failMode of ['open','closed']){const v=await setPolicy({probes:true,failMode,budget:100});await waitPolicy(jwt,v);const r=await check(jwt);assert.equal(r.data.outcome,failMode==='open'?'allow':'block');assert.equal(r.data.degraded,true);assert.ok(r.data.reasons.some(x=>x.code==='INFERENCE_TIMEOUT'));
  // An inference timeout under fail-closed must not reach the tool; under fail-open it does.
  await assertProxy(500,'ordinary',failMode==='open'?{status:200,forwarded:true,outcome:'allow'}:{status:403,forwarded:false,outcome:'block'});}
const v=await setPolicy({budget:50});await waitPolicy(jwt,v);execFileSync('docker',['compose','stop','control-plane'],{stdio:'inherit'});try{assert.equal((await check(jwt)).data.outcome,'allow');await sleep(Number(process.env.STALE_WAIT_MS??16000));const r=await check(jwt);assert.equal(r.data.outcome,'block');assert.ok(r.data.reasons.some(x=>x.code==='STALE_POLICY'));}finally{execFileSync('docker',['compose','start','control-plane'],{stdio:'inherit'});}
const sql=(statement)=>execFileSync('docker',['compose','exec','-T','local-db','psql','-U','lab','-d','audit','-At','-c',statement],{encoding:'utf8'}).trim();
const id=(await check(jwt)).data.decisionId;for(let i=0;i<20;i++){if(sql(`SELECT count(*) FROM audit_records WHERE decision_id='${id}'`)==='1')break;await sleep(500);}assert.equal(sql(`SELECT count(*) FROM audit_records WHERE decision_id='${id}'`),'1');
sql(`INSERT INTO audit_queue(decision_id,event) SELECT decision_id,event FROM audit_records WHERE decision_id='${id}'`);await sleep(2000);assert.equal(sql(`SELECT count(*) FROM audit_records WHERE decision_id='${id}'`),'1');assert.equal(sql(`SELECT count(*) FROM audit_queue WHERE decision_id='${id}'`),'0');
const bad='00000000-0000-4000-8000-000000000099';sql(`INSERT INTO audit_queue(decision_id,event,attempts) VALUES('${bad}','{}',2)`);for(let i=0;i<20;i++){if(sql(`SELECT count(*) FROM audit_dead_letter WHERE decision_id='${bad}'`)==='1')break;await sleep(500);}assert.equal(sql(`SELECT count(*) FROM audit_dead_letter WHERE decision_id='${bad}'`),'1');
console.log('Compose integration scenarios passed');
