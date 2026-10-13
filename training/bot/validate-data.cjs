'use strict';
// Canonical dataset validator. Streams the file (hash computed incrementally, rows parsed line by line)
// so large corpora (>512 MB) validate without hitting Node's string limit. Verifies the manifest hash,
// per-row replay against the canonical rules, encoding equivalence, target shapes and family-safe
// splits; enforces the reserved qualification split; and lightly validates external-corpus rows
// (utttai-converted) that carry no game-level fields.
const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const G=require('../../src/game.js'),E=require('../../src/bot/encoding.js'),Data=require('./generate.cjs');
function validate(file){
 const manifest=JSON.parse(fs.readFileSync(file+'.manifest.json','utf8'));
 const hash=crypto.createHash('sha256');
 const groups=new Map(),families=new Map();let external=0,records=0;
 const buf=Buffer.alloc(1<<20);
 const fd=fs.openSync(file,'r');let carry='';
 const handle=(line)=>{ if(!line.trim())return; records++; const row=JSON.parse(line);
  assert.equal(row.encodingVersion,E.VERSION);
  if(row.externalSplit||row.external){external++;assert.equal(row.externalSplit||row.split,'external');assert.equal(row.planes.length,648);assert.equal(row.legalMask.length,81);assert.equal(row.visitTarget.length,81);assert.ok(Math.abs(row.visitTarget.reduce((a,b)=>a+b,0)-1)<1e-6,'external visit target sums to 1');assert.ok(Number.isFinite(row.valueTarget)&&row.valueTarget>=-1&&row.valueTarget<=1,'external value in range');for(let i=0;i<81;i++)if(row.visitTarget[i]>0)assert.ok(row.legalMask[i],'external visit mass only on legal moves');return;}
  const reserve=manifest.qualificationReserve||0;
  assert.equal(row.split,Data.splitFor(row.openingFamily,reserve),'split must match the canonical splitFor (incl. qualification reserve)');
  assert.equal(families.get(row.openingFamily)||row.split,row.split);families.set(row.openingFamily,row.split);
  if(!groups.has(row.gameId))groups.set(row.gameId,[]);groups.get(row.gameId).push(row);
  let state=G.create(row.first);for(const m of row.moves){assert.equal(m.player,state.turn);state=G.apply(state,m);}assert.equal(state.moves.length,row.revision);assert.equal(state.turn,row.player);assert.equal(state.winner,null);
  const e=E.encode(state);assert.deepEqual([...e.planes],row.planes);assert.deepEqual([...e.mask],row.legalMask);
  assert.equal(row.visitTarget.length,81);assert.ok(Math.abs(row.visitTarget.reduce((a,b)=>a+b,0)-1)<1e-6);row.visitTarget.forEach((p,i)=>assert.ok(Number.isFinite(p)&&p>=0&&p<=1&&(!p||e.mask[i])));
  G.apply(state,row.playedMove);
  if((row.valueTargetSource||'terminal-outcome')==='terminal-outcome')assert.equal(row.valueTarget,E.value(row.terminalOutcome,row.player));else{assert.ok(Number.isFinite(row.valueTarget)&&row.valueTarget>=-1&&row.valueTarget<=1,'value target range');assert.equal(row.terminalValue,E.value(row.terminalOutcome,row.player));}
 };
 try{ let n; while((n=fs.readSync(fd,buf,0,buf.length))>0){ hash.update(buf.subarray(0,n)); carry+=buf.toString('utf8',0,n); let idx; while((idx=carry.indexOf('\n'))>=0){ handle(carry.slice(0,idx)); carry=carry.slice(idx+1); } } if(carry.trim())handle(carry); } finally{ fs.closeSync(fd); }
 for(const gameRows of groups.values()){const first=gameRows[0];assert.equal(first.openingFamily,Data.family(first.moves));let state=G.create(first.first);for(const m of first.moves)state=G.apply(state,m);for(const row of gameRows){assert.equal(row.gameId,first.gameId);assert.equal(row.split,first.split);assert.equal(row.openingFamily,first.openingFamily);assert.deepEqual(row.moves,state.moves);state=G.apply(state,row.playedMove);}assert.ok(state.winner);for(const row of gameRows){assert.equal(row.terminalOutcome,state.winner);assert.equal(row.completeGameMoves,state.moves.length);}}
 assert.equal(hash.digest('hex'),manifest.sha256,'dataset hash');
 assert.equal(records,manifest.records);
 return {records,games:groups.size,families:families.size,qualificationFamilies:[...families.values()].filter(v=>v==='qualification').length,externalRows:external,canonical:true};
}
module.exports={validate};if(require.main===module)console.log(JSON.stringify(validate(process.argv[2])));
