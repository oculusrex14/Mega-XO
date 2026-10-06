/* Local seeded acceptance workload. Never target the public game or live mail. */
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const {config}=require('../server/production/config');
const {createRuntime}=require('../server/production/main');
const D=require('../src/domain'),G=require('../src/game');
const percentile=(xs,p)=>{const a=xs.slice().sort((x,y)=>x-y);return Math.round((a[Math.min(a.length-1,Math.floor(a.length*p))]||0)*100)/100;};
async function scenario(accounts,authContention){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-load-')),secret='b'.repeat(64);
 const cfg={...config({MEGA_ORIGIN:'https://game.test',MEGA_OTP_SECRET:'a'.repeat(64),MEGA_PROXY_SECRET:secret}),host:'127.0.0.1',port:0,adminPort:0,file:path.join(dir,'db')};
 const runtime=await createRuntime(cfg),measurements=[],errors=[];
 try {
  const c=runtime.service.community,actorCount=8,tokens=[];
  c.tx(()=>{const a=c.read();for(let i=0;i<accounts;i++){const id='load-'+i;a.addAccount(id,{verified:true});c.ensureProfile(id,a);if(i<actorCount)tokens.push(c._issue(id,Date.now()));}c.write(a);});
  const url='http://127.0.0.1:'+runtime.service.server.address().port;
  const agent=new http.Agent({keepAlive:true,maxSockets:16});
  async function request(i,route,data,measure=true){
   const start=performance.now(),payload=data===undefined?null:JSON.stringify(data);
   const value=await new Promise((resolve,reject)=>{const req=http.request(url+route,{agent,method:payload===null?'GET':'POST',headers:{Host:'game.test','X-Mega-Proxy-Key':secret,'X-Mega-Client-IP':'198.51.100.'+(i+1),Origin:cfg.origin,Cookie:'__Host-mega_session='+tokens[i].token,'X-CSRF-Token':tokens[i].csrf,'Idempotency-Key':crypto.randomUUID(),'Content-Type':'application/json'}},res=>{const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>{let body;try{body=JSON.parse(Buffer.concat(chunks));}catch{return reject(Error('INVALID_HTTP_RESULT'));}if(res.statusCode!==200)errors.push({route,status:res.statusCode});resolve(body);});});req.on('error',reject);req.end(payload);});
   if(measure)measurements.push({route:route.startsWith('/api/v1/match/')?'/api/v1/match/:id':route,ms:performance.now()-start});return value;
  }
  // Four real free queue matches; accepted through the production HTTP boundary.
  const games=[];for(let i=0;i<actorCount;i+=2){const id='load-match-'+i;const m=runtime.service.store.run({actor:'seed-matchmaker',scope:'matchmaker'},id,{type:'queue',id,a:'load-'+i,b:'load-'+(i+1),mode:'casual'});await request(i,'/api/v1/accept',{id,termsHash:m.termsHash},false);const playing=await request(i+1,'/api/v1/accept',{id,termsHash:m.termsHash},false);games.push({i,id,match:playing});}
  const hashed=await runtime.passwords.hash('load-password-42');
  const contention=authContention?Promise.all(Array.from({length:2},async()=>{for(let i=0;i<6;i++)await runtime.passwords.verify('load-password-42',hashed.salt,hashed.password_hash);})):Promise.resolve();
  const started=performance.now();
  await Promise.all([
   contention,
   ...Array.from({length:actorCount},async(_,i)=>{let revision=0;for(let n=0;n<12;n++){if(n%3===0)await request(i,'/api/v1/profile');else if(n%3===1)await request(i,'/api/community/friends');else {const out=await request(i,'/api/account/save',{revision,practice:D.fresh()});revision=out.revision;}}}),
   ...games.map(async game=>{for(let n=0;n<8;n++){const m=game.match,index=Number(m.symbols[m.state.turn].slice(5));game.match={...m,...await request(index,'/api/v1/move',{id:game.id,revision:m.revision,move:G.legal(m.state)[0]})};}})
  ]);
  const workloadMs=performance.now()-started;await contention;agent.destroy();
  if(errors.length)throw Error('LOAD_REQUEST_FAILED '+JSON.stringify(errors));
  const metrics=runtime.snapshot(),stats={};for(const route of new Set(measurements.map(x=>x.route))){const xs=measurements.filter(x=>x.route===route).map(x=>x.ms);stats[route]={requests:xs.length,p50Ms:percentile(xs,.5),p95Ms:percentile(xs,.95),p99Ms:percentile(xs,.99)};}
  return {accounts,concurrentClients:actorCount,concurrentMatches:games.length,authContention,requests:measurements.length,errors:errors.length,workloadMs:Math.round(workloadMs),perRoute:stats,eventLoopP99Ms:metrics.eventLoopP99Ms,rssBytes:metrics.rssBytes};
 } finally {while(runtime.passwords.active)await new Promise(r=>setTimeout(r,25));await runtime.close();fs.rmSync(dir,{recursive:true,force:true});}
}
async function main(){const rows=[];for(const count of [200,1000])rows.push(await scenario(count,true));const report={qualification:'Local loopback workload on synthetic data, not Oracle VPS capacity, internet latency, a soak test or a production SLO guarantee.',platform:process.platform,arch:process.arch,node:process.version,cpu:os.cpus()[0]?.model,scenarios:rows};fs.mkdirSync('.artifacts',{recursive:true});fs.writeFileSync('.artifacts/v4-load-smoke.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={scenario};
