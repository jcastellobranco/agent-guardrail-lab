import {readFile} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
import {pull} from './sync.js';
const get=(k:string)=>{const v=process.env[k];if(!v)throw new Error(`Missing ${k}`);return v;};
const c={url:get('CONTROL_PLANE_URL'),tenantId:get('SILO_TENANT'),token:get('SYNC_TOKEN'),keys:new Map([[process.env.BUNDLE_KEY_ID??'bundle-key',await readFile(get('BUNDLE_PUBLIC_KEY_PATH'),'utf8')]]),path:get('SIGNED_BUNDLE_PATH'),allowHttp:process.env.ALLOW_INSECURE_LOCAL_HTTP==='1'};
const interval=Number(process.env.SYNC_INTERVAL_MS??30000);if(!Number.isFinite(interval)||interval<1000)throw new Error('Invalid poll interval');
const abort=new AbortController();for(const s of ['SIGINT','SIGTERM'] as const)process.once(s,()=>abort.abort());while(!abort.signal.aborted){try{console.log('Accepted bundle version',await pull(c));}catch{console.warn('Sync failed; retaining last valid bundle');}try{await sleep(interval,undefined,{signal:abort.signal});}catch{break;}}
