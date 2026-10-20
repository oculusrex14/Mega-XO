'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Disclosure = require('../packages/services/promotion-disclosure.js');
const SECRET = 'test-disclosure-secret-0123456789abcdef';
const NOW = Date.parse('2026-12-01T00:00:00Z');

test('disclosure: the published rule hash pins the exact shipped rule text', () => {
 assert.match(Disclosure.ruleText(), /^PROMOTIONAL CROWN ALLOCATION RULE/);
 assert.equal(Disclosure.ruleHash(), require('node:crypto').createHash('sha256').update(Disclosure.ruleText(), 'utf8').digest('hex'));
});

test('disclosure: tokens are actor-bound, expire, and reject tampering', () => {
 const token = Disclosure.issueToken({ actor: 'svc_a', policyVersion: 'promotion-allocation-v1', ruleHash: Disclosure.ruleHash(), remaining: 22000, now: NOW }, SECRET);
 assert.deepEqual(Disclosure.verifyToken(token, SECRET, { actor: 'svc_a', now: NOW + 1 }).remaining, 22000);
 assert.throws(() => Disclosure.verifyToken(token, SECRET, { actor: 'svc_b', now: NOW + 1 }), /ACTOR_MISMATCH/);
 assert.throws(() => Disclosure.verifyToken(token, SECRET, { actor: 'svc_a', now: NOW + Disclosure.MAX_AGE_MS + 1 }), /EXPIRED/);
 assert.throws(() => Disclosure.verifyToken(token.slice(0, -2) + 'aa', SECRET, { actor: 'svc_a' }), /INVALID_DISCLOSURE_TOKEN/);
 assert.throws(() => Disclosure.issueToken({ actor: 'svc_a', policyVersion: 'p', ruleHash: 'nope', remaining: 1, now: NOW }, SECRET), /INVALID_DISCLOSURE_PAYLOAD/);
});

test('disclosure: the acceptance receipt re-verifies server-side and binds every field', () => {
 const token = Disclosure.issueToken({ actor: 'svc_a', policyVersion: 'promotion-allocation-v1', ruleHash: Disclosure.ruleHash(), remaining: 21000, now: NOW }, SECRET);
 const receipt = Disclosure.receiptFromToken(token, SECRET, 'svc_a');
 assert.deepEqual(Object.keys(receipt).sort(), ['disclosureReceipt', 'policyVersion', 'remaining', 'ruleHash']);
 assert.equal(Disclosure.verifyAcceptanceReceipt(SECRET, 'svc_a', receipt), true);
 assert.equal(Disclosure.verifyAcceptanceReceipt(SECRET, 'svc_b', receipt), false, 'another actor can never accept with this receipt');
 assert.equal(Disclosure.verifyAcceptanceReceipt(SECRET, 'svc_a', { ...receipt, remaining: 1 }), false, 'a drifted field invalidates the attestation');
 assert.equal(Disclosure.verifyAcceptanceReceipt(SECRET, 'svc_a', { ...receipt, disclosureReceipt: 'forged' }), false);
});

test('disclosure: the subkey is derived, not the raw secret', () => {
 assert.notEqual(Disclosure.deriveSecret(SECRET), Buffer.from(SECRET));
 assert.deepEqual(Disclosure.deriveSecret(SECRET), Disclosure.deriveSecret(SECRET));
 assert.throws(() => Disclosure.deriveSecret('short'), /DISCLOSURE_SECRET_REQUIRED/);
});
