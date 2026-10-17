'use strict';

/* C7.2 (2026-10-17): POST /api/sponsors/report — durable ticket intake for the app/website
 * report-and-hide flow. Reports are OPERATIONAL MODERATION RECORDS, not economic writes:
 * this route never touches wallet/Core tables, never mints grants, and never accepts a
 * caller-supplied actor. Identity is resolved server-side where a session exists; guests
 * are accepted with a bounded per-IP rate. The durable table/service is mounted by Main
 * through context.sponsors.storeReport() — until then this answers 503 honestly, and the
 * client keeps the creative hidden locally with its stable reportId for retry. There is
 * deliberately NO endpoint for reading reports: moderation review is an operator surface.
 *
 * Body: {reportId, creativeId, campaignId, revision, reason, note?}
 * - reportId: client-generated once per creative+incident and reused on retry (op-key role).
 * - reason: Misleading | Inappropriate | Broken link | Other.
 * - note: optional, trimmed to 280 chars. No URLs are fetched, no provider calls are made.
 * Reply: 202 {accepted:true,reportId} | 400 INVALID_REPORT_* | 429 RATE_LIMITED | 503 unavailable. */

const { sendJson, resolveAuth } = require('./helpers');

const REASONS = new Set(['Misleading', 'Inappropriate', 'Broken link', 'Other']);
const NOTE_LIMIT = 280;
const GUEST_WINDOW_MS = 60_000;
const GUEST_MAX_PER_WINDOW = 5;
const guestHits = new Map();

function fail(code, status) {
  const err = new Error(code);
  err.code = code;
  err.status = status;
  throw err;
}

function guestAdmission(ip, now) {
  const key = String(ip || 'unknown');
  const bucket = guestHits.get(key) || [];
  const fresh = bucket.filter((t) => now - t < GUEST_WINDOW_MS);
  if (fresh.length >= GUEST_MAX_PER_WINDOW) fail('RATE_LIMITED', 429);
  fresh.push(now);
  guestHits.set(key, fresh);
  if (guestHits.size > 5000) {
    const cutoff = now - GUEST_WINDOW_MS;
    for (const [k, times] of guestHits) {
      if (!times.some((t) => t >= cutoff)) guestHits.delete(k);
    }
  }
}

async function handleSponsorsRoute(context, req, res) {
  const url = new URL(req.url, context.origin || 'http://localhost');
  if (url.pathname !== '/api/sponsors/report') return false;
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'INVALID_OPERATION' }); return true; }
  const store = context.sponsors;
  if (!store || typeof store.storeReport !== 'function') { sendJson(res, 503, { error: 'SPONSOR_REPORT_UNAVAILABLE' }); return true; }

  let body;
  try { body = await context.parseJsonBody(req, res, 4096); } catch { sendJson(res, 400, { error: 'INVALID_JSON' }); return true; }
  if (!body || typeof body !== 'object') { sendJson(res, 400, { error: 'INVALID_JSON' }); return true; }

  const reportId = typeof body.reportId === 'string' && /^[a-zA-Z0-9_-]{6,64}$/.test(body.reportId) ? body.reportId : null;
  const creativeId = typeof body.creativeId === 'string' && body.creativeId.length <= 128 ? body.creativeId : null;
  const campaignId = typeof body.campaignId === 'string' && body.campaignId.length <= 128 ? body.campaignId : null;
  const revision = Number.isFinite(body.revision) ? Math.trunc(body.revision) : null;
  const reason = typeof body.reason === 'string' ? body.reason : '';
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, NOTE_LIMIT) : '';
  if (!reportId || !creativeId || !campaignId || revision === null) { sendJson(res, 400, { error: 'INVALID_REPORT_DETAIL' }); return true; }
  if (!REASONS.has(reason)) { sendJson(res, 400, { error: 'INVALID_REPORT_CATEGORY' }); return true; }

  const { actor } = await resolveAuth(context, req).catch(() => ({ actor: null }));
  if (!actor) guestAdmission(req.socket?.remoteAddress, Date.now());

  try {
    await store.storeReport({ reportId, creativeId, campaignId, revision, reason, note, actor: actor || null, receivedAt: Date.now() });
  } catch (e) {
    if (e && e.code === 'RATE_LIMITED') { sendJson(res, 429, { error: 'RATE_LIMITED' }); return true; }
    sendJson(res, 503, { error: 'SPONSOR_REPORT_UNAVAILABLE' });
    return true;
  }
  sendJson(res, 202, { accepted: true, reportId });
  return true;
}

module.exports = { handleSponsorsRoute, REASONS, NOTE_LIMIT };

