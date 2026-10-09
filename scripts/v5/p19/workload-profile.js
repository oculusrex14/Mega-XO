#!/usr/bin/env node
'use strict';

/**
 * P19-01: reproducible bounded workload planner, not a throughput test.
 * There is no approved customer-traffic forecast. These weights are
 * ILLUSTRATIVE test coverage only, not predicted demand or launch targets.
 * Integrated HTTP/WebSocket/worker adapters must replace dry-run operations
 * after P18 acceptance. No production or public endpoint is contacted.
 */
const fs = require('node:fs');

const OPERATIONS = Object.freeze([
  Object.freeze({name:'api_read',weight:18,consumer:'API',status:'INTEGRATION_REQUIRED'}),
  Object.freeze({name:'auth_refresh',weight:10,consumer:'API',status:'INTEGRATION_REQUIRED'}),
  Object.freeze({name:'socket_heartbeat',weight:18,consumer:'Core',status:'INTEGRATION_REQUIRED'}),
  Object.freeze({name:'game_move',weight:19,consumer:'Core',status:'INTEGRATION_REQUIRED'}),
  Object.freeze({name:'queue_join',weight:13,consumer:'Core',status:'INTEGRATION_REQUIRED'}),
  Object.freeze({name:'tournament_read',weight:8,consumer:'Core',status:'INTEGRATION_REQUIRED'}),
  Object.freeze({name:'worker_poll',weight:7,consumer:'worker',status:'INTEGRATION_REQUIRED'}),
  Object.freeze({name:'store_callback',weight:4,consumer:'worker',status:'SANDBOX_FIXTURE_ONLY'}),
  Object.freeze({name:'ad_callback',weight:3,consumer:'worker',status:'SANDBOX_FIXTURE_ONLY'})
]);
const TIERS = Object.freeze([
  Object.freeze({name:'smoke',clients:1,offeredOps:20}),
  Object.freeze({name:'warm',clients:2,offeredOps:40}),
  Object.freeze({name:'ramp',clients:4,offeredOps:80}),
  Object.freeze({name:'ceiling_candidate',clients:8,offeredOps:120})
]);
const MAX_CLIENTS=8,MAX_OPS=120;
function reject(msg){ throw Error('P19_WORKLOAD_REFUSED: '+msg); }
function random(seed) {
  if(!Number.isSafeInteger(seed)||seed<1||seed>0x7fffffff)reject('positive bounded seed required');
  let state=seed>>>0;
  return ()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/4294967296;};
}
function enumerate(ops,seed=1919){
  if(!Number.isSafeInteger(ops)||ops<1||ops>MAX_OPS)reject('number of operations must be bounded');
  const weight=OPERATIONS.reduce((n,o)=>n+o.weight,0);
  if(weight!==100||new Set(OPERATIONS.map(o=>o.name)).size!==OPERATIONS.length)reject('unsafe workload definition');
  const weighted=OPERATIONS.map(o=>({name:o.name,n:Math.floor(ops*o.weight/100),remainder:(ops*o.weight)%100}));
  let assigned=weighted.reduce((n,o)=>n+o.n,0);
  for(const entry of [...weighted].sort((a,b)=>b.remainder-a.remainder||a.name.localeCompare(b.name))) {
    if(assigned===ops)break;
    entry.n++;assigned++;
  }
  if(assigned!==ops)reject('workload attribution incomplete');
  const items=weighted.flatMap(o=>Array.from({length:o.n},()=>o.name));
  const next=random(seed);
  for(let i=items.length-1;i>0;i--){const j=Math.floor(next()*(i+1));[items[i],items[j]]=[items[j],items[i]];}
  return items;
}
function plan({seed=1919,tiers=TIERS}={}){
  if(!Array.isArray(tiers)||tiers.length<1||tiers.length>TIERS.length)reject('tier count invalid');
  const names=new Set();
  const results=tiers.map((t,index)=>{
    if(!t||typeof t!=='object'||Array.isArray(t)||Object.keys(t).sort().join(',')!=='clients,name,offeredOps') {
      reject('unrecognized tier definition');
    }
    if(t.name!==TIERS[index].name||names.has(t.name))reject('tiers must use the reviewed fixed order');
    names.add(t.name);
    if(!Number.isSafeInteger(t.clients)||t.clients<1||t.clients>MAX_CLIENTS||
       !Number.isSafeInteger(t.offeredOps)||t.offeredOps<1||t.offeredOps>MAX_OPS)reject('unsafe load capacity');
    const mix=enumerate(t.offeredOps,seed+index);
    return {name:t.name,clients:t.clients,offeredOps:t.offeredOps,
      operations:Object.fromEntries(OPERATIONS.map(o=>[o.name,mix.filter(name=>name===o.name).length])),
      executed:false};
  });
  return {
    schema:'mega-v5-p19-illustrative-workload/v1',
    status:'UNEXECUTED_PROFILE_NOT_CAPACITY',
    sourceTrafficForecast:'UNKNOWN',
    workloadWeights:'ILLUSTRATIVE_COVERAGE_NOT_PREDICTION',
    executionPermitted:false,
    maxSyntheticClients:MAX_CLIENTS,
    operations:OPERATIONS,
    tiers:results,
    unimplementedRealTransports:[
      'staged Vercel API auth/read',
      'Core WebSocket reconnect/game/matchmaking',
      'real tournament fixture and escrow',
      'worker outbox latency and retries',
      'signed provider callback sandbox'
    ],
    g19Accepted:false
  };
}
if(require.main===module){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--plan')reject('usage: workload-profile.js --plan');
    process.stdout.write(JSON.stringify(plan(),null,2)+'\n');
  }catch(e){process.stderr.write(e.message+'\n');process.exitCode=2;}
}
module.exports={OPERATIONS,TIERS,MAX_CLIENTS,MAX_OPS,random,enumerate,plan};
