'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { signRequest, verifyRequest } = require('../packages/services/core-gateway.js');

const secret = 'v51-audit-signature-test-secret';
const now = 1770000000000;
const request = {
  secret, timestamp: now, method: 'POST', path: '/ingress/command',
  actor: 'svc_alice', opKey: 'operation-1', bodyString: '{"command":{}}',
};
const signed = Object.freeze({ ...request, signature: signRequest(request) });

test('signed Core request verifies with a fixed clock function and the system-clock fallback', () => {
  assert.deepEqual(verifyRequest({ ...signed, now: () => now }), { valid: true });
  const live = { ...request, timestamp: Date.now() };
  assert.deepEqual(verifyRequest({ ...live, signature: signRequest(live) }), { valid: true });
});

test('signed Core request rejects stale, future, missing and forged timestamps', () => {
  for (const timestamp of [now - 30001, now + 30001, undefined, 'NaN']) {
    assert.equal(verifyRequest({ ...signed, timestamp, now: () => now }).code, 'REQUEST_EXPIRED');
  }
});

test('signed Core request rejects wrong method, path, actor, body and operation key', () => {
  for (const mismatch of [
    { method: 'GET' }, { path: '/ingress/queue/join' }, { actor: 'svc_bob' },
    { opKey: 'operation-2' }, { bodyString: '{"command":null}' },
    { signature: 'a'.repeat(64) }, { signature: 'not-hex' },
  ]) {
    const result = verifyRequest({ ...signed, ...mismatch, now: () => now });
    assert.equal(result.valid, false);
    assert.equal(result.code, 'INVALID_SERVICE_SIGNATURE');
  }
});
