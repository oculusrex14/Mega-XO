'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const game = require('../src/game.js');
const source = fs.readFileSync(path.join(__dirname, '../apps/web/board.js'), 'utf8');
const board = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

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
    assert.match(html, /Interactive<br>practice preview/);
    assert.match(html, /Centre board,.*legal move/);
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /Start a fresh practice game/);
    assert.doesNotMatch(html, /1620|1580|RivalPlayer|01:24|Rating|Ranked Match/);
    const practice = renderPractice();
    assert.match(practice, /data-board-preview="false"/);
    assert.match(practice, /Two players · same screen/);
    assert.deepEqual(GAME_THEMES.map(item => item.id), ['vector', 'midnight', 'paperclub', 'afterhours']);
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
  const stage = { dataset: { gbTheme: 'vector' } };
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
    instance.destroy();
  } finally { delete globalThis.MegaGame; }
});
