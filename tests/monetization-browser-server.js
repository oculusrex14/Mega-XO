/* Local test providers ONLY. No __test__ routes exist in production. */
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {buildService}=require('../server/community-server'),{IdentityProviders}=require('../server/identity-provider'),{jwk,sign}=require('./helpers/identity-fixture'),{createAdMobVerifier}=require('../server/admob-ssv');
const port=Number(process.argv[2]),origin='http://127.0.0.1:'+port,dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-v35-browser-')),receipts=new Map(),keys=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const providers=new IdentityProviders({config:{google:{nativeAudiences:['test-native']}},keysForTest:()=>[jwk]});
const verifyAd=createAdMobVerifier({fetchKeys:async()=>({keys:[{keyId:1,pem:keys.publicKey.export({type:'spki',format:'pem'})}]})});
const s=buildService({file:path.join(dir,'db'),origin,providerInstance:providers,allowLocalHttp:true,monetizationOptions:{eligible:()=>true,purchasesEnabled:true,verifyPurchase:async token=>receipts.get(token),adMode:'hybrid',adUnit:'fixture-unit',verifyAd}});
const original=s.request;s.server.removeAllListeners('request');s.server.on('request',async(req,res)=>{if(!req.url.startsWith('/__test__/'))return original(req,res);try{let text='';for await(const part of req)text+=part;const b=JSON.parse(text||'{}');let result;
 if(req.url==='/__test__/token')result={idToken:sign(b.provider,b.subject,b.nonce)};
 else if(req.url==='/__test__/buy'){const cookie=/mega_dev_session=([^;]+)/.exec(req.headers.cookie||'')?.[1],actor=s.community.requireLinked(cookie).actor,id=crypto.randomUUID();receipts.set(id,{valid:true,accountId:actor,store:'apple',transactionId:id,productId:b.productId});result={evidence:id};}
 else if(req.url==='/__test__/restore'){const cookie=/mega_dev_session=([^;]+)/.exec(req.headers.cookie||'')?.[1],actor=s.community.requireLinked(cookie).actor;result=[...receipts].filter(([,r])=>r.accountId===actor&&r.productId==='remove_ads').map(([id])=>id);}
 else if(req.url==='/__test__/ad'){const q=new URLSearchParams({ad_unit:'fixture-unit',custom_data:b.ticket,reward_amount:'1',reward_item:'cosmetic_reward',timestamp:String(Date.now()),transaction_id:crypto.randomUUID(),user_id:b.actor}).toString();result={query:q+'&signature='+crypto.sign('sha256',Buffer.from(q),keys.privateKey).toString('base64url')+'&key_id=1'};}
 else throw Error('UNKNOWN_TEST_ROUTE');res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));}catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}});
s.server.listen(port,'127.0.0.1',()=>console.log(origin));process.on('SIGTERM',async()=>{await s.close();fs.rmSync(dir,{recursive:true,force:true});process.exit(0);});
