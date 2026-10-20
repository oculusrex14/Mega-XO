'use strict';
// Shared real-PG lifecycle exercised by the P11 suite and the operator's disposable verifier.
const assert = require('node:assert/strict');
const lab = require('../v5-pg-lab.js');
const { createDeletionWorker } = require('../../packages/services/worker-workflows.js');

async function setupDeletion(t, family) {
 const db = await lab.createDatabase(family);
 let at = Date.parse('2026-10-20T12:00:00Z');
 const core = await lab.coreFor(db, { clock: () => at });
 const accounts = await lab.accountsFor(db, {
  clock: () => at, provisionActor: (actor) => core.provisionActor(actor),
  deletionPolicy: { enabled: true, policyVersion: 'b4-30-day-v1' },
 });
 t.after(async () => { await accounts.close(); core.close(); await lab.closeDatabasePools(db); });
 const email = `${family}@example.test`, password = 'correct horse 42';
 const guest = await accounts.issue();
 const pending = await accounts.emailContinue(guest.token, email, password);
 const owner = await accounts.emailVerify(guest.token, pending.challengeId, pending.delivery.code);
 const profile = await accounts.self(owner.actor);
 const viewer = await accounts.createVerifiedActor({ provider: 'google', subject: `viewer-${family}`, provenance: 'provider' });
 const pools = lab.poolsFor(db);
 const worker = createDeletionWorker({ pool: pools.worker, now: () => at,
  eraseDeletion: (input) => core.eraseDeletion(input), workerId: 'b4-worker' });
 const signIn = async () => accounts.emailContinue((await accounts.issue()).token, email, password);
 const scalar = (sql, args = [owner.actor]) => lab.scalar(db, sql, args);
 const cool = async (token = owner.token) => accounts.deleteAccount(token, profile.tag);
 return { db, accounts, core, pools, worker, owner, viewer, profile, signIn, scalar, cool,
  now: () => at, advance: (ms) => { at += ms; } };
}

async function exerciseCancellation(h) {
 const ack = await h.cool();
 assert.equal(ack.executeAt, h.now() + 30 * 86400000);
 assert.equal(await h.scalar('SELECT verified FROM identity.eligibility WHERE actor_id=$1'), true);
 assert.equal(await h.scalar('SELECT count(*)::int FROM identity.email_credentials WHERE actor_id=$1'), 1);
 await assert.rejects(h.accounts.requireLinked(h.owner.token), /AUTH_REQUIRED/);
 await assert.rejects(h.accounts.view(h.viewer.actor, h.owner.actor), /PROFILE_NOT_FOUND/);
 assert.deepEqual(await h.worker.tick(), { claimed: 0, completed: 0, failed: 0 });
 const login = await h.signIn();
 assert.equal(login.actor, h.owner.actor, 'the original password still authenticates during cooling');
 const status = await h.accounts.deletionStatus(login.token);
 assert.equal(status.cooling, true); assert.equal(status.cancellable, true);
 await h.accounts.cancelDeletion(login.token, h.profile.tag);
 assert.equal((await h.accounts.deletionStatus(login.token)).cooling, false);
 assert.equal((await h.accounts.view(h.viewer.actor, h.owner.actor)).id, h.owner.actor);
 assert.equal(await h.scalar('SELECT state FROM privacy.requests WHERE request_id=$1', [ack.receiptId]), 'cancelled');
 assert.equal(await h.scalar('SELECT payload FROM ops.outbox WHERE outbox_id=$1', [`account.deletion:${ack.receiptId}`]), null);
 await assert.rejects(h.accounts.cancelDeletion(login.token, h.profile.tag), /DELETION_NOT_PENDING/);
 assert.equal((await h.signIn()).actor, h.owner.actor);
 h.advance(30 * 86400000);
 assert.deepEqual(await h.worker.tick(), { claimed: 0, completed: 0, failed: 0 });
 return { cooling: true, cancelled: true, originalCredentialsUsable: true, cancelledJobSealed: true };
}

async function exerciseCompletion(h) {
 const admin = await lab.adminClient(h.db);
 try {
  await admin.query("INSERT INTO monetization.receipts(store,transaction_id,actor_id,product_id,crowns,purchased_at) VALUES('google','b4-retained-purchase',$1,'crowns_100',100,$2)", [h.owner.actor, new Date(h.now())]);
  await admin.query("INSERT INTO privacy.reports(report_id,reporter_id,target_id,category,detail,created_at,state,outcome) VALUES('b4-reviewed',$1,$2,'other','private note',$3,'reviewed','no_action')", [h.owner.actor, h.viewer.actor, new Date(h.now())]);
  await admin.query("INSERT INTO audit.operator_audit(audit_id,\"at\",operator,action,actor_id,reason,detail,prev_hash,entry_hash) VALUES('b4-audit',$2,'test-operator','test',$1,'synthetic fixture','{}',$3,$4)", [h.owner.actor, new Date(h.now()), '0'.repeat(64), '1'.repeat(64)]);
 } finally { await admin.end(); }
 await h.accounts.save(h.owner.actor, 0, lab.practicePayload(h.owner.actor));
 const ack = await h.cool();
 assert.equal(await h.scalar('SELECT count(*)::int FROM profile.profile_saves WHERE actor_id=$1'), 1);
 await assert.rejects(h.core.provisionActor(h.owner.actor), /ACCOUNT_DELETION_PENDING/);
 h.advance(30 * 86400000 - 1);
 assert.deepEqual(await h.worker.tick(), { claimed: 0, completed: 0, failed: 0 });
 const login = await h.signIn();
 h.advance(1);
 await assert.rejects(h.accounts.cancelDeletion(login.token, h.profile.tag), /DELETION_CANCELLATION_CLOSED/);
 const outcomes = await Promise.all([h.worker.tick(), h.worker.tick()]);
 assert.equal(outcomes.reduce((n, r) => n + r.completed, 0), 1, 'competing claims complete once');
 for (const table of ['identity.email_credentials', 'identity.identities', 'identity.sessions', 'profile.profile_saves', 'economy.wallets', 'economy.ratings', 'economy.season_state', 'economy.tournament_records']) {
  assert.equal(await h.scalar(`SELECT count(*)::int FROM ${table} WHERE actor_id=$1`), 0, `${table} erased`);
 }
 assert.equal(await h.scalar('SELECT verified FROM identity.eligibility WHERE actor_id=$1'), false);
 assert.equal(await h.scalar('SELECT username FROM identity.profiles WHERE actor_id=$1'), ack.tombstone.slice(0, 24));
 assert.equal(await h.scalar('SELECT state FROM privacy.requests WHERE request_id=$1', [ack.receiptId]), 'completed');
 assert.equal(await h.scalar('SELECT count(*)::int FROM privacy.deletion_receipts WHERE receipt_id=$1', [ack.receiptId]), 1);
 assert.match(await h.scalar('SELECT note FROM privacy.deletion_receipts WHERE receipt_id=$1', [ack.receiptId]), /operator-follow-up:.*not certified erased/);
 assert.equal(await h.scalar('SELECT state FROM ops.outbox WHERE outbox_id=$1', [`account.deletion:${ack.receiptId}`]), 'sent');
 assert.equal(await h.scalar('SELECT payload FROM ops.outbox WHERE outbox_id=$1', [`account.deletion:${ack.receiptId}`]), null);
 assert.ok(await h.scalar('SELECT count(*)::int FROM economy.ledger WHERE actor_id=$1') > 0, 'immutable journal is explicitly follow-up, never silently deleted');
 assert.equal(await h.scalar("SELECT crowns::int FROM monetization.receipts WHERE transaction_id='b4-retained-purchase'"), 100, 'purchase replay record retained unchanged');
 assert.equal(await h.scalar("SELECT actor_id FROM audit.operator_audit WHERE audit_id='b4-audit'"), h.owner.actor, 'operator security audit retained unchanged');
 assert.equal(await h.scalar("SELECT outcome FROM privacy.reports WHERE report_id='b4-reviewed'"), 'no_action', 'moderation outcome retained');
 assert.equal(await h.scalar("SELECT reporter_id FROM privacy.reports WHERE report_id='b4-reviewed'"), ack.tombstone, 'moderation retained pseudonymously');
 await assert.rejects(h.accounts.cancelDeletion(login.token, h.profile.tag), /AUTH_REQUIRED/);
 assert.deepEqual(await h.worker.tick(), { claimed: 0, completed: 0, failed: 0 });
 return { cooling: true, completed: true, credentialsErased: true, walletErasedByCore: true, permanentReceipt: true, operatorFollowUpExplicit: true };
}
module.exports = { setupDeletion, exerciseCancellation, exerciseCompletion };
