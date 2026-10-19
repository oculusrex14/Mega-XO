'use strict';

/* Composition helper only: the PostgreSQL service owns every due decision,
 * claim, canonical T.tick transition and atomic payout/refund.
 *
 * Deadline-driven scheduling (infrastructure brief 2026-10-19, part B). The previous timer
 * scanned tournament.rooms every second forever — ~674k scans returning no rows against an idle
 * system and a database that could never sleep. Now:
 *  - sweepTimers() reports nextDueMs (the next real rooms/fixtures deadline, read in the same
 *    unit of work as the scan) so the timer sleeps until work is actually due;
 *  - with no active rooms the timer backs off to a slow reconciliation sweep well past the
 *    provider suspend timeout, so idle recovery alone never keeps the database awake;
 *  - wake() reschedules immediately after any successful mutation (run/settle/completeFixture),
 *    so a lost wake degrades to the slow sweep, never to a stretched deadline;
 *  - duplicate execution stays fenced by the existing compare-and-set leases inside tickTimer;
 *    nothing here stretches a deadline or requires a player request to settle an overdue one.
 */
function createTournamentTimer({ tournaments, owner, intervalMs = 1000, activeMaxMs = 15000, idleIntervalMs = 10 * 60 * 1000, onError = () => {} } = {}) {
 if (typeof tournaments?.sweepTimers !== 'function' || typeof owner !== 'string' || !owner ||
     !Number.isSafeInteger(intervalMs) || intervalMs < 250 || intervalMs > 60000 ||
     !Number.isSafeInteger(idleIntervalMs) || idleIntervalMs < 30000 ||
     !Number.isSafeInteger(activeMaxMs) || activeMaxMs < intervalMs) throw Error('INVALID_TOURNAMENT_TIMER');
 let timer = null, pending = null, stopped = false, wakeScheduled = false;
 /* Sol P1 #6: a wake arriving DURING a sweep is latched, not discarded - the in-flight sweep
  * read its room/deadline snapshot before that mutation, so its computed delay is stale. The
  * completion handler re-sweeps immediately when latched instead of sleeping out the idle
  * ceiling; a second mutation during the catch-up sweep latches again (bounded by real work). */
 let wakeLatched = false;
 function schedule(delayMs) {
  if (stopped) return;
  if (timer) { clearTimeout(timer); timer = null; }
  timer = setTimeout(tick, delayMs);
  timer.unref?.();
 }
 function tick() {
  if (stopped) return null;
  if (pending) return pending;
  pending = Promise.resolve().then(() => tournaments.sweepTimers({ owner, limit: 16, leaseMs: 5000 }))
   .then((result) => {
    const scanned = Number(result?.scanned || 0);
    const nextDue = Number(result?.nextDueMs);
    const latched = wakeLatched; wakeLatched = false;
    /* Active rooms: honour the next real deadline, clamped to a bounded ceiling so one stale
     * computed deadline can never silence a live room for long. Idle: the slow sweep. */
    const delay = scanned > 0 && Number.isSafeInteger(nextDue) && nextDue >= 0
     ? Math.min(Math.max(nextDue + 50, intervalMs), activeMaxMs)
     : idleIntervalMs;
   schedule(latched ? intervalMs : delay);
    return result;
   })
   .catch((error) => { onError(error); schedule(intervalMs); return null; })
   .finally(() => { pending = null; });
  return pending;
 }
 function wake() {
  if (stopped) return;
  if (pending) { wakeLatched = true; return; }
  if (wakeScheduled) return;
  wakeScheduled = true;
  const t = setTimeout(() => { wakeScheduled = false; if (!stopped && !pending) tick(); }, 0);
  t.unref?.();
 }
 return {
  tick,
  wake,
  start() { if (timer || stopped) return; tick(); },
  async stop() { stopped = true; if (timer) { clearTimeout(timer); timer = null; } await pending; },
 };
}

module.exports = { createTournamentTimer };

