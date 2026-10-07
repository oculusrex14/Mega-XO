/* Approved review-only competitive abuse signals (moved unchanged from server/competitive-abuse.js).
   Signals never block, punish, restrict Crown use or settle a result: they only label a match or
   room for human review. `now` is injected by the caller. */
'use strict';

const DAY=86400000;
const POLICY=Object.freeze({
 automationMinSamples:10,
 automationFastMs:250,
 automationVeryFastMs:100,
 automationFastRatio:.9,
 repeatPairWindow:7*DAY,
 repeatPairMatches:3,
 repeatPairForfeits:2,
 tournamentForfeits:5,
 concentratedForfeits:3
});

function add(set,value){if(value)set.add(value);}
function validTiming(x){return x&&typeof x.actor==='string'&&Number.isFinite(x.ms)&&x.ms>=0&&x.ms<=120000;}

function automationActors(samples=[]){
 const by=new Map();
 for(const sample of samples)if(validTiming(sample)){
  const list=by.get(sample.actor)||[];list.push(sample.ms);by.set(sample.actor,list);
 }
 const flagged=[];
 for(const [actor,times] of by){
  if(times.length<POLICY.automationMinSamples)continue;
  const fast=times.filter(ms=>ms<=POLICY.automationFastMs).length;
  const veryFast=times.filter(ms=>ms<=POLICY.automationVeryFastMs).length;
  if(fast/times.length>=POLICY.automationFastRatio&&veryFast>=3)flagged.push(actor);
 }
 return flagged.sort();
}

function matchSignals(match,players=[],now=Date.now()){
 const flags=new Set(match?.riskFlags||[]),actors={};
 if(!match||!Array.isArray(match.players))return {flags:[...flags],actors};
 const automated=automationActors(match._moveTimings||[]);
 if(automated.length){add(flags,'AUTOMATION_SPEED_REVIEW');actors.AUTOMATION_SPEED_REVIEW=automated;}
 if(match.quote?.rated&&players.length===2){
  const ids=match.players;
  let repeat=false,forfeit=false;
  for(let i=0;i<2;i++){
   const p=players[i],other=ids[1-i],recent=(p?.history||[]).filter(h=>h.id!==match.id&&h.rated&&h.opponent===other&&now-h.at>=0&&now-h.at<=POLICY.repeatPairWindow);
   if(recent.length+1>=POLICY.repeatPairMatches)repeat=true;
   const forfeits=recent.filter(h=>['resign','timeout','no-show'].includes(h.reason)).length+(['resign','timeout','no-show'].includes(match.receipt?.reason||match._pendingReason)?1:0);
   if(forfeits>=POLICY.repeatPairForfeits)forfeit=true;
  }
  if(repeat)add(flags,'REPEAT_RATED_PAIR_REVIEW');
  if(forfeit)add(flags,'REPEAT_FORFEIT_PAIR_REVIEW');
 }
 return {flags:[...flags].sort(),actors};
}

function tournamentSignals(room){
 const flags=new Set(room?.riskFlags||[]),actors={};
 if(!room||!Array.isArray(room.fixtures))return {flags:[...flags],actors};
 const forfeits=room.fixtures.filter(f=>['resign','no-show','timeout'].includes(f.reason));
 if(forfeits.length>=POLICY.tournamentForfeits)add(flags,'HIGH_FORFEIT_RATE');
 const byWinner=new Map(),byPair=new Map();
 for(const f of forfeits){
  if(f.winner)byWinner.set(f.winner,(byWinner.get(f.winner)||0)+1);
  if(Array.isArray(f.players)&&f.players.length===2){
   const key=f.players.slice().sort().join('|');byPair.set(key,(byPair.get(key)||0)+1);
  }
 }
 const concentrated=[...byWinner].filter(([,n])=>n>=POLICY.concentratedForfeits).map(([id])=>id).sort();
 if(concentrated.length){add(flags,'CONCENTRATED_FORFEITS_REVIEW');actors.CONCENTRATED_FORFEITS_REVIEW=concentrated;}
 if([...byPair.values()].some(n=>n>=2))add(flags,'REPEAT_PAIR_FORFEIT_REVIEW');
 const samples=[];
 for(const f of room.fixtures)for(const x of f._moveTimings||[])samples.push(x);
 const automated=automationActors(samples);
 if(automated.length){add(flags,'AUTOMATION_SPEED_REVIEW');actors.AUTOMATION_SPEED_REVIEW=automated;}
 return {flags:[...flags].sort(),actors};
}

module.exports={POLICY,automationActors,matchSignals,tournamentSignals};
