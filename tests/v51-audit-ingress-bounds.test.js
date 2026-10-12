'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createCoreServiceIngress, signRequest } = require('../packages/services/core-gateway.js');

const secret = 'v51-audit-body-size-test-secret';
const MAX = 100 * 1024;
const ingress = createCoreServiceIngress({
  secret,
  leaderboard: async () => [{ id: 'public' }],
});

function mockResponse() {
  const headers = {};
  const res = {
    statusCode: 200,
    setHeader: (key, value) => { headers[key.toLowerCase()] = value; },
    end: (chunk) => { res.body = JSON.parse(chunk); },
  };
  return { res, headers };
}

function request(base, body, { declared = true, signed = false } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json', connection: 'close' };
    if (declared) headers['content-length'] = Buffer.byteLength(body);
    if (signed) {
      const timestamp = String(Date.now());
      Object.assign(headers, {
        'x-service-timestamp': timestamp,
        'x-service-signature': signRequest({ secret, timestamp, path: '/ingress/leaderboard', bodyString: body }),
      });
    }
    const req = http.request(base + '/ingress/leaderboard', { method: 'POST', agent: false, headers }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

let server;
let address;
test.before(async () => {
  server = http.createServer(ingress);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  address = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
});

test('rejects unsigned declared body over ingress limit without buffering', async () => {
  const result = await request(address, 'x'.repeat(MAX + 1));
  assert.equal(result.status, 413);
  assert.equal(result.data.error, 'INGRESS_BODY_TOO_LARGE');
  assert.equal(result.headers.connection, 'close');
});

test('rejects streamed chunked body when actual length exceeds limit', async () => {
  const result = await request(address, 'x'.repeat(MAX + 1), { declared: false });
  assert.equal(result.status, 413);
  assert.equal(result.data.error, 'INGRESS_BODY_TOO_LARGE');
});

test('rejects oversized signed payload before dispatch', async () => {
  const result = await request(address, JSON.stringify({ payload: 'x'.repeat(MAX) }), { signed: true });
  assert.equal(result.status, 413);
  assert.equal(result.data.error, 'INGRESS_BODY_TOO_LARGE');
});

test('rejects oversized pre-parsed and rawBody without processing', async () => {
  for (const field of ['body', 'rawBody']) {
    const { res, headers } = mockResponse();
    await ingress({ method: 'POST', url: '/ingress/leaderboard', headers: {}, [field]: 'x'.repeat(MAX + 1) }, res);
    assert.equal(res.statusCode, 413, field);
    assert.equal(res.body.error, 'INGRESS_BODY_TOO_LARGE', field);
    assert.equal(headers.connection, 'close', field);
  }
});

test('accepts a bounded valid signed leaderboard query', async () => {
  const result = await request(address, JSON.stringify({ metric: 'rating' }), { signed: true });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.result, [{ id: 'public' }]);
});
