import {generateKeyPairSync} from 'node:crypto';
import {access,writeFile,chown,chmod} from 'node:fs/promises';
for(const dir of ['/keys-private','/keys-public','/cache']){await chown(dir,1000,1000);await chmod(dir,0o750);}
for(const name of ['jwt','bundle']){
 const priv=`/keys-private/${name}.pem`,pub=`/keys-public/${name}.pem`;
 const exists=async p=>access(p).then(()=>true,()=>false);const a=await exists(priv),b=await exists(pub);if(a!==b)throw new Error('Incomplete keys');if(!a){const {privateKey,publicKey}=generateKeyPairSync('ed25519');await writeFile(priv,privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600,flag:'wx'});await writeFile(pub,publicKey.export({type:'spki',format:'pem'}),{mode:0o644,flag:'wx'});}
 await chown(priv,1000,1000);await chown(pub,1000,1000);
}
