'use strict';
const crypto=require('node:crypto');
const KEYS='https://www.googleapis.com/oauth2/v3/certs';
const parse=x=>{try{return JSON.parse(Buffer.from(x,'base64url').toString('utf8'));}catch{throw Error('INVALID_PUSH_AUTH');}};
class GooglePushAuth{
 constructor({audience,email,fetcher=globalThis.fetch,now=Date.now}={}){if(!audience||!email)throw Error('GOOGLE_PUSH_AUTH_CONFIG');this.audience=audience;this.email=email;this.fetch=fetcher;this.now=now;this.cache={expires:0,keys:new Map()};}
 async key(kid){
  if(this.cache.expires<=this.now()||!this.cache.keys.has(kid)){
   const res=await this.fetch(KEYS,{redirect:'error',signal:AbortSignal.timeout(5000)});if(!res.ok)throw Error('PUSH_AUTH_UNAVAILABLE');
   const value=await res.json(),keys=new Map();for(const jwk of value.keys||[])if(jwk.kid&&jwk.kty==='RSA'&&jwk.use==='sig')keys.set(jwk.kid,crypto.createPublicKey({key:jwk,format:'jwk'}));
   const cc=String(res.headers.get?.('cache-control')||''),age=Number(cc.match(/max-age=(\d+)/)?.[1]||300);this.cache={keys,expires:this.now()+Math.min(3600,Math.max(60,age))*1000};
  }
  const key=this.cache.keys.get(kid);if(!key)throw Error('INVALID_PUSH_AUTH');return key;
 }
 async verify(header){
  const token=String(header||'').match(/^Bearer ([A-Za-z0-9._-]+)$/)?.[1];if(!token)throw Error('INVALID_PUSH_AUTH');const parts=token.split('.');if(parts.length!==3)throw Error('INVALID_PUSH_AUTH');
  const h=parse(parts[0]),p=parse(parts[1]);if(h.alg!=='RS256'||typeof h.kid!=='string'||h.typ&&h.typ!=='JWT')throw Error('INVALID_PUSH_AUTH');
  const key=await this.key(h.kid),ok=crypto.verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),key,Buffer.from(parts[2],'base64url'));if(!ok)throw Error('INVALID_PUSH_AUTH');
  const now=Math.floor(this.now()/1000);if(!['accounts.google.com','https://accounts.google.com'].includes(p.iss)||p.aud!==this.audience||p.email!==this.email||p.email_verified!==true||!Number.isFinite(p.iat)||!Number.isFinite(p.exp)||p.exp<now-30||p.iat>now+60||now-p.iat>3700)throw Error('INVALID_PUSH_AUTH');
  return p;
 }
}
module.exports={GooglePushAuth};
