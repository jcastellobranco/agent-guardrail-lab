import http from 'k6/http';
import {check} from 'k6';
import {Trend,Rate} from 'k6/metrics';
const latency=new Trend('valid_check_latency_ms',true),degraded=new Rate('degraded_decisions'),scored=new Rate('probe_scored');
export const options={vus:Number(__ENV.VUS||5),duration:__ENV.DURATION||'30s',summaryTrendStats:['min','med','avg','p(50)','p(95)','p(99)','max'],thresholds:{checks:['rate>0.99']}};
export default function(){const r=http.post(`${__ENV.GUARDRAIL_URL||'http://127.0.0.1:8000'}/v1/check`,JSON.stringify({agentId:'finance-agent',tool:'transfer_money',arguments:{amount:500,note:'ordinary'},context:{prompt:'Please verify the transfer.'}}),{headers:{Authorization:`Bearer ${__ENV.AGENT_TOKEN}`,'Content-Type':'application/json'}});let d;try{d=r.json();}catch{}const ok=check(r,{'evaluated':r.status===200&&['allow','flag','block'].includes(d?.outcome)});if(ok){latency.add(r.timings.duration);degraded.add(d.degraded===true);scored.add(d.reasons?.some(x=>x.source==='probe')===true);}}
