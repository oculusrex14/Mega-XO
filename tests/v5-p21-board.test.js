'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const game = require('../src/game.js');
const source = fs.readFileSync(path.join(__dirname, '../apps/web/board.js'), 'utf8');
const board = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function boardHost(dataset = {}) {
  const listeners = new Map();
  let html = '';
  const host = {
    dataset,
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type, callback) { if (listeners.get(type) === callback) listeners.delete(type); },
    contains: () => true,
    querySelector: () => null,
    querySelectorAll: () => [],
    get innerHTML() { return html; },
    set innerHTML(value) { html = value; },
  };
  return {
    host, listeners,
    clickCell(key) { listeners.get('click')({ target: { closest: () => ({ dataset: { gbCell: key }, getAttribute: () => 'false' }) } }); },
    clickAction(action) { listeners.get('click')({ target: { closest: () => ({ dataset: { gbAction: action } }) } }); },
  };
}

function matchSnapshot(state = game.create(), extra = {}) {
  return { id: 'match-1', status: 'PLAYING', state, symbols: { X: 'actor-x', O: 'actor-o' }, playerNames: { 'actor-x': 'Alex', 'actor-o': 'Sam' }, revision: state.moves.length, terms: { source: 'queue' }, quote: { rated: false }, ...extra };
}

const flushCallbacks = () => new Promise(resolve => setImmediate(resolve));

test('P21.03 practice showcase is a reproducible legal rules fixture with centre routing', async () => {
  const { generatePreviewState } = await board;
  const fixture = generatePreviewState(game);
  let replay = game.create();
  for (const move of fixture.moves) {
    assert.equal(move.player, replay.turn);
    assert.ok(game.legal(replay).some(item => item.b === move.b && item.c === move.c));
    replay = game.apply(replay, move);
  }
  assert.deepEqual(fixture, replay);
  assert.deepEqual(generatePreviewState(game), fixture);
  assert.equal(fixture.turn, 'X');
  assert.equal(fixture.required, 4);
  assert.equal(fixture.winner, null);
  assert.equal(fixture.moves.length, 20);
  assert.ok(game.legal(fixture).every(move => move.b === 4));
});

test('P21.05 local practice enforces required board and preserves state after an illegal move', async () => {
  const { createBoardSession } = await board;
  const session = createBoardSession(game);
  const next = session.move({ b: 0, c: 4 });
  assert.equal(next.required, 4);
  assert.equal(next.turn, 'O');
  assert.equal(next.board[0][4], 'X');
  assert.ok(session.legal().every(move => move.b === 4));
  assert.throws(() => session.move({ b: 0, c: 3 }), /ILLEGAL_MOVE/);
  assert.equal(session.getState(), next);
  session.move({ b: 4, c: 0 });
  assert.equal(session.getState().required, 0);
  assert.throws(() => session.move({ b: 0, c: 4 }), /ILLEGAL_MOVE/);
  assert.deepEqual(session.reset(), game.create());
  assert.equal(session.legal().length, 81);
});

test('P21.05 preview reset replays the fixture and fresh practice clears every move', async () => {
  const { createBoardSession, generatePreviewState } = await board;
  const session = createBoardSession(game, { preview: true });
  session.move(session.legal()[0]);
  assert.equal(session.getState().moves.length, 21);
  assert.deepEqual(session.reset(), generatePreviewState(game));
  assert.deepEqual(session.reset({ fresh: true }), game.create());
});

test('P21.03 accessible board uses 81 real cells and truthful practice labels', async () => {
  const { renderPreview, renderPractice, GAME_THEMES } = await board;
  globalThis.MegaGame = game;
  try {
    const html = renderPreview();
    assert.equal((html.match(/data-gb-cell="/g) || []).length, 81);
    assert.equal((html.match(/data-gb-mini="/g) || []).length, 9);
    assert.equal((html.match(/class="gb-mini gb-mini--active"/g) || []).length, 1);
    assert.match(html, /aria-label="Interactive practice preview against Bot"/);
    assert.doesNotMatch(html.replace(/<[^>]*>/g, ''), /Interactive practice preview/);
    assert.match(html, /<b>Bot<\/b>/);
    assert.match(html, /Centre board,.*legal move/);
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /href="\/game" data-route>Start a fresh game/);
    assert.doesNotMatch(html, /1620|1580|RivalPlayer|01:24|Rating|Ranked Match/);
    const practice = renderPractice();
    assert.match(practice, /data-board-preview="false"/);
    assert.match(practice, /Two players · same screen/);
    assert.deepEqual(GAME_THEMES.map(item => item.id), ['cinematic', 'vector', 'midnight', 'paperclub', 'afterhours']);
    assert.match(practice, /data-board-theme="cinematic"/);
    assert.match(practice, /value="cinematic" selected>Mega XOXO Neon/);
    for (const item of GAME_THEMES) assert.match(practice, new RegExp(`value="${item.id}"`));
  } finally { delete globalThis.MegaGame; }
});

test('P21.05 bot cannot mutate a destroyed board mount', async () => {
  const { mountBoard } = await board;
  globalThis.MegaGame = game;
  const listeners = new Map();
  let rendered = '';
  const host = {
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type, callback) { if (listeners.get(type) === callback) listeners.delete(type); },
    contains: () => true,
    querySelector: () => null,
    get innerHTML() { return rendered; },
    set innerHTML(value) { rendered = value; },
  };
  try {
    const instance = mountBoard(host, { preview: false });
    const cell = { dataset: { gbCell: '0:4' }, getAttribute: () => 'false' };
    listeners.get('click')({ target: { closest: () => cell } });
    assert.equal(instance.getState().moves.length, 1);
    instance.destroy();
    await new Promise(resolve => setTimeout(resolve, 320));
    assert.equal(instance.getState().moves.length, 1);
    assert.equal(listeners.size, 0);
  } finally { delete globalThis.MegaGame; }
});

test('P21.05 keyboard navigation crosses small boards in visual row order', async () => {
  const { mountBoard } = await board;
  globalThis.MegaGame = game;
  const listeners = new Map();
  let focused = null;
  const cells = Array.from({ length: 9 }, (_, b) => Array.from({ length: 9 }, (_, c) => ({ dataset: { gbCell: `${b}:${c}` }, tabIndex: -1 }))).flat();
  const host = {
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type) { listeners.delete(type); },
    contains: () => true,
    querySelectorAll: () => cells,
    querySelector(selector) {
      const match = selector.match(/data-gb-cell="([0-8]:[0-8])"/);
      return match ? { focus() { focused = match[1]; } } : null;
    },
    innerHTML: '',
  };
  try {
    const instance = mountBoard(host, { preview: false });
    let prevented = false;
    listeners.get('keydown')({ key: 'ArrowRight', preventDefault() { prevented = true; }, target: { closest: () => cells.find(cell => cell.dataset.gbCell === '0:2') } });
    assert.equal(prevented, true);
    assert.equal(focused, '1:0');
    assert.equal(cells.find(cell => cell.tabIndex === 0).dataset.gbCell, '1:0');
    listeners.get('keydown')({ key: 'ArrowDown', preventDefault() {}, target: { closest: () => cells.find(cell => cell.dataset.gbCell === '0:6') } });
    assert.equal(focused, '3:0');
    assert.equal(instance.getState().moves.length, 0);
    instance.destroy();
  } finally { delete globalThis.MegaGame; }
});

test('P21.05 theme switch changes presentation without resetting a mounted move', async () => {
  const { mountBoard } = await board;
  globalThis.MegaGame = game;
  const listeners = new Map();
  const stage = { dataset: { gbTheme: 'cinematic' } };
  let renderCount = 0;
  const host = {
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type) { listeners.delete(type); },
    contains: () => true,
    querySelector: selector => selector === '[data-gb-stage]' ? stage : null,
    set innerHTML(value) { renderCount += 1; },
  };
  try {
    const instance = mountBoard(host, { preview: false });
    listeners.get('change')({ target: { dataset: { gbSetting: 'mode' }, value: 'local' } });
    const cell = { dataset: { gbCell: '0:4' }, getAttribute: () => 'false' };
    listeners.get('click')({ target: { closest: () => cell } });
    const state = instance.getState();
    const before = renderCount;
    listeners.get('change')({ target: { dataset: { gbSetting: 'theme' }, value: 'paperclub' } });
    assert.equal(stage.dataset.gbTheme, 'paperclub');
    assert.equal(renderCount, before);
    assert.equal(instance.getState(), state);
    assert.equal(instance.getState().required, 4);
    listeners.get('change')({ target: { dataset: { gbSetting: 'theme' }, value: 'cinematic' } });
    assert.equal(stage.dataset.gbTheme, 'cinematic');
    assert.equal(renderCount, before);
    assert.equal(instance.getState(), state);
    instance.destroy();
  } finally { delete globalThis.MegaGame; }
});

test('P21.05 game route stays inside the website, sanitizes settings and preserves approved mode choices', async () => {
  const { renderGame, renderPractice, GAME_THEMES } = await board;
  globalThis.MegaGame = game;
  try {
    const html = renderGame({ mode: 'local', difficulty: 'Expert', theme: 'paperclub' });
    assert.match(html, /class="gb-practice-page gb-game-page"/);
    assert.match(html, /data-board-mode="local" data-board-difficulty="Expert" data-board-theme="paperclub"/);
    assert.match(html, /<b>Player X<\/b>/);
    assert.match(html, /<b>Player O<\/b>/);
    assert.match(html, /value="local" selected/);
    assert.equal((html.match(/data-gb-cell="/g) || []).length, 81);
    assert.equal((html.match(/, legal move"/g) || []).length, 81);
    for (const mode of ['ranked','casual','friends']) assert.match(html, new RegExp(`value="${mode}"`));
    assert.match(html, /<details class="gb-game-panel gb-help-panel"/);
    assert.match(html, /data-online-controls/);
    for (const theme of GAME_THEMES) assert.match(html, new RegExp(`value="${theme.id}"`));
    for (const level of game.LEVELS) assert.match(html, new RegExp(`<option(?: selected)?>${level}</option>`));
    const unsafe = renderGame({ mode: '"><script>alert(1)</script>', theme: '"><img src=x onerror=alert(1)>', difficulty: 'Impossible' });
    assert.match(unsafe, /data-board-mode="bot" data-board-difficulty="Easy" data-board-theme="cinematic"/);
    assert.doesNotMatch(unsafe, /<script|onerror|Impossible|legacy-game/);
    assert.match(renderPractice(), /gb-legacy-practice-page/);
    assert.doesNotMatch(renderPractice(), /gb-dashboard|data-board-layout="workspace"/);
  } finally { delete globalThis.MegaGame; }
});

test('P21.05 browser Neon defaults apply to local and server boards while original themes stay selectable', async () => {
  const { renderGame, mountBoard } = await board;
  globalThis.MegaGame = game;
  try {
    const fresh = renderGame();
    assert.match(fresh, /data-gb-theme="cinematic"/);
    assert.match(fresh, /value="cinematic" selected/);
    for (const theme of ['vector', 'midnight', 'paperclub', 'afterhours']) {
      const html = renderGame({ theme });
      assert.match(html, new RegExp(`data-gb-theme="${theme}"`));
      assert.match(html, new RegExp(`value="${theme}" selected`));
    }
    const ui = boardHost();
    const state = game.apply(game.create(), { b: 0, c: 4 });
    const mounted = mountBoard(ui.host, { online: { match: matchSnapshot(state), actorId: 'actor-o', onMove() {} } });
    assert.match(ui.host.innerHTML, /data-gb-theme="cinematic"/);
    assert.match(ui.host.innerHTML, /value="cinematic" selected/);
    assert.deepEqual(mounted.getState(), state);
    mounted.destroy();
  } finally { delete globalThis.MegaGame; }
});

test('P21.05 explicitly selected same-screen mode follows both turns without scheduling Bot', async () => {
  const { mountBoard } = await board;
  globalThis.MegaGame = { ...game, choose() { throw new Error('Local mode must not schedule Bot'); } };
  const ui = boardHost({ boardMode: 'local', boardTheme: 'midnight', boardDifficulty: 'Hard' });
  try {
    const mounted = mountBoard(ui.host, { preview: false });
    assert.match(ui.host.innerHTML, /data-gb-theme="midnight"/);
    ui.clickCell('0:4');
    ui.clickCell('0:3');
    assert.equal(mounted.getState().moves.length, 1);
    ui.clickCell('4:0');
    assert.equal(mounted.getState().moves.length, 2);
    assert.equal(mounted.getState().turn, 'X');
    assert.equal(mounted.getState().required, 0);
    assert.equal(mounted.getState().board[4][0], 'O');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(mounted.getState().moves.length, 2);
    ui.clickAction('fresh');
    assert.deepEqual(mounted.getState(), game.create());
    mounted.destroy();
  } finally { delete globalThis.MegaGame; }
});

test('P21.05 Bot response uses the retained legal route and a fresh game fences its queued response', async () => {
  const { mountBoard } = await board;
  let searched = 0;
  globalThis.MegaGame = { ...game, choose(state, level) { searched += 1; assert.equal(level, 'Hard'); return game.legal(state)[0]; } };
  const ui = boardHost();
  try {
    const mounted = mountBoard(ui.host, { preview: false, mode: 'bot', difficulty: 'Hard' });
    ui.clickCell('0:4');
    assert.match(ui.host.innerHTML, /Bot is thinking/);
    ui.clickCell('4:3');
    assert.equal(mounted.getState().moves.length, 1);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(searched, 1);
    assert.deepEqual(mounted.getState().moves[1], { b: 4, c: 0, player: 'O' });
    assert.equal(mounted.getState().required, 0);
    ui.clickCell('0:1');
    ui.clickAction('fresh');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(searched, 1);
    assert.deepEqual(mounted.getState(), game.create());
    mounted.destroy();
  } finally { delete globalThis.MegaGame; }
});

test('P21.05 server session rejects stale history, changed identities and invalid board shapes', async () => {
  const { createServerBoardSession } = await board;
  const state = game.apply(game.create(), { b: 0, c: 4 });
  const initial = matchSnapshot(state);
  const session = createServerBoardSession(game, initial, { actorId: 'actor-o' });
  initial.state.board[0][4] = null;
  assert.equal(session.getState().board[0][4], 'X');
  assert.equal(session.canPlay(), true);
  assert.ok(session.legal().every(move => move.b === 4));
  assert.equal(session.receive(matchSnapshot()), false);
  assert.equal(session.receive(matchSnapshot(state, { id: 'another-match' })), false);
  assert.equal(session.receive(matchSnapshot(state, { symbols: { X: 'actor-z', O: 'actor-o' } })), false);
  const divergent = game.apply(game.create(), { b: 0, c: 3 });
  assert.equal(session.receive(matchSnapshot(divergent)), false);
  assert.equal(session.receive(matchSnapshot(state, { revision: 0 })), false);
  assert.throws(() => session.receive(matchSnapshot({ ...state, board: [[]] })), /INVALID_MATCH_SNAPSHOT/);
  const finished = matchSnapshot(state, { status: 'FINISHED', receipt: { winner: 'actor-o' } });
  assert.equal(session.receive(finished), true);
  assert.equal(session.canPlay(), false);
  assert.deepEqual(session.legal(), []);
  assert.equal(session.receive(matchSnapshot(state, { revision: 2 })), false);
});

test('P21.05 online moves remain server-owned, serialize and use the authoritative move revision', async () => {
  const { mountBoard } = await board;
  const initial = matchSnapshot();
  const confirmed = matchSnapshot(game.apply(initial.state, { b: 0, c: 4 }));
  globalThis.MegaGame = { ...game, create() { throw new Error('Online must not create local state'); }, apply() { throw new Error('Online must not apply local moves'); } };
  const ui = boardHost();
  const sent = [];
  let resolveMove;
  try {
    const mounted = mountBoard(ui.host, { online: { match: initial, actorId: 'actor-x', operationId: () => 'move-key-1', onMove(request) { sent.push(request); return new Promise(resolve => { resolveMove = resolve; }); } } });
    ui.clickCell('0:4');
    ui.clickCell('0:3');
    assert.deepEqual(sent, [{ id: 'match-1', revision: 0, move: { b: 0, c: 4 }, key: 'move-key-1' }]);
    assert.equal(mounted.getState().moves.length, 0);
    assert.equal(mounted.getState().board[0][4], null);
    assert.match(ui.host.innerHTML, /Sending your move/);
    assert.equal((ui.host.innerHTML.match(/, legal move"/g) || []).length, 0);
    mounted.reset();
    assert.equal(mounted.getState().moves.length, 0);
    resolveMove(confirmed);
    await flushCallbacks();
    assert.equal(mounted.getState().moves.length, 1);
    assert.equal(mounted.getState().required, 4);
    assert.match(ui.host.innerHTML, /Opponent’s move/);
    ui.clickCell('4:0');
    assert.equal(sent.length, 1);
    const both = matchSnapshot(game.apply(confirmed.state, { b: 4, c: 0 }));
    assert.equal(mounted.receive(both), true);
    assert.equal((ui.host.innerHTML.match(/, legal move"/g) || []).length, 8);
    assert.equal(mounted.receive(initial), false);
    assert.equal(mounted.getState().moves.length, 2);
    mounted.destroy();
  } finally { delete globalThis.MegaGame; }
});

test('P21.05 a failed online move retries its original idempotency key without optimistic mutation', async () => {
  const { mountBoard } = await board;
  globalThis.MegaGame = game;
  const ui = boardHost();
  const sent = [];
  const confirmed = matchSnapshot(game.apply(game.create(), { b: 0, c: 4 }));
  try {
    const mounted = mountBoard(ui.host, { online: { match: matchSnapshot(), actorId: 'actor-x', operationId: () => 'stable-key', onMove(request) { sent.push(request); return sent.length === 1 ? Promise.reject(new Error('NETWORK_ERROR')) : confirmed; } } });
    ui.clickCell('0:4');
    await flushCallbacks();
    assert.equal(mounted.getState().moves.length, 0);
    assert.match(ui.host.innerHTML, /data-gb-action="retry">Retry move/);
    ui.clickCell('0:3');
    assert.equal(sent.length, 1);
    ui.clickAction('retry');
    await flushCallbacks();
    assert.deepEqual(sent[1], sent[0]);
    assert.equal(mounted.getState().moves.length, 1);
    assert.doesNotMatch(ui.host.innerHTML, /Retry move|Connection interrupted|Sending your move/);
    mounted.destroy();
  } finally { delete globalThis.MegaGame; }
});

test('P21.05 auth-required online state offers sign in and never retries as a service outage', async () => {
  const { mountBoard } = await board;
  globalThis.MegaGame = game;
  const ui = boardHost();
  let sent = 0;
  try {
    const mounted = mountBoard(ui.host, { online: { match: matchSnapshot(), actorId: 'actor-x', operationId: () => 'auth-key', onMove() { sent += 1; return Promise.reject(Object.assign(new Error('Account link required'), { code: 'LINK_ACCOUNT_REQUIRED' })); } } });
    ui.clickCell('0:4');
    await flushCallbacks();
    assert.match(ui.host.innerHTML, /href="\/account" data-route>Sign in to play online/);
    assert.doesNotMatch(ui.host.innerHTML, /Connection interrupted|Retry move/);
    ui.clickCell('0:3');
    ui.clickAction('retry');
    assert.equal(sent, 1);
    assert.equal(mounted.getState().moves.length, 0);
    assert.equal(mounted.receive(matchSnapshot()), true);
    assert.doesNotMatch(ui.host.innerHTML, /Sign in to play online/);
    mounted.destroy();
  } finally { delete globalThis.MegaGame; }
});

test('P21.05 online callbacks cannot mutate a destroyed board and server names are escaped', async () => {
  const { mountBoard, renderGame } = await board;
  globalThis.MegaGame = game;
  const initial = matchSnapshot(game.create(), { playerNames: { 'actor-o': '"><img src=x onerror=alert(1)>' } });
  const ui = boardHost();
  let resolveMove;
  try {
    const html = renderGame({ match: initial, actorId: 'actor-x' });
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(html, /<img|Local game · no account needed/);
    const mounted = mountBoard(ui.host, { online: { match: initial, actorId: 'actor-x', operationId: () => 'destroy-key', onMove() { return new Promise(resolve => { resolveMove = resolve; }); } } });
    ui.clickCell('0:4');
    const rendered = ui.host.innerHTML;
    mounted.destroy();
    resolveMove(matchSnapshot(game.apply(game.create(), { b: 0, c: 4 })));
    await flushCallbacks();
    assert.equal(mounted.getState().moves.length, 0);
    assert.equal(ui.host.innerHTML, rendered);
    assert.equal(mounted.receive(initial), false);
    assert.equal(ui.listeners.size, 0);
  } finally { delete globalThis.MegaGame; }
});

test('P21.05 resignation waits for a server result, supports cancelled confirmation, and excludes spectators', async () => {
  const { mountBoard } = await board;
  globalThis.MegaGame = game;
  const ui = boardHost();
  const spectator = boardHost();
  const requests = [];
  let resolveResign;
  let mounted;
  let watching;
  try {
    mounted = mountBoard(ui.host, { online: { match: matchSnapshot(), actorId: 'actor-x', operationId: () => 'resign-key', onMove() {}, onResign(request) { requests.push(request); return requests.length === 1 ? false : new Promise(resolve => { resolveResign = resolve; }); } } });
    ui.clickAction('resign');
    await flushCallbacks();
    assert.match(ui.host.innerHTML, /Your move/);
    assert.equal(mounted.getState().winner, null);
    ui.clickAction('resign');
    ui.clickAction('resign');
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1], { id: 'match-1', revision: 0, key: 'resign-key' });
    assert.match(ui.host.innerHTML, /Ending match/);
    assert.equal(mounted.getState().winner, null);
    resolveResign(matchSnapshot(game.create(), { status: 'FINISHED', receipt: { winner: 'actor-o' } }));
    await flushCallbacks();
    assert.match(ui.host.innerHTML, /Match finished/);
    assert.doesNotMatch(ui.host.innerHTML, /data-gb-action="resign"/);
    watching = mountBoard(spectator.host, { online: { match: matchSnapshot(), actorId: 'observer', onMove() { throw new Error('Spectator cannot move'); }, onResign() { throw new Error('Spectator cannot resign'); } } });
    assert.doesNotMatch(spectator.host.innerHTML, /data-gb-action="resign"|, legal move"/);
    spectator.clickCell('0:4');
    spectator.clickAction('resign');
    assert.equal(watching.getState().moves.length, 0);
  } finally { mounted?.destroy(); watching?.destroy(); delete globalThis.MegaGame; }
});
