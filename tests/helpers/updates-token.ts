import { createCipheriv,createDecipheriv,randomBytes } from 'node:crypto';
// Only isolated fixtures may expire their own encrypted custody. No product key
// export or token-editing route is exposed by this helper.
export function editUpdatesToken(token:string,key:Buffer,edit:(bound:any)=>void){
  const bytes=Buffer.from(token,'base64url'),decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAAD(Buffer.from('combined-updates-1'));decipher.setAuthTag(bytes.subarray(12,28));
  const value=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString());edit(value);
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from('combined-updates-1'));
  const out=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);return Buffer.concat([nonce,cipher.getAuthTag(),out]).toString('base64url');
}
