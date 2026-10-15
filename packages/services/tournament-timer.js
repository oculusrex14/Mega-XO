'use strict';

// Composition helper only: the PostgreSQL service owns every due decision,
// claim, canonical T.tick transition and atomic payout/refund.
function createTournamentTimer({ tournaments, owner, intervalMs = 1000, onError = () => {} } = {}) {
 if (typeof tournaments?.sweepTimers !== 'function' || typeof owner !== 'string' || !owner ||
     !Number.isSafeInteger(intervalMs) || intervalMs < 250 || intervalMs > 60000) throw Error('INVALID_TOURNAMENT_TIMER');
 let timer = null, pending = null, stopped = false;
 function tick() {
  if (stopped || pending) return pending;
  pending = Promise.resolve().then(() => tournaments.sweepTimers({ owner, limit: 16, leaseMs: 5000 }))
   .catch(error => { onError(error); return null; }).finally(() => { pending = null; });
  return pending;
 }
 return {
  tick,
  start() { if (timer || stopped) return; timer = setInterval(tick, intervalMs); timer.unref?.(); tick(); },
  async stop() { stopped = true; clearInterval(timer); timer = null; await pending; },
 };
}

module.exports = { createTournamentTimer };
