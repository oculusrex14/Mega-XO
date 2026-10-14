'use strict';
/* Offline preparation only. No learner, model, GPU, hosted inference, or unverified telemetry.
 * Disk-backed hashes bound memory and fence shared/transposed states away from weaker splits.
 * Qualification trajectories are counted but NEVER returned by this development exporter. */
const {DatabaseSync}=require('node:sqlite');
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto');
const C=require('./capture.js'),E=require('../../src/bot/encoding.js'),G=require('../../src/game.js');
const {createWriter,readRecords,privateDirectory}=require('./encrypted.js');
const SPLITS=['qualification','holdout','validation','train'];
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
function trajectory(moves){return Array.from({length:8},(_,s)=>moves.map(m=>{const x=E.mapMove(m,s);return x.b*9+x.c;}).join(',')).sort()[0];}
function family(p){return hash(p.rules.sha256+':'+p.game.firstSymbol+':'+trajectory(p.moves.slice(0,6)));}
function splitFor(f,seed){const n=parseInt(hash(seed+':'+f).slice(0,8),16)%100;return n<10?0:n<20?1:n<30?2:3;}
function stateKey(s){return hash(Array.from({length:8},(_,i)=>{const t=E.transform(s,i);return C.stable([t.board,t.mini,t.required,t.turn]);}).sort()[0]);}
const hmac=(key,domain,value)=>crypto.createHmac('sha256',key).update(domain+'\0'+value).digest('hex');
const fail=code=>{throw new Error(code);};
async function exportDataset(db,{directory,key,keyId,pseudonymKey,splitSeed,privacyEpoch,runId=crypto.randomUUID(),positions=true,signal}={}){
 if(!db||typeof db.query!=='function'||!UUID.test(runId)||!Buffer.isBuffer(key)||key.length!==32||!Buffer.isBuffer(pseudonymKey)||pseudonymKey.length!==32||!splitSeed||typeof splitSeed!=='string'||splitSeed.length>120||!Number.isSafeInteger(privacyEpoch)||privacyEpoch<0||typeof positions!=='boolean')fail('CAPTURE_EXPORT_CONFIG');
 const dir=await privateDirectory(directory),dest=path.join(dir,runId+'.mxocap');
 const scratch=await fsp.mkdtemp(path.join(dir,'.index-'));await fsp.chmod(scratch,0o700);
 const indexPath=path.join(scratch,'hashes.sqlite');fs.closeSync(fs.openSync(indexPath,'wx',0o600));
 const index=new DatabaseSync(indexPath);index.exec('PRAGMA journal_mode=OFF; PRAGMA cache_size=-4096; CREATE TABLE seen(key TEXT PRIMARY KEY, rank INTEGER) WITHOUT ROWID; CREATE TABLE games(id TEXT PRIMARY KEY, digest TEXT, family TEXT, rank INTEGER, trajectory TEXT) WITHOUT ROWID; CREATE TABLE trajectories(key TEXT PRIMARY KEY, id TEXT) WITHOUT ROWID;');
 const see=index.prepare('INSERT INTO seen VALUES(?,?) ON CONFLICT(key) DO UPDATE SET rank=min(rank,excluded.rank)');
 const game=index.prepare('INSERT INTO games VALUES(?,?,?,?,?)');const get=index.prepare('SELECT * FROM games WHERE id=?');
 const seen=index.prepare('SELECT rank FROM seen WHERE key=?');const first=index.prepare('INSERT OR IGNORE INTO trajectories VALUES(?,?)');const original=index.prepare('SELECT id FROM trajectories WHERE key=?');
 const scalar=async(s,a)=>(await db.query(s,a)).rows[0]?.value;
 const stop=()=>{if(signal?.aborted)fail('CAPTURE_EXPORT_ABORTED');};
 const stats={scanned:0,accepted:0,excludedPopulation:0,excludedRisk:0,excludedNoPlay:0,excludedConsent:0,qualificationWithheld:0,duplicates:0,games:0,positions:0,crossSplitPositionsRemoved:0,openingPositionsOmitted:0,bySplit:{qualification:0,holdout:0,validation:0,train:0},byReason:{}};
 let writer,published=false,begun=false;
 async function *rows(){let after='';for(;;){stop();const page=(await db.query('SELECT * FROM learning.export_page($1,$2,$3)',[runId,after,100])).rows;if(!page.length)return;for(const r of page){if(typeof r.capture_id!=='string'||r.capture_id<=after||!/^[a-f0-9]{64}$/.test(r.capture_id))fail('CAPTURE_EXPORT_ORDER');after=r.capture_id;yield r;}}}
 try{
  const config=await scalar('SELECT learning.begin_export($1,$2,$3,$4) AS value',[runId,keyId,splitSeed,privacyEpoch]);begun=true;
  // The first pass sees every eligible game, including reserved qualification, before any sample
  // is emitted. Rank 0 always wins collisions, so training can never consume its transpositions.
  for await(const row of rows()){
   stop();stats.scanned++;const p=JSON.parse(row.payload);C.validate(p,row.payload_sha256);
   if(p.provenance.environment!=='production'||p.provenance.population!=='human-v-human'){stats.excludedPopulation++;continue;}
   /* A recorded research decline or withdrawal is honoured here as well as in the DB fence, so a
    * pre-existing sealed payload cannot reach a dataset through a path that predates the choice. */
   if(p.consent?.researchEligible===false){stats.excludedConsent++;continue;}
   if(p.qualityFlags.includes('SOURCE_RISK_FLAGGED')){stats.excludedRisk++;continue;}
   if(!p.moves.length||p.game.reason==='no-show'){stats.excludedNoPlay++;continue;}
   const f=family(p),rank=splitFor(f,splitSeed),tr=hash(trajectory(p.moves));stats.accepted++;stats.bySplit[SPLITS[rank]]++;
   game.run(row.capture_id,row.payload_sha256,f,rank,tr);first.run(tr,row.capture_id);
   if(rank===0)stats.qualificationWithheld++;
   if(positions){let s=G.create();for(const m of p.moves){if(m.ply>=6)see.run(stateKey(s),rank);s=G.apply(s,m);}}
  }
  writer=await createWriter(dest,key,{keyId,kind:'gameplay'});
  await writer.write({type:'manifest',format:'gameplay-dataset/v1',rulesHash:C.RULES_HASH,encodingVersion:E.VERSION,policyVersion:config.policyVersion,splitProtocol:'d4-opening6-frozen-seed/v1',splitSeedFingerprint:hash(splitSeed),qualification:'withheld',labels:'observed-actions; terminal-board-only value',positions});
  for await(const row of rows()){
   stop();const info=get.get(row.capture_id);if(!info||info.rank===0)continue;
   if(row.payload_sha256!==info.digest)fail('CAPTURE_EXPORT_SOURCE_CHANGED');
   const p=JSON.parse(row.payload);C.validate(p,row.payload_sha256);
   const split=SPLITS[info.rank],gameId=hmac(pseudonymKey,'capture-game-v1',row.capture_id),duplicate=original.get(info.trajectory).id!==row.capture_id;
   stats.duplicates+=duplicate?1:0;
   const {startedAt,endedAt,...details}=p.game;
   const archive={type:'game',format:'game-export/v1',gameId,sourceKind:p.source.kind,family:info.family,split,duplicateTrajectory:duplicate,
    provenance:p.provenance,rules:p.rules,game:details,moves:p.moves,final:p.final,qualityFlags:p.qualityFlags};
   // Do not retain linkable source ids, participant ids, UTC times, or raw-source fingerprints.
   await writer.write(archive);stats.games++;stats.byReason[p.game.reason]=(stats.byReason[p.game.reason]||0)+1;
   if(positions&&!duplicate){for(const pos of C.positions(p)){
    stop();if(pos.ply<6){stats.openingPositionsOmitted++;continue;}
    if(seen.get(stateKey(pos.state)).rank!==info.rank){stats.crossSplitPositionsRemoved++;continue;}
    await writer.write({type:'position',format:'observed-position/v1',gameId,family:info.family,split,encodingVersion:E.VERSION,
     ply:pos.ply,player:pos.player,planes:pos.planes,legalMask:pos.legalMask,observedAction:pos.observedAction,playedMove:pos.playedMove,
     policyTargetSource:'observed-player-action',searchPolicy:null,valueTarget:pos.valueTarget,valueTargetSource:pos.valueTargetSource,thinkMs:pos.thinkMs});stats.positions++;
   }}
   await db.query('SELECT learning.export_member($1,$2)',[runId,row.capture_id]);
  }
  stop();const receipt=await writer.finish();published=true;
  const manifest={...receipt,games:stats.games,stats,splitProtocol:'d4-opening6-frozen-seed/v1',splitSeedFingerprint:hash(splitSeed),pseudonymKeyFingerprint:hash(pseudonymKey),encodingVersion:E.VERSION,rulesHash:C.RULES_HASH};
  await db.query('SELECT learning.finish_export($1,$2)',[runId,manifest]);
  return {runId,file:dest,manifest};
 }catch(e){
  await writer?.abort().catch(()=>{});if(published)await fsp.unlink(dest).catch(()=>{});
  if(begun)await db.query('SELECT learning.revoke_export($1)',[runId]).catch(()=>{});
  throw e;
 }finally{index.close();await fsp.rm(scratch,{recursive:true,force:true});}
}
async function *readDataset(db,{file,runId,key,keyId,privacyEpoch}={}){
 if(!UUID.test(runId)||!Number.isSafeInteger(privacyEpoch))fail('CAPTURE_EXPORT_CONFIG');
 async function eligible(){const r=(await db.query('SELECT learning.export_status($1) AS value',[runId])).rows[0]?.value;
  if(!r||r.state!=='ready'||Number(r.privacyEpoch)!==privacyEpoch||!r.manifest)fail('CAPTURE_EXPORT_REVOKED');return r.manifest;}
 const m=await eligible();
// Deletion/choice revocation must fence the NEXT record, not allow up to 99 more
// records from an already invalidated export to reach an offline training reader.
for await(const r of readRecords(file,key,{...m,keyId,kind:'gameplay'})){await eligible();yield r;}
await eligible();
}
async function purgeRevoked(db,directory){
 const dir=await privateDirectory(directory);let purged=0;
 for(const file of await fsp.readdir(dir)){
  if(!file.endsWith('.mxocap')||!UUID.test(file.slice(0,-7)))continue;
  const id=file.slice(0,-7),s=(await db.query('SELECT learning.export_status($1) AS value',[id])).rows[0]?.value;
  if(!s||['revoked','purged','failed'].includes(s.state)){
   const p=path.join(dir,file),st=await fsp.lstat(p);if(st.isFile()&&!st.isSymbolicLink()){await fsp.unlink(p);purged++;}
  }
 }
 return {purged};
}
module.exports={exportDataset,readDataset,purgeRevoked,family,splitFor,stateKey,trajectory,SPLITS};
