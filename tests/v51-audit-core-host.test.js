'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCoreIngressServer } = require('../apps/game-core/ingress-server.js');
const { createCoreGateway } = require('../packages/services/core-gateway.js');

const secret = 'v51-core-test-long-service-secret';
const pool = { async query() { return { rows:[{id:'svc_alice',username:'Alice',rating:'1520.75',tier:'gold',region:'IN',games:21}] }; } };
const coreService = { async run(actor, key, command) { return {principal:actor.actor,opKey:key,command}; } };
const common = { coreService, pool, secret };

test('Core ingress host rejects unauthorized network binds and API-role credential injection', () => {
  assert.throws(() => createCoreIngressServer({...common,host:'0.0.0.0'}), /INGRESS_BIND_REQUIRES_EXPLICIT_APPROVAL/);
  assert.throws(() => createCoreIngressServer({...common,apiPool:pool}), /CORE_API_ROLE_CREDENTIAL_FORBIDDEN/);
  assert.throws(() => createCoreIngressServer({...common,ticketIssuer:{issue(){}}}), /CORE_API_ROLE_CREDENTIAL_FORBIDDEN/);
  assert.throws(() => createCoreIngressServer({...common,secret:'secret'}), /INGRESS_SECRET_REQUIRED/);
  assert.throws(() => createCoreIngressServer({...common,port:-1}), /INGRESS_PORT_INVALID/);
});

test('standalone Core HTTP listener handles signed rankings/commands but cannot mint tickets', async () => {
  const host = createCoreIngressServer(common);
  const address = await host.listen();
  const url = 'http://' + address.host + ':' + address.port;
  try {
    const gateway = createCoreGateway({coreUrl:url,secret});
    const rankings = await gateway.leaderboard({metric:'rating',scope:'local',region:'IN',league:'gold'});
    assert.deepEqual(rankings.map(row=>row.id),['svc_alice']);
    assert.equal(rankings[0].rating,1520.75);
    const result = await gateway.forwardCommand({actor:'svc_alice',opKey:'test-operation-1',command:{type:'move',id:'match-1',move:{b:0,c:0}}});
    assert.equal(result.principal,'svc_alice');
    assert.equal(result.opKey,'test-operation-1');
    await assert.rejects(gateway.requestTicket({actor:'svc_alice',session:{sessionId:'f'.repeat(24),generation:1,connectionClass:'browser'}}),
      err=>err.status===503 && err.message==='TICKET_ISSUER_UNAVAILABLE');
    const unsigned = await fetch(url+'/ingress/leaderboard',{method:'POST',body:'{}'});
    assert.equal(unsigned.status,401);
  } finally { await host.close(); }
});
