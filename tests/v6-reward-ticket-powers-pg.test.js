'use strict';
// Sol review R5: undo/hint reward-ticket kinds must insert and settle against the REAL
// schema. 0014's CHECK allowed only credits/boost, so every eligible power-ad issuance
// failed with a PostgreSQL CHECK violation; 0068 extends the constraint. Runs on the owned
// disposable PG16 only (same lab as the promotion enforcement suite).
const test = require('node:test');
const assert = require('node:assert/strict');
const lab = require('./v5-pg-lab.js');

lab.installCleanup(test);

test('reward ticket powers: undo/hint kinds insert against the real schema; unknown kinds stay rejected', async t => {
  if (!await lab.boot(t)) return;
  const db = await lab.createDatabase('reward_ticket_powers');
  await lab.seedActors(db, [{ actor: 'svc_alice', coins: 10, crowns: 0, rating: 1500, games: 0, stats: 'friends' }]);
  const admin = await lab.adminClient(db);
  t.after(() => admin.end());
  const actor = 'svc_alice';
  for (const kind of ['undo', 'hint']) {
    await admin.query(
      'INSERT INTO monetization.reward_tickets (ticket_id, actor_id, kind, issued_at, day) VALUES ($1, $2, $3, now(), now()::date)',
      ['r5_' + kind, actor, kind]);
  }
  const kinds = (await admin.query("SELECT kind FROM monetization.reward_tickets WHERE ticket_id IN ('r5_undo','r5_hint') ORDER BY kind")).rows.map(r => r.kind);
  assert.deepEqual(kinds, ['hint', 'undo'], 'the powers kinds must persist (0014 CHECK regression R5)');
  await assert.rejects(
    () => admin.query("INSERT INTO monetization.reward_tickets (ticket_id, actor_id, kind, issued_at, day) VALUES ('r5_bogus', $1, 'bogus', now(), now()::date)", [actor]),
    /reward_tickets_kind_check/,
    'the extended constraint must still reject unknown kinds');
});
