'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const game = require('../src/game.js');
const source = fs.readFileSync(path.join(__dirname, '../apps/web/powers.js'), 'utf8');
const browser = { Date, Object, JSON, Number, String };
vm.runInNewContext(source, browser);
const ui = browser.MegaWebPowers;
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const bank = () => Object.fromEntries(['undo', 'hint', 'undoBlock', 'tacticalBlock'].map(kind => [kind, { available: 0, reserved: 0 }]));

// These are presentation fixtures, not a real provider or Core implementation.
function fixture() {
  const state = { binding: { actorId: 'fixture-actor', matchId: 'fixture-match', revision: 8 }, summary: { mode: 'bot', difficulty: 'Expert', revision: 8, status: 'PLAYING' }, inventory: bank(), undo: { eligible: true, reason: '', ply: 8, charges: 0, perMatchUsed: 0 }, pacing: { rewardedShownToday: 0, rewardedDayCap: 10, nextEligibleAt: 0 }, verified: true, notifications: 0, requests: [], applications: [] };
  const context = { fixtureOnly: true, actorId: state.binding.actorId, matchId: state.binding.matchId, revision: 8 };
  state.adapter = { version: 'powers/v1', inventory: () => state.inventory, eligibility: () => ({ undo: state.undo }), pacing: () => state.pacing,
    request(kind, given) { state.requests.push([kind, given]); return Promise.resolve({ earned: false, reason: 'NO_FILL', entitlement: null }); },
    apply(kind, given) { state.applications.push([kind, given]); return { applied: false, reason: 'STALE_REVISION', revision: 8 }; },
  };
  const controller = ui.createController({ getAdapter: () => state.adapter, getMatchSummary: () => state.summary, getBinding: () => state.binding, getContext: () => context, verifyContext: () => state.verified, now: () => 1000, onChange: () => state.notifications++ });
  return { state, context, controller };
}

test('V52-PW-01 missing and malformed contracts close all actions without inventing counts', async () => {
  const absent = ui.createController({ getMatchSummary: () => ({ mode: 'bot' }) });
  assert.equal(absent.view().available, false);
  assert.match(ui.render(absent.view()), /Earned charges unavailable/);
  assert.doesNotMatch(ui.render(absent.view()), /0 available|2 of 2 earned/);
  assert.equal((await absent.request()).reason, 'UNAVAILABLE');
  for (const corrupt of [s => s.adapter.version = 'powers/v2', s => s.adapter.apply = null, s => s.inventory.hint.available = -1, s => s.inventory.undo.reserved = 0.5, s => s.inventory.version = 'inventory/v0', s => s.undo.charges = 3, s => s.undo.eligible = 'true', s => s.pacing.rewardedDayCap = 4, s => s.pacing.rewardedShownToday = 11, s => s.adapter.pacing = () => { throw Error('fixture'); }]) {
    const { state, controller } = fixture(); corrupt(state); controller.refresh();
    assert.equal(controller.view().available, false);
    assert.equal(controller.view().canRequestUndo, false);
    assert.equal(controller.apply().reason, 'UNAVAILABLE');
    assert.equal((await controller.request()).reason, 'UNAVAILABLE');
    assert.equal(state.requests.length + state.applications.length, 0);
  }
});

test('V52-PW-02 default host gate keeps a valid reader read-only', async () => {
  const { state } = fixture();
  const controller = ui.createController({ getAdapter: () => state.adapter, getMatchSummary: () => state.summary, getBinding: () => state.binding });
  assert.equal(controller.view().available, false);
  assert.equal(controller.view().authorityReady, false);
  assert.equal((await controller.request()).reason, 'UNAVAILABLE');
  assert.equal(controller.apply().reason, 'UNAVAILABLE');
  assert.equal(state.requests.length + state.applications.length, 0);
  assert.doesNotMatch(ui.render(controller.view()), /0 available|2 of 2 earned/);
});

test('V52-PW-03 forbidden modes hide the panel and feature-off eligibility never invokes writes', async () => {
  for (const mode of ['ranked', 'challenge', 'direct', 'staked', 'tournament', 'LAN', 'lan', 'local', undefined]) {
    const { state, controller } = fixture(); state.summary.mode = mode; controller.refresh();
    assert.equal(ui.render(controller.view()), '');
    assert.equal((await controller.request()).reason, 'UNAVAILABLE');
    assert.equal(controller.apply().reason, 'UNAVAILABLE');
    assert.equal(state.requests.length + state.applications.length, 0);
  }
  const { state, controller } = fixture(); state.undo.eligible = false; state.undo.reason = 'FEATURE_OFF'; controller.refresh();
  assert.equal(controller.view().canRequestUndo, false);
  assert.equal((await controller.request()).reason, 'UNAVAILABLE');
  assert.equal(state.requests.length, 0);
  for (const restricted of [{ staked: true }, { ranked: true }, { terms: { source: 'queue', staked: true } }, { terms: { source: 'queue', stake: 1 } }, { terms: { source: 'challenge' } }, { terms: { source: 'tournament' } }, { terms: { source: 'LAN' } }, { quote: { rated: true } }, { quote: { currency: 'Crowns' } }, { quote: { contributions: [1, 0] } }, { quote: { contributions: '0,0' } }]) {
    const { state, controller } = fixture(); Object.assign(state.summary, { mode: 'casual', ...restricted }); controller.refresh();
    assert.equal(ui.render(controller.view()), '');
    assert.equal((await controller.request()).reason, 'UNAVAILABLE');
  }
});

test('V52-PW-04 reported inventory, two charge positions, caps and counterable vocabulary are truthful', () => {
  const { state, controller } = fixture(); state.undo.charges = 2; state.inventory.undoBlock = { available: 1, reserved: 1 }; state.pacing.rewardedShownToday = 9; controller.refresh();
  const html = ui.render(controller.view());
  assert.match(html, /2 of 2 earned charges available/);
  assert.equal((html.match(/gb-powers-charge--earned/g) || []).length, 2);
  assert.match(html, /Undo Block<\/dt><dd>1 available · 1 reserved/);
  assert.match(html, /9 of 10 shown today \(UTC\)/);
  assert.match(html, /2 minutes between exposures/);
  assert.match(html, /Undo Request|Tactical Power|Tactical Block/);
  assert.match(html, /<select disabled/);
  assert.match(html, /does not guarantee|does not|three Undo Request initiations/);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.equal(controller.view().canRequestUndo, false);
  assert.equal(controller.view().canApplyUndo, true);
});

test('V52-PW-05 daily cap, cooldown, reservation and existing charge block another rewarded request', async () => {
  for (const block of [s => s.pacing.rewardedShownToday = 10, s => s.pacing.nextEligibleAt = 1001, s => s.inventory.undo.reserved = 1, s => s.inventory.undo.available = 1, s => s.undo.charges = 1]) {
    const { state, controller } = fixture(); block(state); controller.refresh();
    assert.equal((await controller.request()).reason, 'UNAVAILABLE');
    assert.equal(state.requests.length, 0);
  }
});

test('V52-PW-06 pending reward disables repeated actions and earning never grants or applies locally', async () => {
  const { state, context, controller } = fixture(); const wait = deferred(); state.adapter.request = (kind, given) => { state.requests.push([kind, given]); return wait.promise; };
  const request = controller.request();
  assert.equal(controller.view().pending, 'request');
  assert.match(ui.render(controller.view()), /No item has been added by this page/);
  assert.equal((await controller.request()).reason, 'UNAVAILABLE');
  assert.equal(controller.apply().reason, 'UNAVAILABLE');
  wait.resolve({ earned: true, reason: '', entitlement: 'fixture-entitlement' });
  assert.equal((await request).earned, true);
  assert.equal(state.requests.length, 1); assert.equal(state.requests[0][1], context);
  assert.equal(state.applications.length, 0);
  assert.equal(state.inventory.undo.available, 0); assert.equal(state.undo.charges, 0);
  assert.equal(controller.view().inventory.undo.available, 0);
  assert.match(ui.render(controller.view()), /Reward confirmed/);
});

test('V52-PW-07 late actor, match, revision, mode, settings, feature and adapter results are fenced', async () => {
  for (const change of [s => s.binding.actorId = 'fixture-other', s => s.binding.matchId = 'fixture-new', s => s.binding.revision++, s => s.summary.revision++, s => s.summary.mode = 'casual', s => s.summary.difficulty = 'Easy', s => s.summary.status = 'FINISHED', s => s.verified = false, s => s.adapter = { ...s.adapter }]) {
    const { state, controller } = fixture(); const wait = deferred(); state.adapter.request = () => wait.promise;
    const request = controller.request(); change(state);
    wait.resolve({ earned: true, reason: '', entitlement: 'fixture-late' });
    assert.equal((await request).reason, 'STALE_CONTEXT');
    assert.doesNotMatch(ui.render(controller.view()), /Reward confirmed/);
    assert.equal(state.inventory.undo.available, 0); assert.equal(state.applications.length, 0);
  }
});

test('V52-PW-08 destroy prevents late reward rendering, retries or further reads', async () => {
  const { state, controller } = fixture(); const wait = deferred(); state.adapter.request = () => wait.promise;
  const request = controller.request(); const before = state.notifications;
  controller.destroy(); wait.resolve({ earned: true, reason: '', entitlement: 'fixture-late' });
  assert.equal((await request).reason, 'STALE_CONTEXT');
  assert.equal(controller.view().inventory, null);
  await flush(); assert.equal(state.notifications, before);
  assert.equal((await controller.request()).reason, 'UNAVAILABLE');
  assert.equal(controller.apply().reason, 'UNAVAILABLE');
});

test('V52-PW-08b unverified actor/context retirement clears inventory even before a refresh', () => {
  const { state, controller } = fixture(); state.inventory.undo.available = 1; state.undo.charges = 2; controller.refresh();
  assert.match(ui.render(controller.view()), /2 of 2 earned/);
  state.binding.actorId = 'fixture-next'; state.verified = false;
  assert.equal(controller.view().inventory, null);
  assert.doesNotMatch(ui.render(controller.view()), /1 available|2 of 2 earned/);
  controller.refresh(); assert.equal(controller.view().inventory, null);
  state.binding.actorId = 'fixture-actor'; state.verified = true;
  assert.equal(controller.view().inventory, null, 'returning to an actor requires a fresh verified read');
  controller.refresh(); assert.equal(controller.view().inventory.undo.available, 1);
});

test('V52-PW-09 no-fill, skipped, pending and reconnect remain distinct without changing bank counts', async () => {
  for (const [reason, copy] of [['NO_FILL', /No ad was available/], ['FAILED_TO_PRESENT', /could not open/], ['SKIPPED', /uses a daily exposure slot/], ['PENDING', /confirmation is pending/], ['RECONNECT_REQUIRED', /Reconnect to check/]]) {
    const { state, controller } = fixture(); state.adapter.request = () => Promise.resolve({ earned: false, reason, entitlement: null });
    assert.equal((await controller.request()).reason, reason);
    assert.match(ui.render(controller.view()), copy);
    assert.equal(state.inventory.undo.available, 0); assert.equal(state.pacing.rewardedShownToday, 0);
    if (['PENDING', 'RECONNECT_REQUIRED'].includes(reason)) {
      controller.refresh(); assert.equal(controller.view().canRequestUndo, false);
      assert.equal((await controller.request()).reason, 'UNAVAILABLE');
    }
  }
});

test('V52-PW-10 incomplete reward/apply responses never imply successful use or reveal unapproved advice', async () => {
  const { state, controller } = fixture();
  state.adapter.request = () => Promise.resolve({ earned: true, reason: '', entitlement: null, hint: 'PRIVATE-SQUARE-8:8' });
  assert.equal((await controller.request()).reason, 'INVALID_RESULT');
  state.summary.revision++; state.binding.revision++; controller.refresh();
  state.undo.charges = 1;
  state.adapter.eligibility = () => ({ undo: state.undo, hint: { suggestedMove: 'PRIVATE-SQUARE-8:8', settled: false } });
  state.adapter.apply = () => ({ applied: false, reason: 'BLOCKED', revision: 8, hint: 'PRIVATE-SQUARE-8:8', legalSquare: { b: 8, c: 8 } });
  controller.refresh(); assert.equal(controller.apply().reason, 'BLOCKED');
  assert.doesNotMatch(JSON.stringify(controller.view()), /PRIVATE-SQUARE|suggestedMove|legalSquare/);
  assert.doesNotMatch(ui.render(controller.view()), /PRIVATE-SQUARE|8:8/);
  assert.match(ui.render(controller.view()), /No Tactical suggestion is revealed/);
  assert.equal(controller.apply('hint').reason, 'UNAVAILABLE');
  assert.equal(controller.apply('undoBlock').reason, 'UNAVAILABLE');
  assert.equal(controller.apply('tacticalBlock').reason, 'UNAVAILABLE');
});

test('V52-PW-11 apply forwards the exact host context and leaves bank/match authority untouched', () => {
  const { state, context, controller } = fixture(); state.inventory.undo.available = 1;
  state.adapter.apply = (kind, given) => { state.applications.push([kind, given]); return { applied: true, reason: '', revision: 9 }; };
  controller.refresh(); assert.equal(controller.apply().applied, true);
  assert.equal(state.applications[0][1], context);
  assert.equal(state.inventory.undo.available, 1); assert.equal(state.binding.revision, 8);
  assert.match(ui.render(controller.view()), /Waiting for the authoritative match state/);
});

test('V52-PW-11b Tactical advice is discarded throughout pending and blocked fixture responses', async () => {
  const { state, controller } = fixture(); const wait = deferred();
  state.adapter.eligibility = () => ({ undo: state.undo, hint: { eligible: true, settled: false, suggestedMove: 'PRIVATE-HINT-4:1' } });
  state.adapter.request = () => wait.promise; controller.refresh();
  const request = controller.request();
  assert.equal((await controller.request('hint')).reason, 'UNAVAILABLE');
  assert.equal(controller.apply('tacticalBlock').reason, 'UNAVAILABLE');
  assert.doesNotMatch(ui.render(controller.view()), /PRIVATE-HINT|4:1/);
  wait.resolve({ earned: false, reason: 'BLOCKED', entitlement: null, counter: { status: 'BLOCKED', suggestion: 'PRIVATE-HINT-4:1' } });
  assert.equal((await request).reason, 'BLOCKED');
  assert.doesNotMatch(ui.render(controller.view()), /PRIVATE-HINT|4:1/);
  assert.doesNotMatch(JSON.stringify(controller.view()), /PRIVATE-HINT|suggestedMove|counter/);
});

test('V52-PW-12 practice mounting remains read-only and preserves preview, tutorial and online exclusions', async () => {
  const boardSource = fs.readFileSync(path.join(__dirname, '../apps/web/board.js'), 'utf8');
  const board = await import(`data:text/javascript;base64,${Buffer.from(boardSource).toString('base64')}`);
  globalThis.MegaGame = game; globalThis.MegaWebPowers = ui;
  const { state } = fixture(); browser.MegaPowers = state.adapter;
  const listeners = new Map(); const host = { dataset: {}, addEventListener: (kind, fn) => listeners.set(kind, fn), removeEventListener: kind => listeners.delete(kind), contains: () => true, querySelector: () => null, querySelectorAll: () => [], innerHTML: '' };
  try {
    assert.doesNotMatch(board.renderPreview(), /data-gb-powers/);
    const mount = board.mountBoard(host, { preview: false });
    assert.match(host.innerHTML, /Bot Undo/);
    assert.match(host.innerHTML, /data-gb-power="request" disabled/);
    listeners.get('click')({ target: { closest: selector => selector === '[data-gb-power]' ? { dataset: { gbPower: 'request' } } : null } });
    assert.equal(state.requests.length + state.applications.length, 0);
    mount.destroy();
    const match = { id: 'fixture-online', status: 'PLAYING', state: game.create(), symbols: { X: 'fixture-x', O: 'fixture-o' }, revision: 0, quote: { rated: false }, terms: { source: 'queue' } };
    assert.doesNotMatch(board.renderGame({ match, actorId: 'fixture-x' }), /data-gb-powers/);
    const css = fs.readFileSync(path.join(__dirname, '../apps/web/powers.css'), 'utf8');
    assert.match(css, /var\(--gb-ink\)/); assert.match(css, /forced-colors/); assert.match(css, /min-height: 44px/);
  } finally { delete globalThis.MegaGame; delete globalThis.MegaWebPowers; delete browser.MegaPowers; }
});
