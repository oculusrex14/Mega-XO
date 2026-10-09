/* apps/game-core/realtime.js - the Game Core process's realtime/v1 entry point (V5-08-01).
 *
 * The Core container mounts this ONE module on its existing HTTP(S) server; the transport claims
 * only the `/realtime/v1` upgrade path and the two HTTP snapshot-fallback paths under it, so the
 * Core's health/ops routes keep the same server:
 *
 *   const http = require('node:http');
 *   const { createRealtimeTransport } = require('./realtime.js');
 *   const server = http.createServer(app);
 *   const transport = createRealtimeTransport({ server, pool, core, ephemera, now });
 *   server.listen(port);
 *   ...
 *   await transport.close();   // drain sockets, keep the server/pool/core/ephemera caller-owned
 *
 * The snapshot fallback is registered with `prependListener('request', ...)` and answers only
 * `GET /realtime/v1/snapshot?match_id=..&actor=..` and `GET /realtime/v1/match/:id?actor=..`; an app
 * handler must therefore YIELD those two paths (its answer lands a database round-trip later, so a
 * `res.headersSent` check alone races it) and handles every other request unchanged.
 *
 * It is a re-export, not a second implementation: the wire contract, the one-use ticket redemption
 * and the durable membership check all live in packages/services/realtime-transport.js, next to the
 * PostgreSQL/Core services the Core process already owns. Nothing here creates a pool, a service or
 * a schema; boot identity and readiness stay the caller's (createCoreService / createPgPool).
 */
'use strict';

module.exports = require('../../packages/services/realtime-transport.js');
