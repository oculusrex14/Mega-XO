'use strict';

/*
 * P16 pre-deployment check: two distinct *private* Core upstreams share
 * one existing edge. Configuration proof only: it cannot establish that the
 * hosts, health endpoints, websocket routing or durable replay actually work.
 */
const DIGEST = /^[-a-zA-Z0-9._/]+@sha256:[a-f0-9]{64}$/;
const NAME = /^core-[ab]$/;
const PRIVATE_NETWORK = /^[a-z0-9][a-z0-9_.-]{2,62}$/;

function verifyCorePair(plan) {
  if (!plan || !['staging', 'production'].includes(plan.environment)) {
    throw new Error('P16_ENVIRONMENT_REQUIRED');
  }
  if (plan.ingress !== 'existing-single-caddy' || plan.additionalPublicListener !== false ||
      plan.privateOperations !== true) {
    throw new Error('P16_EDGE_EXPOSURE_REFUSED');
  }
  if (!Array.isArray(plan.cores) || plan.cores.length !== 2) {
    throw new Error('P16_TWO_PROCESSES_REQUIRED');
  }
  const ids = new Set();
  const upstreams = new Set();
  const networks = new Set();
  const images = new Set();

  for (const instance of plan.cores) {
    if (!instance || typeof instance !== 'object' || !NAME.test(instance.id || '') ||
        ids.has(instance.id)) throw new Error('P16_DISTINCT_CORE_ID_REQUIRED');
    ids.add(instance.id);
    const match = typeof instance.upstream === 'string'
      ? /^([a-z0-9-]+):([0-9]{1,5})$/.exec(instance.upstream)
      : null;
    if (!match || match[1] !== instance.id || Number(match[2]) < 1024 ||
        Number(match[2]) > 65535 || upstreams.has(instance.upstream)) {
      throw new Error('P16_PRIVATE_UPSTREAM_REQUIRED');
    }
    upstreams.add(instance.upstream);
    if (!PRIVATE_NETWORK.test(instance.privateNetwork || '') ||
        instance.privateNetwork === 'host' || instance.privateNetwork === 'public') {
      throw new Error('P16_PRIVATE_NETWORK_REQUIRED');
    }
    networks.add(instance.privateNetwork);
    if (typeof instance.hostFailureDomain !== 'string' ||
        !/^[a-z0-9_.-]{3,64}$/.test(instance.hostFailureDomain)) {
      throw new Error('P16_FAILURE_DOMAIN_REQUIRED');
    }
    if (typeof instance.image !== 'string' || !DIGEST.test(instance.image)) {
      throw new Error('P16_IMMUTABLE_IMAGE_REQUIRED');
    }
    images.add(instance.image);
    if (instance.publicBind !== false || instance.operatorPublic !== false) {
      throw new Error('P16_PUBLIC_BIND_REFUSED');
    }
  }
  if (!ids.has('core-a') || !ids.has('core-b') || networks.size !== 1) {
    throw new Error('P16_SHARED_PRIVATE_NETWORK_REQUIRED');
  }
  if (images.size > 1 && !/^[a-f0-9]{64}$/.test(plan.compatibilityEvidenceSha256 || '')) {
    throw new Error('P16_ROLLING_COMPATIBILITY_EVIDENCE_REQUIRED');
  }

  return Object.freeze({
    environment: plan.environment,
    cores: 2,
    privateNetwork: [...networks][0],
    // Shared edge is still a single failure domain, even if processes run on
    // different hosts. Never advertise Oracle host/zone HA from this result.
    availabilityScope: 'CORE_PROCESS_ONLY',
    publicListenerCountAdded: 0,
    evidence: 'STATIC_TOPOLOGY_ONLY',
  });
}

function chooseReadyCore(statuses, { now = Date.now(), maxAgeMs = 3000 } = {}) {
  if (!Array.isArray(statuses) || !Number.isFinite(now) ||
      !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 30000) {
    throw new Error('P16_HEALTH_SELECTOR_INPUT');
  }
  const choices = [];
  const seen = new Set();
  for (const s of statuses) {
    if (!s || !NAME.test(s.id || '') || seen.has(s.id)) return null;
    seen.add(s.id);
    if (s.ready !== true || s.draining !== false ||
        !Number.isSafeInteger(s.active) || !Number.isSafeInteger(s.capacity) ||
        s.active < 0 || s.capacity < 1 || s.capacity > 100000 ||
        !Number.isFinite(s.checkedAtMs) || s.checkedAtMs > now ||
        now - s.checkedAtMs > maxAgeMs || s.active >= s.capacity) continue;
    choices.push(s);
  }
  choices.sort((a, b) => a.active / a.capacity - b.active / b.capacity ||
    a.id.localeCompare(b.id));
  return choices[0]?.id || null; // null = no healthy admission target; never guess
}

module.exports = { verifyCorePair, chooseReadyCore };
