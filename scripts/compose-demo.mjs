import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';
const control=process.env.CONTROL_PLANE_URL??'http://127.0.0.1:8002',guard=process.env.GUARDRAIL_URL??'http://127.0.0.1:8000',admin=process.env.ADMIN_TOKEN??'local-only-admin-change-me-1234';
export async function request(path,method='GET',body,token=admin,base=control){const res=await fetch(base+path,{method,headers:{authorization:`Bearer ${token}`,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(6000)});const data=res.status===204?null:await res.json();return {status:res.status,data};}
export const agent='/v1/admin/tenants/tenant-a/agents/finance-agent';
export async function setPolicy({probes=false,failMode='closed',budget=50}={}){const current=await request('/v1/admin/tenants/tenant-a/policies');assert.equal(current.status,200);const version=(current.data.find(p=>p.agentId==='finance-agent')?.version??0)+1;
 const p={schemaVersion:1,policyId:'finance-policy',version,tenantId:'tenant-a',agentId:'finance-agent',defaultAction:'block',tools:{allowlist:['get_balance','transfer_money'],denylist:['delete_account']},rules:[{id:'transfer-limit',type:'numeric_limit',tool:'transfer_money',argumentPath:'amount',operator:'gt',value:10000,action:'block'},{id:'sensitive-note',type:'regex',targetPath:'arguments.note',pattern:'SECRET-[0-9]+',action:'flag'}],probes:{enabled:probes,configurations:probes?[{probeId:'jailbreak',version:'1.0.0',flagThreshold:.5,blockThreshold:.85}]:[]},latencyBudgetMs:budget,failMode};
 assert.equal((await request(agent+'/policy','PUT',p)).status,200);return version;}
export async function token(){const r=await request(agent+'/token','POST');assert.equal(r.status,200);return r.data.token;}
export async function check(jwt,amount=500,note='ordinary',prompt='Please verify the transfer.'){return request('/v1/check','POST',{agentId:'finance-agent',tool:'transfer_money',arguments:{amount,note},context:{prompt}},jwt,guard);}
export async function proxy(jwt,amount=500,note='ordinary',prompt='Please verify the transfer.'){return request('/v1/proxy/transfer_money','POST',{agentId:'finance-agent',arguments:{amount,note},context:{prompt}},jwt,guard);}
export async function waitPolicy(jwt,version){for(let i=0;i<60;i++){try{const r=await check(jwt);if(r.status===200&&r.data.policyVersion===version)return r.data;}catch{}await sleep(1000);}throw new Error('Policy did not arrive');}
if(process.argv[2]==='seed'){
 const tenant=await request('/v1/admin/tenants','POST',{id:'tenant-a',name:'Demo tenant'});assert.ok([201,409].includes(tenant.status));const a=await request('/v1/admin/tenants/tenant-a/agents','POST',{id:'finance-agent'});assert.ok([201,409].includes(a.status));await setPolicy({probes:process.env.PROBES_ENABLED==='1',failMode:process.env.PROBE_FAIL_MODE??'closed',budget:Number(process.env.POLICY_LATENCY_BUDGET_MS??50)});
}else if(process.argv[2]==='demo'){
 const jwt=await token();for(const [amount,note] of [[500,'ordinary'],[15000,'ordinary'],[500,'SECRET-123']]){const r=await check(jwt,amount,note);console.log(r.status,r.data);}
}else if(process.argv[2]==='proxy'){
 const jwt=await token();for(const [amount,note] of [[500,'ordinary'],[15000,'ordinary'],[500,'SECRET-123']]){const r=await proxy(jwt,amount,note);console.log(r.status,JSON.stringify(r.data));}
}else if(process.argv[2]==='policy'){console.log('Policy version',await setPolicy({probes:process.env.PROBES_ENABLED==='1',failMode:process.env.PROBE_FAIL_MODE??'closed',budget:Number(process.env.POLICY_LATENCY_BUDGET_MS??50)}));}
