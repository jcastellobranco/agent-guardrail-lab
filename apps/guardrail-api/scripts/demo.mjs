import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { importPKCS8,SignJWT } from 'jose';
const key=await importPKCS8(await readFile('.dev-keys/private.pem','utf8'),'EdDSA');
const token=await new SignJWT({tenantId:'tenant-a',agentId:'finance-agent'}).setProtectedHeader({alg:'EdDSA',kid:'dev-key'}).setSubject('finance-agent').setIssuer('agent-guardrail-lab').setAudience('guardrail-api').setIssuedAt().setExpirationTime('5m').setJti(randomUUID()).sign(key);
for (const [expected,amount,note] of [['allow',500,'ordinary'],['block',15000,'ordinary'],['flag',500,'SECRET-123']]) {
  const response=await fetch(`${process.env.GUARDRAIL_URL??'http://127.0.0.1:8000'}/v1/check`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({agentId:'finance-agent',tool:'transfer_money',arguments:{amount,note}})});
  const body=await response.json();
  console.log(expected,response.status,body);
  if (!response.ok || body.outcome!==expected) process.exitCode=1;
}
