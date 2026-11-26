import { afterEach,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { generateKeyPair,exportSPKI,SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { JwtVerifier } from '../src/infrastructure/jwt.js';
import { MemoryPolicyStore } from '../src/infrastructure/memory-policy-store.js';
import { bundle,call,policy } from './fixtures.js';
let keys:Awaited<ReturnType<typeof generateKeyPair>>, other:Awaited<ReturnType<typeof generateKeyPair>>, verifier:JwtVerifier, store:MemoryPolicyStore, app:ReturnType<typeof buildApp>, clock:number;
async function token(options:{tenant?:string;agent?:string;issuer?:string;audience?:string;expired?:boolean;wrongKey?:boolean;kid?:string;jti?:string}={}) {
 const now=Math.floor(Date.now()/1000);const agent=options.agent??'agent-a';
 return new SignJWT({tenantId:options.tenant??'tenant-a',agentId:agent}).setProtectedHeader({alg:'EdDSA',kid:options.kid??'key'}).setSubject(agent).setIssuer(options.issuer??'issuer').setAudience(options.audience??'audience').setIssuedAt(now-(options.expired?10:0)).setExpirationTime(now+(options.expired?-1:120)).setJti(options.jti??randomUUID()).sign(options.wrongKey?other.privateKey:keys.privateKey);
}
beforeAll(async()=>{keys=await generateKeyPair('EdDSA');other=await generateKeyPair('EdDSA');verifier=await JwtVerifier.fromPem({key:await exportSPKI(keys.publicKey)},'issuer','audience');});
beforeEach(()=>{clock=Date.now();store=new MemoryPolicyStore(1000,()=>clock);store.replace(bundle(policy,clock));app=buildApp({auth:verifier,store,budgetMs:500});});
afterEach(async()=>{await app.close();});
const request=async(payload:unknown=call,jwt?:string)=>app.inject({method:'POST',url:'/v1/check',headers:{authorization:`Bearer ${jwt??await token()}`,'content-type':'application/json'},payload:JSON.stringify(payload)});
describe('HTTP guardrail',()=>{
 it('returns allow for a valid call',async()=>{const res=await request();expect(res.statusCode).toBe(200);expect(res.json().outcome).toBe('allow');});
 it('returns HTTP 200 with block on limit violation',async()=>{const res=await request({...call,arguments:{amount:101}});expect(res.statusCode).toBe(200);expect(res.json().outcome).toBe('block');});
 it('rejects invalid JWTs',async()=>{for(const opts of [{wrongKey:true},{expired:true},{issuer:'wrong'},{audience:'wrong'},{kid:'wrong'}])expect((await request(call,await token(opts))).statusCode).toBe(401);});
 it('rejects missing credentials',async()=>expect((await app.inject({method:'POST',url:'/v1/check',payload:call})).statusCode).toBe(401));
 it('rejects agent mismatch and unknown tenant',async()=>{expect((await request({...call,agentId:'other'})).statusCode).toBe(403);expect((await request(call,await token({tenant:'tenant-b'}))).statusCode).toBe(403);});
 it('rejects revoked token',async()=>{store.replace({...bundle(policy,clock,2),revokedTokenIds:['revoked']});expect((await request(call,await token({jti:'revoked'}))).statusCode).toBe(403);});
 it('rejects malformed and oversized input',async()=>{expect((await request({agentId:'agent-a'})).statusCode).toBe(400);expect((await request({...call,arguments:{note:'x'.repeat(70000)}})).statusCode).toBe(413);});
 it('fails closed on stale policy',async()=>{clock+=1001;const res=await request();expect(res.json()).toMatchObject({outcome:'block',degraded:true});expect((await app.inject('/health/ready')).statusCode).toBe(503);});
 it('fail-open stale policy preserves deterministic blocking',async()=>{store.replace(bundle({...policy,failMode:'open'},clock,2));clock+=1001;expect((await request()).json()).toMatchObject({outcome:'allow',degraded:true});expect((await request({...call,arguments:{amount:999}})).json()).toMatchObject({outcome:'block',degraded:true});});
 it('exports timings without raw request fields',async()=>{await request();const res=await app.inject('/metrics');expect(res.body).toContain('guardrail_stage_duration_ms');expect(res.body).toContain('guardrail_decisions_total');expect(res.body).not.toContain('agent-a');});
});
