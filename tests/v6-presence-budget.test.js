 'use strict';
 /* Source-only check for the A4 root-cause fix: the presence heartbeat must spend its
  * fine-grained budget through the Redis-class ephemera path and fall back to the durable
  * PostgreSQL spend ONLY when Redis is unavailable. A per-heartbeat durable write streamed
  * the whole database out of Neon on every backup cycle (decision log 15:05 IST 2026-10-20). */
 const test = require('node:test');
 const assert = require("node:assert/strict");
 const fs = require("node:fs");
 const path = require("node:path");
 const ROOT = path.resolve(__dirname, "..");
 
 test('the presence heartbeat consults the Redis budget before any durable presence spend', () => {
   const source = fs.readFileSync(path.join(ROOT, 'packages/services/accounts.js'), 'utf8');
   const redisHit = source.indexOf('ephemera.rateHit(');
   const durableSpend = source.indexOf("await rate(repositories, live.hash, 'presence', 12, 60);");
   assert.ok(redisHit > 0, 'the heartbeat must consult the Redis-class presence budget');
   assert.ok(durableSpend > 0, 'the durable fallback budget must remain for Redis outages');
   const conditional = source.slice(0, durableSpend).lastIndexOf("if (!redisBudget.available)");
   assert.ok(conditional > redisHit, 'the durable presence spend must run only when Redis is unavailable');
 });
