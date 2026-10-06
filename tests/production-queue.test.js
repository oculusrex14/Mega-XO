'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {QueueSession}=require('../server/queue-session');
test('queue heartbeat cleanup deserializes the aggregate only once for unchanged results',()=>{
 let reads=0,now=1000000;const store={read:()=>{reads++;return {view:id=>({id,status:'PLAYING'})};}};
 const queue=new QueueSession({store,now:()=>now});for(let i=0;i<100;i++)queue.results.set('p'+i,{matchId:'m'+i});
 queue._clean();assert.equal(reads,1);assert.equal(queue.results.size,100);
});
test('idle queue terminal and heartbeat records expire without changing active tickets',()=>{
 let now=1000000;const queue=new QueueSession({store:{read:()=>({})},now:()=>now});
 queue.seen.set('idle',now);queue._terminal('idle',{state:'cancelled'});now+=300001;
 queue.tickets.set('active',{actor:'active',joinedAt:now});queue.seen.set('active',now);queue._clean();
 assert(!queue.seen.has('idle'));assert(!queue.terminal.has('idle'));assert(queue.tickets.has('active'));
});
