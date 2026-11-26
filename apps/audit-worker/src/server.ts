import {setTimeout as sleep} from 'node:timers/promises';
import {localPool,processOne} from '@lab/local-audit';
const pool=localPool(process.env.LOCAL_AUDIT_DATABASE_URL??'');let running=true;for(const s of ['SIGINT','SIGTERM'] as const)process.once(s,()=>{running=false;});
try{while(running){try{if(!await processOne(pool))await sleep(1000);}catch{console.warn('Audit processing unavailable');await sleep(2000);}}}finally{await pool.end();}
