/* Hardware capacity qualification. Run only on an isolated host/container with a temporary DB. */
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const {config}=require('../server/production/config');
const {createRuntime}=require('../server/production/main');
const D=require('../src/domain'),G=require('../src/game');

const int=(name,fallback,min,max)=>{const raw=process.env[name]??String(fallback);if(!/^\d+$/.test(raw))throw Error('INVALID_'+name);const n=Number(raw);if(!Number.isSafeInteger(n)||n<min||n>max)throw Error('INVALID_'+name);return n;};
const percentile=(values,p)=>{if(!values.length)return 0;const xs=values.slice().sort((a,b)=>a-b);return Math.round(xs[Math.min(xs.length-1,Math.floor((xs.length-1)*p))]*100)/100;};
const summarize=rows=>{const ms=rows.map(x=>x.ms);return {requests:rows.length,p50Ms:percentile(ms,.50),p95Ms:percentile(ms,.95),p99Ms:percentile(ms,.99),maxMs:Math.round(Math.max(0,...ms)*100)/100};};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function run(){
 const clients=int('MEGA_CAPACITY_CLIENTS',24,8,96),accounts=int('MEGA_CAPACITY_ACCOUNTS',2000,clients,20000),rounds=int('MEGA_CAPACITY_ROUNDS',12,2,100),maxInflight=int('MEGA_CAPACITY_MAX_INFLIGHT',32,8,128);
 if(clients%2)throw Error('MEGA_CAPACITY_CLIENTS_MUST_BE_EVEN');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-capacity-')),secret='b'.repeat(64),otp='a'.repeat(64),db=path.join(dir,'mega.sqlite');
 const cfg={...config({MEGA_ENV:'staging',MEGA_ORIGIN:'https://capacity.invalid',MEGA_DB:db,MEGA_OTP_SECRET:otp,MEGA_PROXY_SECRET:secret}),host:'127.0.0.1',port:0,adminPort:0,file:db,maxInflight,maxConnections:Math.max(128,maxInflight*3),maxQueued:Math.max(200,clients*2),authWorkers:2};
 const runtime=await createRuntime(cfg),measurements=[],unexpected=[],expectedBackpressure=[];
 let agent=new http.Agent({keepAlive:true,maxSockets:Math.max(32,clients*2)});
 try{
  const c=runtime.service.community,tokens=[],actorIndex=new Map();
  c.tx(()=>{const a=c.read();for(let i=0;i<accounts;i++){const id='capacity-'+i;a.addAccount(id,{verified:true,coins:10000,crowns:100,rating:1500,games:30});c.ensureProfile(id,a);if(i<clients){tokens.push(c._issue(id,Date.now()));actorIndex.set(id,i);}}c.write(a);});
  const base='http://127.0.0.1:'+runtime.service.server.address().port;
  async function request(i,method,route,data,{record=true,allow=[]}={}){
   const start=performance.now(),payload=data===undefined?null:JSON.stringify(data),headers={Host:'capacity.invalid','X-Mega-Proxy-Key':secret,'X-Mega-Client-IP':'198.51.100.'+(10+(i%200)),Origin:cfg.origin,Cookie:'__Host-mega_session='+tokens[i].token,'X-CSRF-Token':tokens[i].csrf};
   if(payload!==null){headers['Content-Type']='application/json';headers['Idempotency-Key']=crypto.randomUUID();}
   let status=0,body=null;
   try{({status,body}=await new Promise((resolve,reject)=>{const req=http.request(base+route,{agent,method,headers},res=>{const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>{let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{return reject(Error('INVALID_HTTP_RESULT'));}resolve({status:res.statusCode,body:value});});});req.once('error',reject);req.end(payload);}));
   }catch(error){unexpected.push({phase:'transport',route,code:error.code||error.message});throw error;}
   const ms=performance.now()-start;if(record)measurements.push({route,method,status,ms});
   if(status!==200&&!allow.includes(status))unexpected.push({phase:'http',route,status,error:body&&body.error||null});
   return {status,body,ms};
  }

  const revisions=Array(clients).fill(0);
  const nominalStart=performance.now();
  await Promise.all(Array.from({length:clients},async(_,i)=>{for(let n=0;n<rounds;n++){
   if(n%4===0)await request(i,'GET','/api/v1/profile');
   else if(n%4===1)await request(i,'GET','/api/community/friends');
   else if(n%4===2){const r=await request(i,'POST','/api/account/save',{revision:revisions[i],practice:D.fresh()});if(r.status===200)revisions[i]=r.body.revision;}
   else await request(i,'GET','/api/account/session');
  }}));
  const nominalMs=performance.now()-nominalStart;

  for(let i=0;i<clients;i++)await request(i,'POST','/api/v1/queue',{mode:'casual'});
  await sleep(50);
  const statuses=[];for(let i=0;i<clients;i++)statuses.push((await request(i,'GET','/api/v1/queue')).body);
  const groups=new Map();for(let i=0;i<statuses.length;i++){const s=statuses[i];if(s.state!=='matched')throw Error('CAPACITY_MATCHMAKING_FAILED');if(!groups.has(s.matchId))groups.set(s.matchId,[]);groups.get(s.matchId).push({i,...s});}
  if(groups.size!==clients/2||[...groups.values()].some(x=>x.length!==2))throw Error('CAPACITY_MATCH_PAIRING_FAILED');
  const matches=[];
  for(const [id,players] of groups){for(const p of players)await request(p.i,'POST','/api/v1/accept',{id,termsHash:p.termsHash});const current=(await request(players[0].i,'GET','/api/v1/match/'+encodeURIComponent(id))).body;matches.push({id,state:current});}

  await Promise.all(matches.map(async m=>{for(let n=0;n<6;n++){
   const actor=m.state.symbols[m.state.state.turn],i=actorIndex.get(actor);if(i===undefined)throw Error('CAPACITY_MATCH_ACTOR_UNKNOWN');
   const move=G.legal(m.state.state)[0];const r=await request(i,'POST','/api/v1/move',{id:m.id,revision:m.state.revision,move});m.state=r.body;
   if(n%2===1)m.state=(await request(i,'GET','/api/v1/match/'+encodeURIComponent(m.id))).body;
  }}));

  const hashed=await runtime.passwords.hash('capacity-password-42'),authRows=[],authStart=performance.now();
  await Promise.all(Array.from({length:Math.min(8,clients)},async()=>{for(let n=0;n<4;n++){const start=performance.now();const ok=await runtime.passwords.verify('capacity-password-42',hashed.salt,hashed.password_hash);authRows.push(performance.now()-start);if(!ok)throw Error('CAPACITY_AUTH_VERIFY_FAILED');}}));
  const authMs=performance.now()-authStart;

  const holds=[];
  for(let i=0;i<maxInflight;i++)holds.push(await new Promise((resolve,reject)=>{const req=http.request(base+'/api/account/save',{method:'POST',headers:{Host:'capacity.invalid','X-Mega-Proxy-Key':secret,'X-Mega-Client-IP':'203.0.113.'+(10+i),Origin:cfg.origin,Cookie:'__Host-mega_session='+tokens[i%clients].token,'X-CSRF-Token':tokens[i%clients].csrf,'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()}},res=>{res.resume();});req.once('error',e=>{if(e.code!=='ECONNRESET')reject(e);});req.once('socket',()=>resolve(req));req.write('{"revision":0,');}));
  await sleep(100);
  for(let n=0;n<Math.min(32,clients*2);n++){const r=await request(n%clients,'GET','/api/v1/profile',undefined,{allow:[503]});if(r.status===503)expectedBackpressure.push(r.ms);}
  for(const req of holds)req.destroy();
  await sleep(100);

  const snapshot=runtime.snapshot(),dbStat=fs.statSync(db),wal=fs.existsSync(db+'-wal')?fs.statSync(db+'-wal').size:0;
  const nominal=measurements.filter(x=>x.status===200),byRoute={};
  for(const key of [...new Set(nominal.map(x=>x.method+' '+x.route))])byRoute[key]=summarize(nominal.filter(x=>x.method+' '+x.route===key));
  const report={
   qualification:'Hardware-local production-coordinator capacity run on disposable synthetic state. It does not measure public Internet/TLS latency and never targets live player data.',
   generatedAt:new Date().toISOString(),platform:process.platform,arch:process.arch,node:process.version,cpuCount:os.cpus().length,cpuModel:os.cpus()[0]&&os.cpus()[0].model||null,totalMemoryBytes:os.totalmem(),
   config:{clients,accounts,rounds,maxInflight,maxConnections:cfg.maxConnections,matches:matches.length},
   nominal:{durationMs:Math.round(nominalMs),requests:nominal.length,unexpectedErrors:unexpected.length,perRoute:byRoute},
   auth:{operations:authRows.length,totalMs:Math.round(authMs),p50Ms:percentile(authRows,.5),p95Ms:percentile(authRows,.95),p99Ms:percentile(authRows,.99)},
   backpressure:{attempts:Math.min(32,clients*2),rejected503:expectedBackpressure.length,p95RejectMs:percentile(expectedBackpressure,.95)},
   runtime:{eventLoopP99Ms:snapshot.eventLoopP99Ms,rssBytes:snapshot.rssBytes,requests:snapshot.requests,errors:snapshot.errors,busy:snapshot.busy},
   storage:{dbBytes:dbStat.size,walBytes:wal},unexpected
  };
  report.functionalPass=unexpected.length===0&&expectedBackpressure.length>0&&snapshot.busy>=expectedBackpressure.length;
  fs.mkdirSync('.artifacts',{recursive:true});fs.writeFileSync('.artifacts/v4-capacity-acceptance.json',JSON.stringify(report,null,2)+'\n');process.stdout.write(JSON.stringify(report,null,2)+'\n');
  if(!report.functionalPass)process.exitCode=2;
  return report;
 }finally{
  agent.destroy();while(runtime.passwords.active)await sleep(25);await runtime.close();fs.rmSync(dir,{recursive:true,force:true});
 }
}
if(require.main===module)run().catch(error=>{console.error('CAPACITY_ACCEPTANCE_FAILED: '+error.message);process.exitCode=1;});
module.exports={run};
