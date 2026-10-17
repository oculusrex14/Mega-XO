'use strict';

const path = require('node:path');
/* MXA-INF-008: parseJsonBody (not a raw-string assumption) and a real error constructor -
 * the previous undefined fail() turned every validation failure into a silent 404 fall-through. */
const { sendJson, parseJsonBody } = require('./helpers');

function fail(code, status) {
  const err = new Error(code);
  err.code = code;
  err.status = status;
  throw err;
}

/* LR19: the anonymous metrics batch endpoint. NO session resolution, NO actor binding, NO CSRF
 * surface (nothing identifiable is stored), NO free text - the sink enforces the frozen kind
 * allow-list and the daily-aggregate shape. A 100KB body limit and the bounded batch size are the
 * abuse guards; the sink itself rate-shapes by collapsing to one counter per day per kind. */

const { createMetricsSink } = require(path.join(__dirname, '../../../packages/services/metrics.js'));

function resolveMetrics(context) {
  const sink = context && context.metrics;
  if (sink && typeof sink.batch === 'function') return sink;
  const error = new Error('METRICS_UNAVAILABLE');
  error.status = 503;
  error.code = 'METRICS_UNAVAILABLE';
  throw error;
}

async function handleMetricsRoute(context, req, res) {
  const method = (req.method || 'GET').toUpperCase();
  let pathname = new URL(req.url || '/', 'http://localhost').pathname;
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  if (pathname !== '/api/metrics/batch') return false;
  try {
    if (method !== 'POST') { sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }); return true; }
    const sink = resolveMetrics(context);
    /* The canonical handler collects the RAW body as a UTF-8 string; parse it bounded here. */
    const parsed = await parseJsonBody(req, 100 * 1024);
    const events = parsed && typeof parsed === 'object' && Array.isArray(parsed.events) ? parsed.events : null;
    if (!events) fail('METRICS_BATCH_INVALID', 400);
    const result = await sink.batch(events);
    sendJson(res, 200, { ok: true, accepted: result.accepted }, { 'Cache-Control': 'no-store' });
    return true;
  } catch (error) {
    if (error && error.status) { sendJson(res, error.status, { error: error.code || error.message }); return true; }
    return false;
  }
}

module.exports = { handleMetricsRoute };
