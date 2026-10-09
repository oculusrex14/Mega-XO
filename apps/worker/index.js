/* apps/worker/index.js - the dedicated worker process's entry point (V5 P10 task V5-10-02).
 *
 * The worker container mounts this ONE module: it creates NOTHING borrowed (no pool, no Redis client,
 * no secret source, no transport), it only WIRES the caller's handles into the extracted workflows and
 * owns their lifetime.
 *
 *   const { createWorkerApp } = require('./apps/worker/index.js');
 *   const app = createWorkerApp({ pool, redis, secret, transport, privacyPool, log, now, intervalMs });
 *   app.start();                       // arm the periodic tick (does NOT tick immediately)
 *   await app.tick();                  // one pass on demand
 *   await app.stop();                  // clear the interval synchronously, close NOTHING borrowed
 *
 * `pool` MUST be the `worker_runtime` pool: `ops.outbox` is worker-owned (0022) and `createJobService`
 * verifies the role before any statement runs. `redis` is the P06 ephemera handle; the workflows in this
 * task are PostgreSQL-only and never invent an ephemeral key, so a null/absent Redis is legitimate.
 * `privacyPool` is OPTIONAL and names the connection whose role holds the `ops.rate_buckets` DELETE
 * (api_runtime, 0020:55; worker_runtime holds no DELETE there by design - 0037); with none, the
 * rate-bucket sweep is skipped and reported as `null` rather than attempted and refused.
 *
 * This is a re-export, not a second implementation: the mail worker, the privacy workflow, the periodic
 * maintenance tick and the sanitized logging all live in packages/services/worker-workflows.js, next to
 * the durable job primitives they drive.
 */
'use strict';

module.exports = require('../../packages/services/worker-workflows.js');
