'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {TransactionalEmail,DEFAULT_FROM}=require('../server/email-provider');

test('transactional email sends branded OTP through Resend with idempotency',async()=>{
 let call;const fetcher=async(url,options)=>{call={url,options};return new Response(JSON.stringify({id:'email-1'}),{status:200,headers:{'Content-Type':'application/json'}});};
 const mail=new TransactionalEmail({apiKey:'re_test',fetcher});const out=await mail.sendOtp({to:'player@example.com',code:'123456',purpose:'signup',idempotencyKey:'otp/1'});
 assert.equal(out.id,'email-1');assert.equal(call.url,'https://api.resend.com/emails');assert.equal(call.options.headers.Authorization,'Bearer re_test');assert.equal(call.options.headers['Idempotency-Key'],'otp/1');
 const body=JSON.parse(call.options.body);assert.equal(body.from,DEFAULT_FROM);assert.deepEqual(body.to,['player@example.com']);assert.match(body.subject,/Verify your Mega XO email/);assert.match(body.text,/123456/);assert.match(body.text,/Antimatter Innovations/);assert.match(body.html,/123456/);
});

test('reset OTP and password-changed notice use the Antimatter Innovations identity',async()=>{
 const bodies=[];const fetcher=async(url,options)=>{bodies.push(JSON.parse(options.body));return new Response(JSON.stringify({id:'ok'}),{status:200,headers:{'Content-Type':'application/json'}});};
 const mail=new TransactionalEmail({apiKey:'re_test',fetcher});
 await mail.sendOtp({to:'player@example.com',code:'654321',purpose:'reset'});await mail.sendPasswordChanged({to:'player@example.com'});
 assert.match(bodies[0].subject,/Reset your Mega XO password/);assert.match(bodies[0].html,/Antimatter Innovations/);assert.match(bodies[1].subject,/password was changed/);assert.match(bodies[1].html,/contact@antimatterinnovations.com/);
});

test('production email refuses to pretend delivery without a configured API key',async()=>{
 const mail=new TransactionalEmail({apiKey:'',fetcher:async()=>{throw Error('should not call');}});assert.equal(mail.enabled(),false);await assert.rejects(()=>mail.sendOtp({to:'x@example.com',code:'123456',purpose:'signup'}),/EMAIL_DELIVERY_NOT_CONFIGURED/);
});
