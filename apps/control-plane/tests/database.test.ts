import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {database,agents,tenants,policies} from '@lab/database';
import {eq} from 'drizzle-orm';
import {buildControl} from '../src/app.js';
import {verifyBundle} from '@lab/bundles';
const url=process.env.TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
suite('control plane postgres',()=>{it('creates identities, issues JWT, rejects rollback and syncs signed bundles',async()=>{
 const {pool,db}=database(url!);const id=`test-${randomUUID()}`,key=generateKeyPairSync('ed25519');const priv=key.privateKey.export({type:'pkcs8',format:'pem'}).toString(),pub=key.publicKey.export({type:'spki',format:'pem'}).toString();
 const app=await buildControl(db,{adminToken:'admin',syncTokens:new Map([[id,'sync']]),jwtPem:priv,bundlePem:priv,jwtKid:'jwt',bundleKid:'b',issuer:'issuer',audience:'audience',bundleTtlMs:300000});const admin={authorization:'Bearer admin'},sync={authorization:'Bearer sync'};const agent=`/v1/admin/tenants/${id}/agents/a`;
 const p={schemaVersion:1,tenantId:id,agentId:'a',policyId:'p',version:1,defaultAction:'block',tools:{allowlist:['safe'],denylist:[]},rules:[],probes:{enabled:false,configurations:[]},failMode:'closed',latencyBudgetMs:50};
 try{expect((await app.inject({method:'POST',url:'/v1/admin/tenants',headers:admin,payload:{id,name:'Test'}})).statusCode).toBe(201);expect((await app.inject({method:'POST',url:`/v1/admin/tenants/${id}/agents`,headers:admin,payload:{id:'a'}})).statusCode).toBe(201);expect((await app.inject({method:'PUT',url:agent+'/policy',headers:admin,payload:p})).statusCode).toBe(200);expect((await app.inject({method:'PUT',url:agent+'/policy',headers:admin,payload:p})).statusCode).toBe(409);expect((await app.inject({method:'POST',url:agent+'/token',headers:admin})).json().token).toBeTypeOf('string');const path=`/v1/sync/${id}/bundle`;expect((await app.inject({method:'GET',url:path,headers:admin})).statusCode).toBe(401);const b=verifyBundle((await app.inject({method:'GET',url:path,headers:sync})).json(),new Map([['b',pub]]),id);expect(b.policies).toHaveLength(1);const b2=verifyBundle((await app.inject({method:'GET',url:path,headers:sync})).json(),new Map([['b',pub]]),id);expect(b2.version).toBeGreaterThan(b.version);}
 finally{await app.close();await db.delete(policies).where(eq(policies.tenantId,id));await db.delete(agents).where(eq(agents.tenantId,id));await db.delete(tenants).where(eq(tenants.id,id));await pool.end();}
 },30000);});
