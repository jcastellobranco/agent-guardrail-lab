import {cpus,totalmem,platform,release} from 'node:os';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {setPolicy,token,waitPolicy} from '../../scripts/compose-demo.mjs';
const out='benchmarks/results';await mkdir(out,{recursive:true});
const machine={cpu:cpus()[0]?.model,logicalCpus:cpus().length,memoryBytes:totalmem(),platform:platform(),kernel:release(),node:process.version,docker:execFileSync('docker',['version','--format','{{.Server.Version}}'],{encoding:'utf8'}).trim(),timestamp:new Date().toISOString()};
await writeFile(`${out}/machine.json`,JSON.stringify(machine,null,2));
const budget=Number(process.env.BENCHMARK_BUDGET_MS??50);
try{for(const probes of [false,true]){const v=await setPolicy({probes,budget,failMode:'closed'}),jwt=await token();await waitPolicy(jwt,v);if(probes)execFileSync('docker',['compose','exec','-T','inference-service','python','-c',"import urllib.request; urllib.request.urlopen('http://127.0.0.1:8001/health/ready')"],{stdio:'inherit'});const name=probes?'with-probes':'without-probes';execFileSync('k6',['run','--summary-export',`${out}/${name}.json`,'tests/load/check.js'],{env:{...process.env,AGENT_TOKEN:jwt},stdio:'inherit'});}}
finally{await setPolicy({probes:false,budget:50});}
const results=[];for(const name of ['without-probes','with-probes']){const d=JSON.parse(await readFile(`${out}/${name}.json`,'utf8'));const m=d.metrics.valid_check_latency_ms;results.push({scenario:name,p50:m?.['p(50)'],p95:m?.['p(95)'],p99:m?.['p(99)'],degradedRate:d.metrics.degraded_decisions?.value??d.metrics.degraded_decisions?.rate,probeScoredRate:d.metrics.probe_scored?.value??d.metrics.probe_scored?.rate,requests:d.metrics.http_reqs?.count});}await writeFile(`${out}/summary.json`,JSON.stringify({machine,budget,results},null,2));console.log(results);
