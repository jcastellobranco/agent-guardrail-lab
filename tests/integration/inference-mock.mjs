import {createServer} from 'node:http';
import {setTimeout as sleep} from 'node:timers/promises';
createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;try{const q=JSON.parse(body);await sleep(500);if(res.destroyed)return;res.setHeader('content-type','application/json');res.end(JSON.stringify({scores:Object.fromEntries(q.probeIds.map(id=>[id,.1])),modelVersion:'test-mock',latencyMs:500}));}catch{res.statusCode=400;res.end();}}).listen(8001,'0.0.0.0');
