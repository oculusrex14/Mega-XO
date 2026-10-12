'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const game = require('../src/game.js');
const lesson = require('../src/tutorial/lesson.js');
const runtime = require('../src/bot/runtime.js');
const contract = require('../src/bot/contracts.js');
const domain = require('../src/domain.js');

// Set globals for modules that resolve from globalThis
globalThis.MegaGame = game;
globalThis.MegaLesson = lesson;
globalThis.MegaBotRuntime = runtime;
globalThis.MegaBotContract = contract;

require('../apps/web/bot-compat.js');
const compat = globalThis.MegaWebBotCompat;
const boardSource = fs.readFileSync(path.join(__dirname, '../apps/web/board.js'), 'utf8');
const boardPromise = import(`data:text/javascript;base64,${Buffer.from(boardSource).toString('base64')}`);

function mockHost(dataset = {}) {
  const listeners = new Map();
  let html = '';
  const startListeners = new Map();
  const documentListeners = new Map();
  const startButton = {
    addEventListener(type, callback) { startListeners.set(type, callback); },
    removeEventListener(type, callback) {
      if (startListeners.get(type) === callback) startListeners.delete(type);
    },
  };
  const host = {
    dataset,
    addEventListener(type, callback) {
      const list = listeners.get(type) || [];
      list.push(callback);
      listeners.set(type, list);
    },
    removeEventListener(type, callback) {
      const list = listeners.get(type) || [];
      listeners.set(type, list.filter(cb => cb !== callback));
    },
    contains: target => target !== startButton,
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => ({ querySelector: () => startButton }),
    get innerHTML() { return html; },
    set innerHTML(value) { html = value; },
    ownerDocument: {
      querySelector: () => null,
      activeElement: null,
      hidden: false,
      addEventListener(type, callback) { documentListeners.set(type, callback); },
      removeEventListener(type, callback) {
        if (documentListeners.get(type) === callback) documentListeners.delete(type);
      },
    },
  };
  function dispatch(type, event) {
    const list = listeners.get(type) || [];
    for (const cb of list) cb(event);
  }
  return {
    host,
    listeners,
    clickSidebarStart() { startListeners.get('click')?.({ target: startButton }); },
    setHidden(hidden) {
      host.ownerDocument.hidden = hidden;
      documentListeners.get('visibilitychange')?.();
    },
    clickCell(key) {
      dispatch('click', {
        target: {
          closest: sel => sel.includes('[data-gb-cell]') ? { dataset: { gbCell: key }, getAttribute: () => 'false' } : null,
        },
      });
    },
    clickAction(action) {
      dispatch('click', {
        target: {
          closest: sel => sel.includes('[data-gb-action]') ? { dataset: { gbAction: action } } : null,
        },
      });
    },
    clickGuided(action) {
      dispatch('click', {
        target: {
          closest: sel => sel.includes('[data-gb-guided]') ? { dataset: { gbGuided: action } } : null,
        },
      });
    },
    changeSetting(setting, value) {
      dispatch('change', {
        target: {
          dataset: { gbSetting: setting },
          value,
        },
      });
    },
  };
}

function mockWorkerFactory(onMessageCapture = null) {
  const workers = [];
  const factory = () => {
    const w = {
      terminated: false,
      postMessage(msg) {
        this.lastMessage = msg;
        onMessageCapture?.(msg, this);
      },
      terminate() {
        this.terminated = true;
      },
      reply(payload) {
        if (this.onmessage) {
          this.onmessage({
            data: {
              ...payload,
              requestId: this.lastMessage?.requestId,
            },
          });
        }
      },
    };
    workers.push(w);
    return w;
  };
  return { factory, workers };
}

test('P21-I01 sidebar starts its own tutorial and cannot reset a retired board', async () => {
  const { mountBoard } = await boardPromise;
  const first = mockHost({ boardMode: 'local' });
  const second = mockHost({ boardMode: 'local' });
  const firstBoard = mountBoard(first.host, { preview: false });
  const secondBoard = mountBoard(second.host, { preview: false });
  try {
    first.clickSidebarStart();
    assert.equal(firstBoard.getTutorialSnapshot()?.phase, 'PROMPT');
    assert.equal(secondBoard.getTutorialSnapshot(), null);
    first.clickGuided('continue');
    first.clickCell('0:4');
    assert.deepEqual(firstBoard.getState().moves, [{ b: 0, c: 4, player: 'X' }]);
    assert.equal(firstBoard.getState().required, 4);
    const committed = firstBoard.getState();
    firstBoard.destroy();
    first.clickSidebarStart();
    assert.equal(firstBoard.getState(), committed);
    assert.deepEqual(secondBoard.getState().moves, []);
  } finally {
    firstBoard.destroy();
    secondBoard.destroy();
  }
});

test('P21-I01 exact six halfmoves claim mini0 and preserve live free route without reset', async () => {
  const { mountBoard } = await boardPromise;
  const ui = mockHost({ boardMode: 'bot' });
  const instance = mountBoard(ui.host, { preview: false, tutorial: true });
  const matchRecipe = instance.getBotState();

  let state = instance.getState();
  assert.equal(state.moves.length, 0);
  assert.equal(state.turn, 'X');
  assert.equal(state.mini[0], null);

  // Prompt phase: clicking Continue shows first move
  ui.clickGuided('continue');

  // Step 1: Human plays {b:0, c:4}
  ui.clickCell('0:4');
  state = instance.getState();
  assert.equal(state.moves.length, 1);
  assert.deepEqual(state.moves[0], { b: 0, c: 4, player: 'X' });
  assert.equal(state.required, 4);

  // Step 2: Bot plays {b:4, c:0} on Continue acknowledgment
  ui.clickGuided('continue');
  state = instance.getState();
  assert.equal(state.moves.length, 2);
  assert.deepEqual(state.moves[1], { b: 4, c: 0, player: 'O' });
  assert.equal(state.required, 0);

  // Step 3: Human plays {b:0, c:3}
  ui.clickCell('0:3');
  state = instance.getState();
  assert.equal(state.moves.length, 3);
  assert.deepEqual(state.moves[2], { b: 0, c: 3, player: 'X' });
  assert.equal(state.required, 3);

  // Step 4: Bot plays {b:3, c:0} on Continue acknowledgment
  ui.clickGuided('continue');
  state = instance.getState();
  assert.equal(state.moves.length, 4);
  assert.deepEqual(state.moves[3], { b: 3, c: 0, player: 'O' });
  assert.equal(state.required, 0);

  // Step 5: Human plays {b:0, c:5} (completes middle row of board 0)
  ui.clickCell('0:5');
  state = instance.getState();
  assert.equal(state.moves.length, 5);
  assert.deepEqual(state.moves[4], { b: 0, c: 5, player: 'X' });
  assert.equal(state.mini[0], 'X', 'Board 0 must be claimed by X after 3 in a row');

  // Step 6: Bot plays {b:5, c:0} on Continue acknowledgment
  ui.clickGuided('continue');
  state = instance.getState();
  assert.equal(state.moves.length, 6);
  assert.deepEqual(state.moves[5], { b: 5, c: 0, player: 'O' });

  // ACCEPTANCE INVARIANTS: mini0===X, turn===X, required===null, winner===null
  assert.equal(state.mini[0], 'X', 'mini[0] must remain X');
  assert.equal(state.turn, 'X', 'turn must be X');
  assert.equal(state.required, null, 'required must be null (free choice because destination board 0 is closed)');
  assert.equal(state.winner, null, 'no overall winner yet');
  assert.equal(game.legal(state).length, 69, 'all open cells across 8 open boards are legal');

  // Final Continue acknowledgment: handoff to unguided Beginner without board reset
  ui.clickGuided('continue');
  const postHandoff = instance.getState();
  assert.equal(postHandoff, state, 'State must be preserved without board reset');
  assert.equal(postHandoff.moves.length, 6);
  assert.equal(postHandoff.mini[0], 'X');
  assert.equal(postHandoff.turn, 'X');
  assert.equal(postHandoff.required, null);
  assert.equal(postHandoff.winner, null);
  assert.deepEqual(instance.getBotState(), matchRecipe);
  assert.equal(instance.getBotState().practice, true);
  assert.equal(instance.getBotState().botInfo.engine, 'legacy');

  instance.destroy();
});

test('P21 guidance locks bot mode and Beginner across settings, and finishes on the same board', async () => {
  const { mountBoard } = await boardPromise;
  const ui = mockHost({ boardMode: 'local', boardDifficulty: 'Expert' });
  const instance = mountBoard(ui.host, { preview: false, tutorial: true });
  const hasLockedSetting = setting => new RegExp(
    'data-gb-setting="' + setting + '"[^>]*disabled'
  ).test(ui.host.innerHTML);
  const assertGuided = () => {
    assert.equal(hasLockedSetting('mode'), true);
    assert.equal(hasLockedSetting('difficulty'), true);
    assert.match(ui.host.innerHTML, /<option value="bot" selected>/);
    assert.match(ui.host.innerHTML, /<option selected>Beginner<\/option>/);
  };
  try {
    assertGuided();
    ui.changeSetting('mode', 'local');
    ui.changeSetting('difficulty', 'Expert');
    assertGuided();
    ui.changeSetting('theme', 'vector');
    ui.changeSetting('mode', 'local'); // force a mock-DOM refresh (real browser updates stage directly)
    assert.match(ui.host.innerHTML, /data-gb-theme="vector"/);
    ui.clickGuided('continue');
    ui.clickCell('0:4');
    ui.clickGuided('continue');
    ui.changeSetting('mode', 'local');
    ui.changeSetting('difficulty', 'Hard');
    assertGuided();
    ui.clickCell('0:3');
    ui.clickGuided('continue');
    ui.clickCell('0:5');
    ui.clickGuided('continue');
    const beforeHandoff = instance.getState();
    assert.equal(beforeHandoff.moves.length, 6);
    ui.changeSetting('mode', 'local');
    assertGuided();
    ui.clickGuided('continue');
    assert.equal(instance.getState(), beforeHandoff);
    assert.equal(instance.getBotState().practice, true);
    assert.equal(hasLockedSetting('mode'), false);
    assert.match(ui.host.innerHTML, /<option value="bot" selected>/);
    assert.match(ui.host.innerHTML, /<option selected>Beginner<\/option>/);
  } finally { instance.destroy(); }
});

test('P21-I01 wrong taps are blocked during guided steps and state does not mutate', async () => {
  const { mountBoard } = await boardPromise;
  const ui = mockHost({ boardMode: 'bot' });
  const instance = mountBoard(ui.host, { preview: false, tutorial: true });

  // Advance prompt
  ui.clickGuided('continue');
  assert.equal(instance.getState().moves.length, 0);

  // Expected move is 0:4; click wrong cell 0:0, 0:3, 1:1, etc.
  ui.clickCell('0:0');
  assert.equal(instance.getState().moves.length, 0, 'Wrong tap 0:0 must be blocked');
  ui.clickCell('0:3');
  assert.equal(instance.getState().moves.length, 0, 'Wrong tap 0:3 must be blocked');
  ui.clickCell('4:4');
  assert.equal(instance.getState().moves.length, 0, 'Wrong tap 4:4 must be blocked');

  // Correct tap 0:4 passes
  ui.clickCell('0:4');
  assert.equal(instance.getState().moves.length, 1);

  // During AWAIT_CONTINUE, any cell tap is blocked
  ui.clickCell('4:0');
  assert.equal(instance.getState().moves.length, 1, 'Taps during AWAIT_CONTINUE must be blocked');

  instance.destroy();
});

test('P21-I01 skip guidance ends tutorial immediately, keeps live moves, and does not reset', async () => {
  const { mountBoard } = await boardPromise;
  const ui = mockHost({ boardMode: 'bot' });
  const instance = mountBoard(ui.host, { preview: false, tutorial: true });

  ui.clickGuided('continue');
  ui.clickCell('0:4');
  ui.clickGuided('continue'); // bot moves
  assert.equal(instance.getState().moves.length, 2);

  // Player skips guidance at step 2
  ui.clickGuided('skip');
  assert.equal(instance.getState().moves.length, 2, 'Committed moves must remain intact');
  assert.equal(instance.getState().turn, 'X');

  // Human can now play any legal move freely
  ui.clickCell('0:1');
  assert.equal(instance.getState().moves.length, 3);
  assert.deepEqual(instance.getState().moves[2], { b: 0, c: 1, player: 'X' });

  instance.destroy();
});

test('P21-I01 hint and replay explanation are strictly read-only and do not mutate state', async () => {
  const { mountBoard } = await boardPromise;
  const ui = mockHost({ boardMode: 'bot' });
  const instance = mountBoard(ui.host, { preview: false, tutorial: true });

  ui.clickGuided('continue');
  const beforeState = instance.getState();

  ui.clickGuided('hint');
  assert.equal(instance.getState(), beforeState);
  assert.equal(instance.getState().moves.length, 0);

  ui.clickGuided('replay');
  assert.equal(instance.getState(), beforeState);
  assert.equal(instance.getState().moves.length, 0);

  instance.destroy();
});

test('P21-I01 canonical save and restore survives reload without committing extra moves', async () => {
  const stateBefore = game.apply(game.apply(game.create(), { b: 0, c: 4 }), { b: 4, c: 0 });
  const mockStorage = new Map();
  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: k => mockStorage.get(k) || null,
    setItem: (k, v) => mockStorage.set(k, String(v)),
    removeItem: k => mockStorage.delete(k),
  };

  try {
    const lessonSnapshot = {
      lessonVersion: compat.TUTORIAL_VERSION,
      stepId: 'move-3',
      phase: 'AWAIT_MOVE',
      gameRevision: 2,
      practice: true,
      guidedMoves: 2,
      narrationEnabled: true,
      volume: 0.9,
    };
    compat.savePracticeSession({
      state: stateBefore,
      lesson: lessonSnapshot,
      difficulty: 'Beginner',
      theme: 'vector',
    });

    const restored = compat.loadPracticeSession({ game, lessonModule: lesson });
    assert.ok(restored);
    assert.equal(restored.state.moves.length, 2);
    assert.equal(restored.state.required, 0);
    assert.equal(restored.difficulty, 'Beginner');
    assert.equal(restored.theme, 'vector');
    assert.equal(restored.lesson.phase, 'AWAIT_MOVE');

    // Incompatible save stops guidance safely without throwing
    const corruptedState = game.apply(game.create(), { b: 0, c: 0 }); // divergent move
    const incompatible = lesson.restore(lessonSnapshot, corruptedState);
    assert.equal(incompatible.phase, 'DONE');
    assert.equal(incompatible.reason, 'incompatible-save');
  } finally {
    globalThis.localStorage = originalStorage;
  }
});

test('P21-I01 practice completion and guided play have zero economy or reward mutations', () => {
  const d = domain.fresh();
  const initialCoins = d.wallet.coins;
  const initialCrowns = d.wallet.crowns;
  const initialQuests = structuredClone(d.records);

  // Practice matches must be non-rewarding
  domain.complete(d, {
    id: 'guided-practice-test',
    mode: 'bot',
    difficulty: 'Beginner',
    practice: true,
    result: 'win',
    moves: 6,
    activeSeconds: 45,
    claimed: 1,
  });

  assert.equal(d.wallet.coins, initialCoins, 'Coins must not change');
  assert.equal(d.wallet.crowns, initialCrowns, 'Crowns must not change');
  assert.deepEqual(d.records, initialQuests, 'Quests must not advance on practice matches');
});

test('P21-I02 Worker executes bot calculations for all five difficulty tiers', async () => {
  const captured = [];
  const { factory } = mockWorkerFactory((msg, worker) => {
    captured.push(msg);
    // Respond with first legal move
    const legalMove = game.legal(msg.state)[0];
    worker.reply({
      gameId: msg.gameId,
      revision: msg.revision,
      move: legalMove,
      diagnostics: { version: 'bot-contract-v1', difficulty: msg.difficulty, rngSeed: msg.seed },
    });
  });

  const runner = compat.createBotRunner({
    game,
    runtime,
    contract,
    workerFactory: factory,
  });

  const testState = game.apply(game.create(), { b: 0, c: 4 }); // O's turn

  for (const level of ['Beginner', 'Easy', 'Medium', 'Hard', 'Expert']) {
    runner.setGameId(`test-match-${level}`);
    const res = await runner.choose({
      state: testState,
      difficulty: level,
      engine: 'legacy',
    });
    assert.ok(res.move);
    assert.equal(res.dropped, false);
    assert.equal(res.diagnostics.difficulty, level);
    assert.equal(res.diagnostics.fallback, false);
  }

  assert.equal(captured.length, 5);
  for (const req of captured) {
    assert.equal(req.engine, 'legacy');
    assert.equal(req.revision, 1);
    assert.equal(req.op, 'choose');
  }

  runner.destroy();
});

test('P21-I02 cancellation, gameId and revision fences prevent stale commits and duplicate turns', async () => {
  let workerRef = null;
  const { factory } = mockWorkerFactory((msg, worker) => {
    workerRef = worker;
  });

  const runner = compat.createBotRunner({
    game,
    runtime,
    contract,
    workerFactory: factory,
  });

  runner.setGameId('match-fence');
  const state = game.apply(game.create(), { b: 0, c: 4 });

  // 1. In-flight choose
  const pending = runner.choose({ state, difficulty: 'Expert' });

  // 2. Human cancels or resets game while bot is running
  runner.cancel('HUMAN_MOVED');

  // 3. Late worker message arrives
  workerRef.reply({
    gameId: 'match-fence',
    revision: 1,
    move: { b: 4, c: 0 },
    diagnostics: {},
  });

  // Result was cancelled/fenced: does not commit
  const res = await pending;
  assert.equal(res.move, null);
  assert.equal(res.dropped, true, 'Late suggestion must be dropped by fence');

  runner.destroy();
});

test('P21-I02 hidden boards fence late Worker replies and resume the same human move', async t => {
  const { mountBoard } = await boardPromise;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { factory, workers } = mockWorkerFactory();
  const ui = mockHost({ boardMode: 'bot' });
  const instance = mountBoard(ui.host, { preview: false, workerFactory: factory });
  try {
    ui.clickCell('0:4');
    t.mock.timers.tick(260);
    const humanState = instance.getState();
    ui.setHidden(true);
    workers[0].reply({ move: { b: 4, c: 0 }, gameId: workers[0].lastMessage.gameId, revision: 1 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(instance.getState(), humanState);
    ui.setHidden(false);
    t.mock.timers.tick(260);
    const resumed = workers.at(-1);
    resumed.reply({ move: { b: 4, c: 2 }, gameId: resumed.lastMessage.gameId, revision: 1 });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(instance.getState(), game.apply(humanState, { b: 4, c: 2 }));
  } finally {
    instance.destroy();
  }
});

test('P21-I02 teardown destroys Worker and drops pending turns cleanly', async () => {
  const { mountBoard } = await boardPromise;
  let createdWorker = null;
  const { factory } = mockWorkerFactory((msg, worker) => {
    createdWorker = worker;
  });

  const ui = mockHost({ boardMode: 'bot', boardDifficulty: 'Medium' });
  const instance = mountBoard(ui.host, { preview: false, workerFactory: factory });

  ui.clickCell('0:4');
  assert.equal(instance.getState().moves.length, 1);

  // Destroy board immediately while bot would be scheduled
  instance.destroy();

  // Observable behavior: cell clicks after destroy cannot mutate state
  ui.clickCell('4:0');

  // Wait 350ms (longer than 260ms timer)
  await new Promise(resolve => setTimeout(resolve, 350));

  // State must remain 1 move; destroyed board cannot mutate or execute late turns
  assert.equal(instance.getState().moves.length, 1);
});

test('P21-I02 labeled measured fallback activates when Worker is absent without server authority', async () => {
  const runner = compat.createBotRunner({
    game,
    runtime,
    contract,
    workerFactory: () => {
      throw new Error('BOT_WORKER_UNAVAILABLE');
    },
  });

  const state = game.apply(game.create(), { b: 0, c: 4 });
  const res = await runner.choose({ state, difficulty: 'Hard', allowSyncFallback: true });

  assert.ok(res.move, 'Fallback must produce a valid legal move');
  assert.equal(res.diagnostics.fallback, true);
  assert.equal(res.diagnostics.engine, 'legacy-sync');
  assert.equal(res.diagnostics.difficulty, 'Hard');
  assert.ok(game.legal(state).some(m => m.b === res.move.b && m.c === res.move.c));

  runner.destroy();
});

test('P21-I01 five themes stay selectable and theme switch does not reset game moves', async () => {
  const { mountBoard, GAME_THEMES } = await boardPromise;
  assert.equal(GAME_THEMES.length, 5);
  const themeIds = GAME_THEMES.map(t => t.id);
  assert.deepEqual(themeIds, ['cinematic', 'vector', 'midnight', 'paperclub', 'afterhours']);

  const ui = mockHost({ boardMode: 'local', boardTheme: 'cinematic' });
  const instance = mountBoard(ui.host, { preview: false });

  ui.clickCell('0:4');
  assert.equal(instance.getState().moves.length, 1);

  for (const t of ['vector', 'midnight', 'paperclub', 'afterhours', 'cinematic']) {
    ui.changeSetting('theme', t);
    assert.equal(instance.getState().moves.length, 1, `Theme switch to ${t} must preserve moves`);
    assert.equal(instance.getState().turn, 'O');
  }

  instance.destroy();
});


test('P21 match recipe pins the flag across settings and visibility, then resets at a fresh match', async t => {
  const { mountBoard } = await boardPromise;
  const storage = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { factory, workers } = mockWorkerFactory();
  const ui = mockHost({ boardMode: 'bot' });
  const instance = mountBoard(ui.host, { preview: false, workerFactory: factory });
  try {
    const initial = instance.getBotState();
    assert.equal(initial.botInfo.engine, 'legacy');
    storage.set('mega_v51_search', 'experimental');
    ui.clickCell('0:4');
    t.mock.timers.tick(260);
    assert.equal(workers[0].lastMessage.engine, 'legacy');
    assert.equal(workers[0].lastMessage.seed, initial.botInfo.seed);
    ui.setHidden(true);
    ui.changeSetting('difficulty', 'Expert');
    ui.changeSetting('theme', 'vector');
    ui.setHidden(false);
    t.mock.timers.tick(260);
    assert.deepEqual(instance.getBotState(), initial);
    assert.equal(workers.at(-1).lastMessage.seed, initial.botInfo.seed);
    instance.reset();
    const fresh = instance.getBotState();
    assert.notEqual(fresh.gameId, initial.gameId);
    assert.equal(fresh.botInfo.engine, 'experimental');
    ui.clickCell('0:4');
    t.mock.timers.tick(260);
    assert.equal(workers.at(-1).lastMessage.engine, 'experimental');
    assert.equal(workers.at(-1).lastMessage.seed, fresh.botInfo.seed);
    const pending = workers.at(-1);
    instance.reset();
    pending.reply({ gameId: pending.lastMessage.gameId, revision: 1, move: { b: 4, c: 0 } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(instance.getState().moves.length, 0);
  } finally {
    instance.destroy();
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
});

test('P21 guided skip and restore preserve unpaid legacy recipe and live moves under experimental flag', async () => {
  const { mountBoard } = await boardPromise;
  const storage = new Map([['mega_v51_search', 'experimental']]);
  const previous = globalThis.localStorage;
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  const ui = mockHost({ boardMode: 'bot' });
  const first = mountBoard(ui.host, { preview: false, tutorial: true });
  let restored;
  try {
    const recipe = first.getBotState().botInfo;
    ui.clickGuided('continue');
    ui.clickCell('0:4');
    ui.clickGuided('skip');
    const state = first.getState();
    assert.equal(first.getBotState().practice, true);
    assert.equal(recipe.engine, 'legacy');
    first.destroy();
    restored = mountBoard(mockHost({ boardMode: 'bot' }).host, { preview: false });
    assert.deepEqual(restored.getState(), state);
    assert.deepEqual(restored.getBotState().botInfo, recipe);
    assert.equal(restored.getBotState().practice, true);
    assert.notEqual(restored.getBotState().gameId, first.getBotState().gameId);
  } finally {
    first.destroy();
    restored?.destroy();
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
});

test('P21 explicit recovery repeats canonical seeded legacy selection using the pinned recipe', () => {
  const runner = compat.createBotRunner({ game, runtime, contract });
  const recipe = runtime.startInfo(null, true);
  recipe.seed = 123456;
  runner.setGameId('recovery-recipe', recipe, true);
  const state = game.apply(game.create(), { b: 0, c: 4 });
  const expected = game.choose(state, 'Beginner', contract.seeded(recipe.seed));
  const first = runner.computeExplicitFallback(state, 'Beginner');
  const second = runner.computeExplicitFallback(state, 'Beginner', 999);
  assert.deepEqual(first.move, { b: expected.b, c: expected.c });
  assert.deepEqual(second, first);
  assert.equal(first.diagnostics.engine, 'legacy-sync');
  assert.equal(first.diagnostics.rngSeed, recipe.seed);
  runner.destroy();
});

test('P21 old guided saves replay safely as legacy even when the experimental flag is enabled', async () => {
  const { mountBoard } = await boardPromise;
  const previous = globalThis.localStorage;
  const storage = new Map([['mega_v51_search', 'experimental']]);
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  let instance;
  try {
    const controller = compat.createTutorialController({ game, lessonModule: lesson });
    const state = game.create();
    controller.start(state);
    compat.savePracticeSession({ state, lesson: controller.getSnapshot() });
    const saved = JSON.parse(storage.get('mega_v51_practice_save'));
    delete saved.botInfo;
    storage.set('mega_v51_practice_save', JSON.stringify(saved));
    instance = mountBoard(mockHost({ boardMode: 'bot' }).host, { preview: false });
    assert.deepEqual(instance.getState(), state);
    assert.equal(instance.getBotState().botInfo.engine, 'legacy');
    assert.equal(instance.getBotState().practice, true);
    assert.equal(instance.getTutorialSnapshot().practice, true);
    assert.equal(instance.getTutorialSnapshot().phase, 'PROMPT');
  } finally {
    instance?.destroy();
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
});
