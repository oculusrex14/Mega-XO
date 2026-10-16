'use strict';

/* LR19 (2026-10-16): the OPTIONAL client telemetry lane. OFF by default; the only way in is the
 * explicit privacy-choices toggle (localStorage mx-telemetry = opted-in). Batches are bounded,
 * anonymous, and kind-allow-listed server-side. No actor id, no free text, no age/gender/geo, no
 * join key to the research lane - the batch body is just [{kind, count}] with allowed kinds. */

const FLAG = 'mx-telemetry';
const ENDPOINT = '/api/metrics/batch';
const FLUSH_MS = 60000;
const MAX_QUEUE = 200;

export function telemetryOptedIn(storage) {
  try { return storage && storage.getItem(FLAG) === 'opted-in'; } catch { return false; }
}

export function setTelemetryOptIn(storage, value) {
  try {
    if (value === true) storage.setItem(FLAG, 'opted-in');
    else storage.removeItem(FLAG);
  } catch { /* storage unavailable: the lane simply stays off */ }
}

/* The privacy-choices panel. Rendered from the SAME storage the lane reads, so the displayed state
 * and the lane's behavior can never disagree. Both actions are always present; the current one is
 * disabled. */
export function telemetryPanel(storage) {
  const optedIn = telemetryOptedIn(storage);
  const status = optedIn
    ? 'Sharing daily anonymous counters. No name, account id, IP address, gameplay moves or research data is included, and you can stop at any time.'
    : 'Not sharing. No usage counters leave this browser.';
  return '<div class="pg-consent" data-telemetry-panel>'
    + '<h3>Product telemetry</h3>'
    + '<p><strong>Optional and separate from research.</strong> If you allow it, Mega XOXO counts daily, anonymous product-usage totals (for example ads shown or matches completed) to find broken flows and measure whether ads actually pay out.</p>'
    + '<p class="mx-muted">' + status + '</p>'
    + '<div class="pg-actions">'
    + '<button class="mx-button primary" type="button" data-metrics-action="optin"' + (optedIn ? ' disabled' : '') + '>Share daily anonymous counters</button>'
    + '<button class="pg-text-button" type="button" data-metrics-action="optout"' + (optedIn ? '' : ' disabled') + '>Stop sharing</button>'
    + '</div></div>';
}

export function createTelemetryLane({ storage, request, now = Date.now, intervalMs = FLUSH_MS } = {}) {
  if (!storage || storage.getItem(FLAG) !== 'opted-in') return null;
  if (typeof request !== 'function') return null;
  const queue = [];
  let timer = null;
  let inFlight = false;
  function enqueue(kind, count) {
    if (queue.length >= MAX_QUEUE) return; /* bounded: drop rather than grow unboundedly */
    queue.push({ kind, count: count === undefined ? 1 : count });
  }
  async function flush() {
    if (inFlight || queue.length === 0) return;
    const batch = queue.splice(0, 32);
    try { await request(ENDPOINT, { events: batch }); } catch { /* a failed flush is dropped - never queued forever */ }
  }
  function start() {
    if (timer !== null) return;
    timer = setInterval(() => { flush().catch(() => {}); }, intervalMs);
    if (typeof timer === 'object' && timer && typeof timer.unref === 'function') timer.unref();
  }
  function stop() { if (timer !== null) { clearInterval(timer); timer = null; } }
  return Object.freeze({
    record: (kind, count) => { if (telemetryOptedIn(storage)) enqueue(kind, count); },
    flush,
    start,
    stop,
  });
}
