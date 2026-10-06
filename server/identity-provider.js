/* Provider verification for the account layer. No keys, access tokens or provider
 * subjects are accepted as proof from a browser without signature/code verification.
 * URLs/issuers/algorithms are fixed here, never taken from a JWT header.
 */
'use strict';
const crypto = require('node:crypto');
const PROVIDERS = Object.freeze({
 google: {authorize:'https://accounts.google.com/o/oauth2/v2/auth', token:'https://oauth2.googleapis.com/token', keys:'https://www.googleapis.com/oauth2/v3/certs', issuers:['https://accounts.google.com','accounts.google.com']},
 apple: {authorize:'https://appleid.apple.com/auth/authorize', token:'https://appleid.apple.com/auth/token', keys:'https://appleid.apple.com/auth/keys', issuers:['https://appleid.apple.com']}
});
const b64 = x => Buffer.from(x).toString('base64url');
const sha = x => crypto.createHash('sha256').update(x).digest('base64url');
function equal(a,b) { if(typeof a!=='string'||typeof b!=='string')return false; const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y); }
function parseSegment(s){if(!/^[A-Za-z0-9_-]+$/.test(s))throw Error('INVALID_ID_TOKEN');try{return JSON.parse(Buffer.from(s,'base64url'));}catch{throw Error('INVALID_ID_TOKEN');}}
class IdentityProviders {
 constructor({config={},fetcher=globalThis.fetch,now=Date.now,keysForTest=null}={}){this.config=config;this.fetch=fetcher;this.now=now;this.cache=new Map();this.keysForTest=keysForTest;}
 enabled(provider,kind='web'){const c=this.config[provider];return !!(PROVIDERS[provider]&&c?.clientId&&(kind==='native'||(provider==='google'?c.clientSecret:c.teamId&&c.keyId&&c.privateKey)));}
 capabilities(){return Object.fromEntries(Object.keys(PROVIDERS).map(p=>[p,{web:this.enabled(p),native:!!this.config[p]?.nativeAudiences?.length}]));}
 audience(provider,kind){const c=this.config[provider];return kind==='native'?c?.nativeAudiences||[]:[c?.clientId].filter(Boolean);}
 authorization(provider,attempt,redirect){if(!this.enabled(provider))throw Error('PROVIDER_NOT_CONFIGURED');const p=PROVIDERS[provider],c=this.config[provider],u=new URL(p.authorize);u.search=new URLSearchParams({client_id:c.clientId,redirect_uri:redirect,response_type:'code',state:attempt.state,nonce:attempt.nonce});
  if(provider==='google'){u.searchParams.set('scope','openid profile');u.searchParams.set('code_challenge',sha(attempt.verifier));u.searchParams.set('code_challenge_method','S256');u.searchParams.set('prompt','select_account');}
  // No personal-name/email scopes required: a user chooses a game profile. Apple
  // allows a query callback for this code-only, no-scopes request (not form_post).
  else u.searchParams.set('response_mode','query');return u.href;
 }
 appleSecret(clientId){const c=this.config.apple,t=Math.floor(this.now()/1000);if(!c?.privateKey||!c.teamId||!c.keyId)throw Error('PROVIDER_NOT_CONFIGURED');const header=b64(JSON.stringify({alg:'ES256',kid:c.keyId})),payload=b64(JSON.stringify({iss:c.teamId,iat:t,exp:t+300,aud:'https://appleid.apple.com',sub:clientId})),input=header+'.'+payload;return input+'.'+crypto.sign('sha256',Buffer.from(input),{key:c.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');}
 async json(url,options={}){const res=await this.fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(6000)});if(!res.ok)throw Error('PROVIDER_UNAVAILABLE');const text=await res.text();if(text.length>131072)throw Error('INVALID_PROVIDER_RESPONSE');try{return JSON.parse(text);}catch{throw Error('INVALID_PROVIDER_RESPONSE');}}
 async exchange(provider,code,attempt,redirect){if(!this.enabled(provider)||typeof code!=='string'||!code||code.length>4096)throw Error('INVALID_AUTHORIZATION_CODE');const c=this.config[provider];const body=new URLSearchParams({client_id:c.clientId,client_secret:provider==='apple'?this.appleSecret(c.clientId):c.clientSecret,code,grant_type:'authorization_code',redirect_uri:redirect});if(provider==='google')body.set('code_verifier',attempt.verifier);const tokens=await this.json(PROVIDERS[provider].token,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});return this.verify(provider,tokens.id_token,attempt.nonce,'web');}
 async keys(provider,force=false){if(this.keysForTest)return this.keysForTest(provider);const prior=this.cache.get(provider);if(prior&&(!force&&prior.expires>this.now()||force&&prior.at>this.now()-30000))return prior.keys;const result=await this.json(PROVIDERS[provider].keys);if(!Array.isArray(result.keys))throw Error('INVALID_PROVIDER_RESPONSE');this.cache.set(provider,{keys:result.keys,at:this.now(),expires:this.now()+3600000});return result.keys;}
 async verify(provider,token,nonce,kind='native'){if(!PROVIDERS[provider]||typeof token!=='string'||token.length>16384||!nonce)throw Error('INVALID_ID_TOKEN');const parts=token.split('.');if(parts.length!==3)throw Error('INVALID_ID_TOKEN');const header=parseSegment(parts[0]),claims=parseSegment(parts[1]);if(header.alg!=='RS256'||typeof header.kid!=='string'||header.kid.length>256||header.crit||header.jku||header.x5u)throw Error('INVALID_TOKEN_HEADER');
  let keys=await this.keys(provider),jwk=keys.find(k=>k.kid===header.kid&&k.kty==='RSA'&&(!k.use||k.use==='sig')&&(!k.alg||k.alg==='RS256'));if(!jwk){keys=await this.keys(provider,true);jwk=keys.find(k=>k.kid===header.kid&&k.kty==='RSA'&&(!k.use||k.use==='sig')&&(!k.alg||k.alg==='RS256'));}if(!jwk)throw Error('UNKNOWN_SIGNING_KEY');
  const key=crypto.createPublicKey({key:jwk,format:'jwk'});if(!crypto.verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),key,Buffer.from(parts[2],'base64url')))throw Error('INVALID_SIGNATURE');const now=Math.floor(this.now()/1000),aud=this.audience(provider,kind);
  if(!PROVIDERS[provider].issuers.includes(claims.iss)||!aud.includes(claims.aud)||!Number.isFinite(claims.exp)||claims.exp<=now||!Number.isFinite(claims.iat)||claims.iat>now+30||now-claims.iat>600||claims.nbf&&claims.nbf>now+30||!equal(claims.nonce,nonce)||typeof claims.sub!=='string'||!claims.sub||claims.sub.length>255||claims.azp&&![...aud,...(this.config[provider]?.authorizedParties||[])].includes(claims.azp))throw Error('INVALID_TOKEN_CLAIMS');
  return {provider,subject:claims.sub}; // Intentionally no email-based identity or linking.
 }
}
module.exports={IdentityProviders,PROVIDERS,equal,sha};
