'use strict';

/* MXA-PROMOTION-DISCLOSURE (2026-10-20): the launch-promotion anti-hoarding disclosure.
 *
 * PR #55 left two integration prerequisites to this lane: the policy publication (which pins
 * rule_hash to the disclosed text) and the disclosure/acceptance wiring. This module is the
 * single source of the disclosed RULE TEXT and the HMAC attestation token that travels:
 *
 *   API tier  GET /api/monetization/promotion/disclosure -> issueToken(payload, secret)
 *   player    POST /api/monetization/promotion/accept {token} -> receipt {policyVersion,
 *             ruleHash, remaining, disclosureReceipt}
 *   Core      acceptPromotionPolicy -> options.verifyPromotionAcceptance(actor, receipt)
 *             (this module re-verifies the token server-side; the API tier is never trusted)
 *
 * The secret is a subkey derived from the stable OTP secret (key separation by derivation);
 * no new host secret file is required. Tokens are bound to the actor and expire, so a
 * forwarded token cannot accept for someone else and cannot be replayed later than maxAge.
 *
 * RULE HASH: ruleHash() is sha256 of the exact RULE_TEXT bytes. The publication step
 * (deploy gate) MUST compute the hash with this function - a mismatched published hash
 * makes every acceptance fail closed with PROMOTION_DISCLOSURE_STALE, which is the
 * intended failure direction. */

const crypto = require('node:crypto');

const RULE_TEXT = [
  'PROMOTIONAL CROWN ALLOCATION RULE (launch promotion)',
  '',
  '1. During the launch promotion, an account may reserve at most 22,000 promotional Crowns',
  '   in total, across every payment method (Dodo, Cashfree, Polar, Google Play and the App',
  '   Store) and every checkout, for the whole promotion.',
  '2. The cap counts promotional Crowns at the moment a checkout is created. Spending,',
  '   converting, refunding or losing them later does not restore capacity, and a refund does',
  '   not entitle the account to reserve the same Crowns again.',
  '3. The cap never touches Crowns earned in game, Mega Pass allowances, or purchases made',
  '   after the promotion ends. A blocked checkout never reduces an existing balance.',
  '4. If an account is found, through documented server evidence, to have breached this rule',
  '   (for example by circumventing the cap across accounts or payments), the promotion',
  '   benefits involved may be reversed. Any reversal happens only after: written notice in',
  '   the account and by email where one is verified, a review by two independent reviewers,',
  '   a documented decision, and at least 30 days to appeal from the day the decision is',
  '   delivered. Silence is never treated as an admission.',
  '5. Everything else in the Terms of Service applies unchanged.',
].join('\n');

const TOKEN_VERSION = 1;
const MAX_AGE_MS = 15 * 60 * 1000;
const b64u = (buf) => Buffer.from(buf).toString('base64url');

function ruleText() { return RULE_TEXT; }
function ruleHash() { return crypto.createHash('sha256').update(RULE_TEXT, 'utf8').digest('hex'); }

/* Key separation: the disclosure subkey is derived from the stable secret with a domain tag,
 * so a disclosure token can never be confused with an OTP HMAC or a gateway signature. */
function deriveSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 16) throw Error('DISCLOSURE_SECRET_REQUIRED');
  return crypto.createHmac('sha256', secret).update('mega-promotion-disclosure-v1').digest();
}

function issueToken(payload, secret) {
  const { actor, policyVersion, ruleHash: hash, remaining, now = Date.now() } = payload || {};
  if (typeof actor !== 'string' || !actor) throw Error('INVALID_DISCLOSURE_PAYLOAD');
  if (typeof policyVersion !== 'string' || !policyVersion) throw Error('INVALID_DISCLOSURE_PAYLOAD');
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw Error('INVALID_DISCLOSURE_PAYLOAD');
  if (!Number.isSafeInteger(remaining) || remaining < 0) throw Error('INVALID_DISCLOSURE_PAYLOAD');
  const body = b64u(JSON.stringify({ v: TOKEN_VERSION, actor, policyVersion, ruleHash: hash, remaining, issuedAt: now }));
  const signature = b64u(crypto.createHmac('sha256', deriveSecret(secret)).update(body).digest());
  return body + '.' + signature;
}

function verifyToken(token, secret, { actor, now = Date.now(), maxAgeMs = MAX_AGE_MS } = {}) {
  if (typeof token !== 'string' || !token) throw Error('INVALID_DISCLOSURE_TOKEN');
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) throw Error('INVALID_DISCLOSURE_TOKEN');
  const body = token.slice(0, dot), signature = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', deriveSecret(secret)).update(body).digest();
  const presented = Buffer.from(signature, 'base64url');
  if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) throw Error('INVALID_DISCLOSURE_TOKEN');
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw Error('INVALID_DISCLOSURE_TOKEN'); }
  if (!payload || payload.v !== TOKEN_VERSION || typeof payload.actor !== 'string' || !payload.actor
    || typeof payload.policyVersion !== 'string' || !payload.policyVersion
    || typeof payload.ruleHash !== 'string' || !/^[0-9a-f]{64}$/.test(payload.ruleHash)
    || !Number.isSafeInteger(payload.remaining) || payload.remaining < 0
    || !Number.isFinite(payload.issuedAt)) throw Error('INVALID_DISCLOSURE_TOKEN');
  if (actor !== undefined && payload.actor !== actor) throw Error('DISCLOSURE_TOKEN_ACTOR_MISMATCH');
  if (now - payload.issuedAt > maxAgeMs) throw Error('DISCLOSURE_TOKEN_EXPIRED');
  return payload;
}

/* The receipt the API tier forwards with promotion_accept. verifyAcceptanceReceipt is the
 * Core-side options.verifyPromotionAcceptance adapter: it re-verifies the token inside the
 * receipt so a forged receipt shape can never record an acceptance. */
function receiptFromToken(token, secret, actor) {
  const payload = verifyToken(token, secret, { actor });
  return { policyVersion: payload.policyVersion, ruleHash: payload.ruleHash, remaining: payload.remaining, disclosureReceipt: token };
}

function verifyAcceptanceReceipt(secret, actor, receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return false;
  try {
    const payload = verifyToken(receipt.disclosureReceipt, secret, { actor });
    return payload.policyVersion === receipt.policyVersion
      && payload.ruleHash === receipt.ruleHash
      && payload.remaining === receipt.remaining;
  } catch { return false; }
}

module.exports = { ruleText, ruleHash, deriveSecret, issueToken, verifyToken, receiptFromToken, verifyAcceptanceReceipt, MAX_AGE_MS };
