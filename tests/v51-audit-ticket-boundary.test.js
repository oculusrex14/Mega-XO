'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {handleTicket}=require('../apps/api/routes/competitive.js');
function fixture(){
  const binding={actor:'svc_alice',sessionId:'f'.repeat(24),generation:2,connectionClass:'browser'};
  const accounts={requireLinked:async()=>({actor:binding.actor}),accessBinding:async()=>binding};
  const req={method:'POST',url:'/api/v1/ticket',headers:{authorization:'Bearer linked-token'},body:{matchScope:'match-7'}};
  const res={statusCode:200,setHeader(){},end(s){this.body=JSON.parse(s);}};
  return {binding,accounts,req,res};
}
test('API-owned ticket issuer receives only bound session authority',async()=>{
  const {binding,accounts,req,res}=fixture();
  const inputs=[];
  const context={accounts,ticketIssuer:{issue:async input=>{inputs.push(input);return{ticket:'random-ticket',expiresAt:Date.now()+10000};}},
    coreGateway:{requestTicket:()=>{throw Error('CORE_MUST_NOT_ISSUE_TICKETS');}}};
  await handleTicket(context,req,res);
  assert.equal(res.statusCode,200);
  assert.equal(res.body.ticket,'random-ticket');
  assert.deepEqual(inputs,[{actor:binding.actor,sessionId:binding.sessionId,generation:2,connectionClass:'browser',matchScope:'match-7'}]);
});
test('unconfigured issuer fails closed, never falls back to Core',async()=>{
  const {accounts,req,res}=fixture();
  const context={accounts,coreGateway:{requestTicket:()=>{throw Error('CORE_MUST_NOT_ISSUE_TICKETS');}}};
  await assert.rejects(handleTicket(context,req,res),e=>e.status===503&&e.message==='TICKET_ISSUER_UNAVAILABLE');
});
test('ticket actor, session and issuer settings cannot be supplied by an untrusted caller',async()=>{
  const {accounts,req,res}=fixture();
  let calls=0;const context={accounts,ticketIssuer:{issue:async()=>{calls++;return{ticket:'bad'};}}};
  for(const body of [{actor:'svc_bob'},{sessionId:'f'.repeat(24)},{generation:3},{connectionClass:'ios'},{environment:'prod'}]){
    await assert.rejects(handleTicket(context,{...req,body},res),e=>e.status===400);
  }
  assert.equal(calls,0);
});