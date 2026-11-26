import { generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
await mkdir('.dev-keys',{recursive:true,mode:0o700});
const privateExists=await access('.dev-keys/private.pem').then(()=>true,()=>false);
const publicExists=await access('.dev-keys/public.pem').then(()=>true,()=>false);
if (privateExists!==publicExists) throw new Error('Incomplete keypair; remove or repair .dev-keys manually');
if (!privateExists) {
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  await writeFile('.dev-keys/private.pem',privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600,flag:'wx'});
  await writeFile('.dev-keys/public.pem',publicKey.export({type:'spki',format:'pem'}),{flag:'wx'});
}
const now=Date.now();
const probesEnabled=process.env.PROBES_ENABLED==='1';
const failMode=process.env.PROBE_FAIL_MODE??'closed';
const budget=Number(process.env.POLICY_LATENCY_BUDGET_MS??50);
if (!['open','closed'].includes(failMode)||!Number.isInteger(budget)||budget<1||budget>5000) throw new Error('Invalid fixture options');
const policy={schemaVersion:1,policyId:'finance-policy',version:1,tenantId:'tenant-a',agentId:'finance-agent',defaultAction:'block',tools:{allowlist:['get_balance','transfer_money'],denylist:['delete_account']},rules:[{id:'transfer-limit',type:'numeric_limit',tool:'transfer_money',argumentPath:'amount',operator:'gt',value:10000,action:'block'},{id:'sensitive-note',type:'regex',targetPath:'arguments.note',pattern:'SECRET-[0-9]+',action:'flag'}],probes:{enabled:probesEnabled,configurations:probesEnabled?[{probeId:'jailbreak',version:'1.0.0',flagThreshold:0.5,blockThreshold:0.85}]:[]},latencyBudgetMs:budget,failMode};
await writeFile('.dev-keys/bundle.json',JSON.stringify({schemaVersion:1,bundleId:'dev-bundle',version:1,tenantId:'tenant-a',issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+86400000).toISOString(),policies:[policy],revokedTokenIds:[],revokedAgentIds:[],probeVersions:probesEnabled?{jailbreak:'1.0.0'}:{}},null,2));
console.log('Development keys and unsigned fixture bundle ready. Restart API to reload.');
