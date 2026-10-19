'use strict';
/* 1.0.8 APK cross-layer API contract: the page, network.js and authoritative Core router
 * must agree on path, payload and idempotency key. No live credentials or provider calls.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/network.js'), 'utf8');
const monetization = fs.readFileSync(path.join(root, 'apps/api/routes/monetization.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
const createNetwork = (rootOptions = {}) => {
  const context = { ...rootOptions, URLSearchParams, AbortController, setTimeout, clearTimeout };
  vm.runInNewContext(source, context, { filename: 'src/network.js' });
  return context.MegaNetwork;
};

test('signed-in APK power purchase addresses canonical Core route and names the server itemId', async () => {
  const calls = [];
  const net = createNetwork({
    MegaAccount: {
      request: async (url, body, opKey) => {
        calls.push({url,body,opKey});
        return {spent:2};
      },
    },
  });
  assert.equal((await net.powersSpend('undo', 'purchase-op-1')).spent, 2);
  assert.equal((await net.powersSpend('hint', 'purchase-op-2')).spent, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    {url:'/api/monetization/powers/spend',body:{itemId:'undo'},opKey:'purchase-op-1'},
    {url:'/api/monetization/powers/spend',body:{itemId:'hint'},opKey:'purchase-op-2'},
  ]);
  assert.match(monetization, /'\/api\/monetization\/powers\/spend':\s*\{\s*op:\s*'power_spend',\s*method:\s*'POST',\s*args:\s*\['itemId'\]/);
  assert.match(app, /NET\.powersSpend\(kind,id\)/);
});

test('regular competitive requests retain the legacy /api/v1 prefix', async () => {
  const paths = [];
  const net = createNetwork({MegaAccount:{request:async url=>{paths.push(url);return {ok:true};}}});
  await net.profile();
  await net.queue('casual','queue-op-1');
  await net.match('match1');
  assert.deepEqual(Array.from(paths),['/api/v1/profile','/api/v1/queue','/api/v1/match/match1']);
});

test('without a linked host, the same-origin fallback still calls the canonical power route', async () => {
  const urls=[],headers=[];
  const net = createNetwork({
    fetch: async (url, init) => {
      urls.push(url);headers.push(init.headers);
      return {ok:true,json:async()=>({success:true})};
    },
  });
  const result=await net.powersSpend('hint','purchase-op-3');
  assert.equal(result.success,true);
  assert.deepEqual(urls,['/api/monetization/powers/spend']);
  assert.equal(headers[0]['Idempotency-Key'],'purchase-op-3');
});

test('the archived legacy cosmetics route must not be mistaken for the modern rewards catalog', () => {
  const contracts=fs.readFileSync(path.join(root,'packages/contracts/routes.js'),'utf8');
  assert.match(contracts,/route\('v1\.cosmetic'.*archived product path; production returns 404/);
  assert.match(app,/NET\.cosmetic\(v,opId\(\)\)/);
  // Deliberately NOT remapped here: historic Coin purchases and Cosmetic Credits are distinct
  // economies and require an owner-approved product migration, not a silent redirect.
});
