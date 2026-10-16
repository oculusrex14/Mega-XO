'use strict';

const path = require('node:path');
const { sendJson } = require('./helpers');

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
    const body = req.body && typeof req.body === 'object' && Array.isArray(req.body.events) ? req.body.events : null;
    if (!body) fail('METRICS_BATCH_INVALID', 400);
    const result = await sink.batch(body);
    sendJson(res, 200, { ok: true, accepted: result.accepted }, { 'Cache-Control': 'no-store' });
    return true;
  } catch (error) {
    if (error && error.status) { sendJson(res, error.status, { error: error.code || error.message }); return true; }
    return false;
  }
}

module.exports = { handleMetricsRoute };
