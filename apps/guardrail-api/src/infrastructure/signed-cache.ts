import {readFile} from 'node:fs/promises';
import {verifyBundle} from '@lab/bundles';
import type {MemoryPolicyStore} from './memory-policy-store.js';
export async function refreshSignedCache(store:MemoryPolicyStore,path:string,tenantId:string,keys:ReadonlyMap<string,string>){const b=verifyBundle(JSON.parse(await readFile(path,'utf8')),keys,tenantId);if(b.version>store.version(tenantId)){store.replace(b);return true;}return false;}
