'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyCorePair, chooseReadyCore } = require('../scripts/v5/p16/core-failover-plan');

const digest = (character) => 'ghcr.io/team/mega-xo-core@sha256:' + character.repeat(64);

function topology() {
  return {
    environment: 'staging',
    ingress: 'existing-single-caddy',
    additionalPublicListener: false,
    privateOperations: true,
    cores: [
      { id: 'core-a', upstream: 'core-a:8080', privateNetwork: 'mega-v5-internal',
        hostFailureDomain: 'oracle-host-1', image: digest('a'), publicBind: false, operatorPublic: false },
      { id: 'core-b', upstream: 'core-b:8080', privateNetwork: 'mega-v5-internal',
        hostFailureDomain: 'oracle-host-1', image: digest('a'), publicBind: false, operatorPublic: false },
    ],
  };
}

test('pair inspection distinguishes process redundancy from host/edge high availability', () => {
  assert.deepEqual(verifyCorePair(topology()), {
    environment: 'staging',
    cores: 2,
    privateNetwork: 'mega-v5-internal',
    availabilityScope: 'CORE_PROCESS_ONLY',
    publicListenerCountAdded: 0,
    evidence: 'STATIC_TOPOLOGY_ONLY',
  });
});

test('refuses second edge, public/admin listeners, duplicate containers and split networks', () => {
  const cases = [
    (p) => { p.additionalPublicListener = true; },
    (p) => { p.ingress = 'new-caddy'; },
    (p) => { p.cores[0].publicBind = true; },
    (p) => { p.cores[1].operatorPublic = true; },
    (p) => { p.cores[1].id = 'core-a'; },
    (p) => { p.cores[1].upstream = '0.0.0.0:80'; },
    (p) => { p.cores[0].privateNetwork = 'host'; },
    (p) => { p.cores[1].privateNetwork = 'another-network'; },
    (p) => { p.cores.pop(); },
  ];
  for (const change of cases) {
    const p = topology();
    change(p);
    assert.throws(() => verifyCorePair(p), /^Error: P16_/, 'must fail closed');
  }
});

test('requires immutable images and explicit rolling protocol compatibility evidence', () => {
  const bad = topology();
  bad.cores[0].image = 'ghcr.io/team/mega-xo-core:latest';
  assert.throws(() => verifyCorePair(bad), /P16_IMMUTABLE_IMAGE_REQUIRED/);
  const rolling = topology();
  rolling.cores[1].image = digest('b');
  assert.throws(() => verifyCorePair(rolling), /P16_ROLLING_COMPATIBILITY_EVIDENCE_REQUIRED/);
  rolling.compatibilityEvidenceSha256 = 'c'.repeat(64);
  assert.equal(verifyCorePair(rolling).availabilityScope, 'CORE_PROCESS_ONLY');
});

test('routing advisory refuses draining, over-capacity, stale and unready cores', () => {
  const now = 20000;
  const states = [
    { id: 'core-a', ready: true, draining: false, active: 2, capacity: 10, checkedAtMs: 19000 },
    { id: 'core-b', ready: true, draining: false, active: 1, capacity: 10, checkedAtMs: 19000 },
  ];
  assert.equal(chooseReadyCore(states, { now }), 'core-b');
  states[1].draining = true;
  assert.equal(chooseReadyCore(states, { now }), 'core-a');
  states[0].checkedAtMs = 10000;
  assert.equal(chooseReadyCore(states, { now }), null);
  states[0].checkedAtMs = 19500;
  states[0].active = 10;
  assert.equal(chooseReadyCore(states, { now }), null);
  states[0].active = 0;
  states[0].ready = false;
  assert.equal(chooseReadyCore(states, { now }), null);
});

test('routing advisory resolves ties deterministically, never trusts duplicate IDs or future data', () => {
  const now = 50000;
  const a = { id: 'core-a', ready: true, draining: false, active: 2, capacity: 10, checkedAtMs: now };
  const b = { ...a, id: 'core-b' };
  assert.equal(chooseReadyCore([b, a], { now }), 'core-a');
  assert.equal(chooseReadyCore([a, a], { now }), null);
  assert.equal(chooseReadyCore([{ ...a, checkedAtMs: now + 1 }], { now }), null);
  assert.equal(chooseReadyCore([], { now }), null);
  assert.throws(() => chooseReadyCore([a], { now, maxAgeMs: Infinity }), /P16_HEALTH_SELECTOR_INPUT/);
});
