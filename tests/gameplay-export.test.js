'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs').promises,path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const C=require('../packages/learning/capture.js'),E=require('../src/bot/encoding.js'),G=require('../src/game.js'),X=require('../packages/learning/exporter.js');
const {source}=require('./helpers/gameplay-fixture.js');
function rows(n){return Array.from({length:n},(_,i)=>{const s=source(i+1),v=C.seal(s,{sourceCommit:'a'.repeat(40),environment:'production',population:'human-v-human'});return {capture_id:C.sha256(String(i)),payload:C.stable(v.payload),payload_sha256:v.sha256};}).sort((a,b)=>a.capture_id.localeCompare(b.capture_id));}
function fake(data){const runs=new Map();return {runs,query:async(sql,args=[])=>{
 const id=args[0];if(sql.includes('begin_export')){runs.set(id,{state:'building',privacyEpoch:0,members:[]});return {rows:[{value:{policyVersion:'synthetic-only'}}]};}
 if(sql.includes('export_page')){if(runs.get(id).state!=='building')throw Error('CAPTURE_EXPORT_REVOKED');return {rows:data.filter(r=>r.capture_id>args[1]).slice(0,args[2])};}
 if(sql.includes('export_member'))runs.get(id).members.push(args[1]);
 if(sql.includes('finish_export')){const r=runs.get(id);if(r.state!=='building')throw Error('CAPTURE_EXPORT_REVOKED');assert.equal(args[1].games,r.members.length);r.state='ready';r.manifest=args[1];}
 if(sql.includes('revoke_export'))runs.get(id).state='revoked';
 if(sql.includes('export_status'))return {rows:[{value:runs.get(id)}]};return {rows:[]};
 }};}
async function setup(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gameplay-export-'));await fs.chmod(dir,0o700);t.after(()=>fs.rm(dir,{recursive:true,force:true}));return {directory:dir,key:crypto.randomBytes(32),keyId:'test-key',pseudonymKey:crypto.randomBytes(32),splitSeed:'frozen-test-v1',privacyEpoch:0};}
async function read(db,result,opts){const a=[];for await(const r of X.readDataset(db,{...opts,...result}))a.push(r);return a;}
test('D4 family/action/state canonicalization is invariant, not visual-row-major',()=>{
 const p=JSON.parse(rows(1)[0].payload),state=C.replay(p.moves.slice(0,10).map(m=>({b:m.b,c:m.c,player:m.symbol})));
 for(let i=0;i<8;i++){const x=structuredClone(p);x.moves=x.moves.map(m=>({...m,...E.mapMove(m,i)}));assert.equal(X.family(x),X.family(p));assert.equal(X.stateKey(E.transform(state,i)),X.stateKey(state));}
 assert.notEqual(E.spatial(0,3),3);
});
test('deterministic private dataset, all qualifications withheld, legal labelled positions and complete archives',async t=>{
 const options=await setup(t),data=rows(50),db=fake(data);const a=await X.exportDataset(db,options),b=await X.exportDataset(db,options);
 assert.equal(a.manifest.plainSha256,b.manifest.plainSha256);assert.notEqual(a.manifest.cipherSha256,b.manifest.cipherSha256);assert.ok(a.manifest.stats.qualificationWithheld>0);
 const records=await read(db,a,options),games=new Map();for(const r of records){assert.notEqual(r.split,'qualification');if(r.type==='game'){games.set(r.gameId,r);assert.equal(C.replay(r.moves.map(m=>({b:m.b,c:m.c,player:m.symbol}))).winner,r.game.boardWinner);assert.ok(!Object.hasOwn(r.game,'startedAt'));}if(r.type==='position'){assert.equal(r.legalMask[r.observedAction],1);assert.equal(r.searchPolicy,null);assert.equal(r.split,games.get(r.gameId).split);assert.ok(r.ply>=6);}}
 const raw=JSON.stringify(records);assert.ok(!raw.includes('test_alice'));assert.ok(!raw.includes('synthetic_'));for(const row of data)assert.ok(!raw.includes(row.capture_id));
 assert.equal((await fs.readdir(options.directory)).filter(x=>x.startsWith('.index-')).length,0);
});
test('cross-split transpositions and symmetry duplicates never emit conflicting sample memberships',async t=>{
 const options=await setup(t),data=rows(50);const dup=structuredClone(data.find(r=>X.splitFor(X.family(JSON.parse(r.payload)),options.splitSeed)>0));dup.capture_id='f'.repeat(64);data.push(dup);data.sort((a,b)=>a.capture_id.localeCompare(b.capture_id));
 const db=fake(data),out=await X.exportDataset(db,options);assert.ok(out.manifest.stats.duplicates>=1);const assigned=new Map(),g=new Map();
 for(const r of await read(db,out,options)){if(r.type==='game')g.set(r.gameId,r);if(r.type==='position'){const p=g.get(r.gameId);const s=C.replay(p.moves.slice(0,r.ply).map(m=>({b:m.b,c:m.c,player:m.symbol}))),k=X.stateKey(s);if(assigned.has(k))assert.equal(assigned.get(k),r.split);assigned.set(k,r.split);}}
});
test('unknown/test population excluded, corruption fails closed, and revoked export cannot be read',async t=>{
 const options=await setup(t),data=rows(2);const p=JSON.parse(data[0].payload);p.provenance.population='unknown';data[0].payload=C.stable(p);data[0].payload_sha256=C.sha256(p);
 const db=fake(data),out=await X.exportDataset(db,options);assert.equal(out.manifest.stats.excludedPopulation,1);db.runs.get(out.runId).state='revoked';await assert.rejects(read(db,out,options),/CAPTURE_EXPORT_REVOKED/);assert.equal((await X.purgeRevoked(db,options.directory)).purged,1);
 data[1].payload_sha256='0'.repeat(64);await assert.rejects(X.exportDataset(fake(data),options),/CAPTURE_HASH/);
});
test('aborted preparation revokes its receipt and retains no scratch/plaintext/export file',async t=>{
 const o=await setup(t),controller=new AbortController();controller.abort();const db=fake(rows(1));await assert.rejects(X.exportDataset(db,{...o,signal:controller.signal}),/CAPTURE_EXPORT_ABORTED/);assert.deepEqual(await fs.readdir(o.directory),[]);assert.ok([...db.runs.values()].every(r=>r.state==='revoked'));
});

test('revoking privacy eligibility mid-stream prevents even the next record from reaching a reader',async t=>{
 const options=await setup(t),db=fake(rows(30)),out=await X.exportDataset(db,options);
 const it=X.readDataset(db,{...options,...out})[Symbol.asyncIterator]();
 const first=await it.next();assert.equal(first.done,false);
 db.runs.get(out.runId).state='revoked';
 await assert.rejects(it.next(),/CAPTURE_EXPORT_REVOKED/);
 await it.return?.();
});

test('privacy epoch changes during streaming immediately fence further records',async t=>{
 const options=await setup(t),db=fake(rows(30)),out=await X.exportDataset(db,options);
 const it=X.readDataset(db,{...options,...out})[Symbol.asyncIterator]();
 assert.equal((await it.next()).done,false);
 db.runs.get(out.runId).privacyEpoch=1;
 await assert.rejects(it.next(),/CAPTURE_EXPORT_REVOKED/);
 await it.return?.();
});
