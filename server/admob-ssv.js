/* AdMob ECDSA verification. Only call settlement with the returned verified object. */
'use strict';
const crypto=require('node:crypto'),M=require('../src/monetization.js');
const KEY_URL='https://www.gstatic.com/admob/reward/verifier-keys.json';
function createAdMobVerifier({now=Date.now,fetchKeys=null}={}){
 let cached=null,cachedAt=0,inflight=null;
 async function keys(){
  if(cached&&now()-cachedAt<24*60*60*1000)return cached;
  if(!inflight)inflight=(async()=>{let body;if(fetchKeys)body=await fetchKeys();else{const r=await fetch(KEY_URL,{signal:AbortSignal.timeout(5000),redirect:'error'});if(!r.ok)throw Error('AD_KEYS_UNAVAILABLE');const text=await r.text();if(Buffer.byteLength(text)>65536)throw Error('INVALID_AD_KEYS');body=JSON.parse(text);}const out=new Map();for(const row of body.keys||[])if(row.keyId!==undefined&&typeof row.pem==='string')out.set(String(row.keyId),crypto.createPublicKey(row.pem));if(!out.size)throw Error('INVALID_AD_KEYS');cached=out;cachedAt=now();return out;})().finally(()=>{inflight=null;});
  return inflight;
 }
 return async raw=>{
  if(typeof raw!=='string'||raw.length>8192)throw Error('INVALID_AD_CALLBACK');
  const query=raw.includes('?')?raw.slice(raw.indexOf('?')+1):raw;
  const parts=/^(.+)&signature=([^&]+)&key_id=(\d+)$/.exec(query);if(!parts)throw Error('INVALID_AD_SIGNATURE');
  const params=new URLSearchParams(parts[1]),seen=new Set();for(const [k] of params){if(seen.has(k)||k==='signature'||k==='key_id')throw Error('DUPLICATE_AD_PARAMETER');seen.add(k);}
  const key=(await keys()).get(parts[3]);if(!key)throw Error('UNKNOWN_AD_KEY');
  let signature;try{const text=decodeURIComponent(parts[2]);if(!/^[A-Za-z0-9_=-]+$/.test(text))throw Error();signature=Buffer.from(text,'base64url');}catch{throw Error('INVALID_AD_SIGNATURE');}
  if(!crypto.verify('sha256',Buffer.from(parts[1]),key,signature))throw Error('INVALID_AD_SIGNATURE');
  const timestamp=Number(params.get('timestamp')),amount=Number(params.get('reward_amount'));
  if(!/^\d+$/.test(params.get('timestamp')||'')||!Number.isSafeInteger(timestamp)||timestamp>now()+60000||now()-timestamp>M.POLICY.callbackGrace)throw Error('STALE_AD_CALLBACK');
  if(!/^\d+$/.test(params.get('reward_amount')||'')||!Number.isSafeInteger(amount)||amount<1)throw Error('INVALID_AD_REWARD');
  const result={transactionId:params.get('transaction_id'),actor:params.get('user_id'),ticket:params.get('custom_data'),adUnit:params.get('ad_unit'),rewardItem:params.get('reward_item'),amount,timestamp};
  for(const k of ['transactionId','actor','ticket','adUnit','rewardItem'])if(typeof result[k]!=='string'||!result[k]||result[k].length>200)throw Error('INVALID_AD_CALLBACK');
  return result;
 };
}
module.exports={createAdMobVerifier};
