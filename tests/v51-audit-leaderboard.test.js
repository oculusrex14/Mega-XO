'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { materializeLeaderboardProjection, normalizeLeaderboardFilter } = require('../packages/services/read-cache.js');
const { createCoreServiceIngress, signRequest } = require('../packages/services/core-gateway.js');
const { handleGetLeaderboard } = require('../apps/api/routes/compat.js');

function fakePool() {
  const queries = [];
  return {
    queries,
    async query(sql, args) {
      queries.push({ sql, args });
      return { rows: [{ id:'svc_alice', tag:'A', username:'alice', displayName:'Alice',
        rating:'1650.25', tier:'silver', games:15, region:'IN', wealth:'90071992547409930' }] };
    },
  };
}
function response() {
  return { statusCode:200, headers:{},
    setHeader(k,v) { this.headers[k]=v; },
    end(s) { this.body=JSON.parse(s); } };
}

test('leaderboard builds independent parameterized rating and wealth projections', async () => {
  const pool = fakePool();
  const rating = (await materializeLeaderboardProjection(pool, { metric:'rating' })).data;
  const wealth = (await materializeLeaderboardProjection(pool, { metric:'wealth', scope:'local', region:'IN', league:'silver' })).data;
  assert.equal(rating[0].rating, 1650.25);
  assert.equal(rating[0].wealth, undefined);
  assert.equal(wealth[0].wealth, '90071992547409930');
  assert.notEqual(pool.queries[0].sql, pool.queries[1].sql);
  assert.match(pool.queries[0].sql, /r\.games >= 10/);
  assert.match(pool.queries[1].sql, /a\.wealth_public = true/);
  assert.match(pool.queries[1].sql, /p\.stats_visibility = 'public'/);
  assert.match(pool.queries[1].sql, /a\.region = \$1/);
  assert.match(pool.queries[1].sql, /r\.tier = \$2/);
  assert.deepEqual(pool.queries[1].args, ['IN', 'silver', 50]);
  assert.doesNotMatch(pool.queries[1].sql, /'IN'|'silver'/);
});

test('regional leaderboard with unknown region never falls back to global', async () => {
  const pool = fakePool();
  const projection = await materializeLeaderboardProjection(pool, { scope:'local', metric:'wealth' });
  assert.deepEqual(projection.data, []);
  assert.equal(pool.queries.length, 0);
  assert.deepEqual(normalizeLeaderboardFilter({scope:'region', region:'IN'}),
    {metric:'rating',scope:'local',league:'all',region:'IN'});
});

test('signed Core ingress rejects unsupported leaderboard fields and routes valid filters', async () => {
  for(const input of [null,[],{scope:'other'},{region:'USA'},{metric:'coins'},{league:'unknown'},{region:'in'}]) {
    assert.throws(() => normalizeLeaderboardFilter(input), {code:'INVALID_LEADERBOARD_QUERY'});
  }
  const secret = 'v51-leaderboard-filter-signed-core-secret';
  const received = [];
  const ingress = createCoreServiceIngress({secret,leaderboard:async filters => { received.push(filters); return []; }});
  async function signedRequest(body) {
    const raw = JSON.stringify(body);
    const timestamp = String(Date.now());
    const headers = { 'x-service-timestamp':timestamp,
      'x-service-signature':signRequest({secret,timestamp,path:'/ingress/leaderboard',bodyString:raw}) };
    const res = response();
    await ingress({method:'POST',url:'/ingress/leaderboard',headers,body:raw},res);
    return res;
  }
  for(const query of [{metric:'coins'},{scope:'other'},{league:'bad'},{region:'USA'},{region:'in'},{unknown:'value'}]) {
    const res = await signedRequest(query);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'INVALID_LEADERBOARD_QUERY');
  }
  const valid = await signedRequest({metric:'wealth',scope:'local',region:'IN',league:'silver'});
  assert.equal(valid.statusCode, 200);
  assert.deepEqual(received, [{metric:'wealth',scope:'local',region:'IN',league:'silver'}]);
});

test('API route normalizes and caches metrics, regions and leagues separately', async () => {
  const calls = [], stored = new Map();
  const context = {
    readCache:{get:k=>stored.get(k),set:(k,v)=>stored.set(k,v)},
    leaderboard:async filters => {calls.push(filters);return [{id:'svc_alice'}];},
  };
  for(const query of ['metric=rating','metric=wealth&scope=local&league=silver&region=IN','metric=wealth&scope=local&league=silver&region=IN']) {
    const res=response();
    await handleGetLeaderboard(context,{method:'GET',url:'/api/v1/leaderboard?'+query},res);
    assert.equal(res.statusCode,200);
  }
  assert.deepEqual(calls,[
    {metric:'rating',scope:'global',league:'all',region:''},
    {metric:'wealth',scope:'local',league:'silver',region:'IN'},
  ]);
  assert.equal(stored.size,2);
  const invalid=response();
  await handleGetLeaderboard(context,{method:'GET',url:'/api/v1/leaderboard?league=invalid'},invalid);
  assert.equal(invalid.statusCode,400);
});