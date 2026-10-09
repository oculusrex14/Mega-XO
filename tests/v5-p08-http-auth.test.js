'use strict';

/*
 * P08 post-gate HTTP recovery auth regression.
 * Uses a REAL local Node HTTP server but NO external PostgreSQL/Redis/provider.
 * Deliberately stubbed readMatch represents only the authenticated transport
 * boundary. Actual durable membership and session revocation remain integration
 * responsibilities of Core + the caller-supplied authenticateHttp perimeter.
 */
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {createRealtimeTransport}=require('../packages/services/realtime-transport');

async function serve(t, authenticateHttp) {
  const reads=[];
  const server=http.createServer((req,res)=>{
    /* request listeners run synchronously on Node: the host must yield exactly
     * the two asynchronous fallback paths, even while headersSent is false. */
    if(req.url.startsWith('/realtime/v1/snapshot') ||
       req.url.startsWith('/realtime/v1/match/'))return;
    res.writeHead(404);res.end('unrelated');
  });
  const config={
    server,
    pool:{withTransaction:async()=>{throw Error('UNUSED_POOL_IN_UNIT_TEST')}},
    core:{
      readMatch:async(actor,id)=>{
        reads.push({actor,id});
        if(actor!=='svc_alice')throw Error('NOT_PARTICIPANT');
        return {revision:2,status:'PLAYING',symbols:{X:'svc_alice',O:'svc_bob'},
          state:{moves:[]}};
      },
      run:async()=>{throw Error('NO_WRITES_PERMITTED')},
    },
  };
  if(authenticateHttp!==undefined)config.authenticateHttp=authenticateHttp;
  const transport=createRealtimeTransport(config);
  await new Promise((resolve,reject)=>{
    server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
  });
  t.after(async()=>{
    await transport.close();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
  });
  return {port:server.address().port,reads,transport};
}
function request(port,path,{authorization=null,method='GET'}={}) {
  return new Promise((resolve,reject)=>{
    const req=http.request({
      host:'127.0.0.1',port,path,method,
      headers:authorization===null?{}:{authorization},
      timeout:2500,
    },res=>{
      const parts=[];
      res.on('data',part=>parts.push(part));
      res.on('end',()=>{
        const raw=Buffer.concat(parts).toString('utf8');
        let json=null;
        if(raw){try{json=JSON.parse(raw)}catch{}}
        resolve({status:res.statusCode,json,raw,headers:res.headers});
      });
    });
    req.on('timeout',()=>req.destroy(Error('HTTP_SNAPSHOT_TEST_TIMEOUT')));
    req.on('error',reject);req.end();
  });
}
const url='/realtime/v1/snapshot?match_id=match:test-001&actor=svc_alice';

test('no configured HTTP authenticator refuses every private snapshot even with a participant actor query',async t=>{
  const s=await serve(t);
  const response=await request(s.port,url);
  assert.equal(response.status,401);
  assert.equal(response.json.code,'AUTH_REQUIRED');
  assert.deepEqual(s.reads,[],'no durable match lookup was attempted');
  const alias=await request(s.port,'/realtime/v1/match/match:test-001?actor=svc_alice');
  assert.equal(alias.status,401);
  assert.deepEqual(s.reads,[]);
});

test('only a verified host principal can read; URL actor is mismatch assertion, not authority',async t=>{
  const s=await serve(t,async req=>
    req.headers.authorization==='Bearer valid-alice'?{actor:'svc_alice'}:null);
  for(const bad of [null,'Bearer invalid','Bearer svc_alice']){
    const refused=await request(s.port,url,{authorization:bad});
    assert.equal(refused.status,401);
  }
  const mismatch=await request(s.port,
    '/realtime/v1/snapshot?match_id=match:test-001&actor=svc_bob',
    {authorization:'Bearer valid-alice'});
  assert.equal(mismatch.status,403);
  assert.deepEqual(s.reads,[],'forged query was refused before Core');
  const accepted=await request(s.port,url,{authorization:'Bearer valid-alice'});
  assert.equal(accepted.status,200);
  assert.equal(accepted.json.snapshot.revision,2);
  assert.deepEqual(s.reads,[{actor:'svc_alice',id:'match:test-001'}]);
  const noQueryActor=await request(s.port,'/realtime/v1/match/match:test-001',
    {authorization:'Bearer valid-alice'});
  assert.equal(noQueryActor.status,200,'caller identity comes from verifier, not URL');
});

test('revoked/invalid sessions and failed authentication backend fail closed',async t=>{
  const s=await serve(t,async req=>{
    switch(req.headers.authorization){
      case 'Bearer revoked':throw Error('SESSION_REVOKED');
      case 'Bearer provider-down':throw Error('database unavailable');
      case 'Bearer empty':return {actor:''};
      case 'Bearer malformed':return 'svc_alice';
      case 'Bearer unrelated':return {actor:'svc_bob'};
      default:return null;
    }
  });
  for(const [token,status] of [
    ['Bearer revoked',401],['Bearer provider-down',503],
    ['Bearer empty',401],['Bearer malformed',401],
    ['Bearer unrelated',403],
  ]){
    const observed=await request(s.port,url,{authorization:token});
    assert.equal(observed.status,status,token);
  }
  assert.deepEqual(s.reads,[{actor:'svc_bob',id:'match:test-001'}],
    'Core checks participant authorization after valid host-authenticated identity');
});

test('HEAD fallback stays authenticated and unrelated host routes remain unchanged',async t=>{
  const s=await serve(t,async req=>
    req.headers.authorization==='Bearer alice'?{actor:'svc_alice'}:null);
  const refused=await request(s.port,url,{method:'HEAD'});
  assert.equal(refused.status,401);
  const allowed=await request(s.port,url,{method:'HEAD',authorization:'Bearer alice'});
  assert.equal(allowed.status,200);
  assert.equal(allowed.raw,'');
  const unrelated=await request(s.port,'/healthz');
  assert.equal(unrelated.status,404);
});

test('unsafe nonfunction HTTP auth configuration is rejected at construction',()=>{
  const server=http.createServer();
  assert.throws(()=>createRealtimeTransport({
    server,pool:{withTransaction:async()=>{}},
    core:{readMatch:async()=>({revision:0}),run:async()=>{}},
    authenticateHttp:'svc_alice',
  }),/HTTP_AUTHENTICATOR_INVALID/);
  /* This server never listened and owns no resources to close. */
});
