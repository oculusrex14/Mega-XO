'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');

test('native leaderboard and preference requests translate retained country labels to ISO codes',async()=>{
 const calls=[];
 const host={MegaAccount:{request:async(...args)=>{calls.push(args);return [];}}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../src/network.js'),'utf8'),{globalThis:host,URLSearchParams});
 await host.MegaNetwork.leaderboard({scope:'global',region:'India',league:'all',metric:'rating'});
 assert.equal(new URL(calls.at(-1)[0],'https://megaxo.online').searchParams.get('region'),'');
 for(const [name,code] of [['India','IN'],['Australia','AU'],['United States','US'],['United Kingdom','GB'],['DE','DE']]){
  await host.MegaNetwork.leaderboard({scope:'local',region:name,league:'all',metric:'rating'});
  assert.equal(new URL(calls.at(-1)[0],'https://megaxo.online').searchParams.get('region'),code);
  await host.MegaNetwork.preferences({region:name,wealthPublic:false},'operation');
  assert.equal(calls.at(-1)[1].changes.region,code);
  assert.equal(calls.at(-1)[1].changes.wealthPublic,false);
 }
});
