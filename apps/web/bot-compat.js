/* Mega XOXO Web Bot & Tutorial Compatibility Adapter.
 * Reuses ONLY canonical MegaLesson and MegaBotRuntime. No fake fallbacks or duplicate scripts.
 * Exposes UMD / global MegaWebBotCompat.
 */
(function(root, factory) {
  const api = factory(root, root.MegaGame, root.MegaLesson, root.MegaBotRuntime, root.MegaBotContract);
  root.MegaWebBotCompat = api;
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function(root, G_default, L_default, R_default, C_default) {
  'use strict';

  const STORAGE_KEY = 'mega_v51_practice_save';
  let matchSerial = 0;

  function getLocalEnglishVoice() {
    try {
      if (!root.speechSynthesis?.getVoices) return null;
      return root.speechSynthesis.getVoices().find(v => v.localService === true && /^en(?:-|$)/i.test(v.lang)) || null;
    } catch {
      return null;
    }
  }

  function stopSpeech() {
    try {
      root.speechSynthesis?.cancel?.();
    } catch {}
  }

  function speakText(text, { enabled = true, volume = 0.8 } = {}) {
    stopSpeech();
    if (!enabled || !text) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    const voice = getLocalEnglishVoice();
    if (!voice || !root.SpeechSynthesisUtterance) return;
    try {
      const utterance = new root.SpeechSynthesisUtterance(text);
      utterance.voice = voice;
      utterance.lang = voice.lang;
      // Preserve volume 0 (mute)
      const vol = typeof volume === 'number' && Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0.8;
      utterance.volume = vol;
      root.speechSynthesis.speak(utterance);
    } catch {}
  }

  /**
   * Controller wrapping shared MegaLesson.
   * If MegaLesson is not available, marks guidance unavailable with retry/play-unguided, never fake scripts.
   */
  function createTutorialController({
    game = root.MegaGame || G_default,
    lessonModule = root.MegaLesson || L_default,
    onNotify = null,
  } = {}) {
    let lesson = null;
    let active = false;
    let confirmRestart = false;

    function getL() {
      return lessonModule || root.MegaLesson || null;
    }

    function isAvailable() {
      const L = getL();
      return Boolean(L && typeof L.create === 'function' && typeof L.view === 'function');
    }

    function start(state) {
      confirmRestart = false;
      const L = getL();
      if (!L) {
        active = false;
        lesson = null;
        onNotify?.('Guided tutorial module is currently unavailable. You can continue unguided practice.');
        return null;
      }
      try {
        lesson = L.create(state);
        active = true;
        return getView(state);
      } catch (err) {
        active = false;
        lesson = null;
        onNotify?.('Could not start tutorial: ' + err.message);
        return null;
      }
    }

    function restore(savedLesson, state) {
      confirmRestart = false;
      const L = getL();
      if (!L || !savedLesson) {
        active = false;
        lesson = null;
        return null;
      }
      try {
        lesson = L.restore(savedLesson, state);
        active = lesson.phase !== 'DONE';
        if (lesson.reason === 'incompatible-save') {
          onNotify?.('Your board was restored. Guidance could not resume; continue unguided practice or restart the tutorial.');
        }
        return lesson;
      } catch {
        active = false;
        lesson = null;
        return null;
      }
    }

    function isActive() {
      return active && lesson !== null && lesson.phase !== 'DONE';
    }

    function isDone() {
      return lesson !== null && lesson.phase === 'DONE';
    }

    function isConfirmRestart() {
      return confirmRestart;
    }

    function allowsMove(state, move) {
      if (!isActive()) return true;
      if (confirmRestart) return false;
      const L = getL();
      if (!L?.allows) return false;
      return L.allows(lesson, state, move);
    }

    function getView(state) {
      if (!isAvailable()) {
        return {
          title: 'Guidance unavailable',
          text: 'The shared tutorial script is still loading. You can practice without guidance or try again.',
          hint: '',
          move: null,
          phase: 'UNAVAILABLE',
          stepId: 'unavailable',
          guidedMoves: 0,
          narrationEnabled: false,
          volume: 0.8,
          confirmRestart: false,
        };
      }
      if (!lesson) return null;
      if (confirmRestart) {
        return {
          title: 'Restart this practice match?',
          text: 'This clears only this unpaid practice board. Your account and normal statistics are unchanged.',
          hint: 'Restarting sets the board back to the first move of the tutorial.',
          move: null,
          phase: lesson.phase,
          stepId: lesson.stepId,
          guidedMoves: lesson.guidedMoves,
          narrationEnabled: lesson.narrationEnabled,
          volume: lesson.volume,
          confirmRestart: true,
        };
      }
      const L = getL();
      try {
        const v = L.view(lesson, state);
        return {
          ...v,
          phase: lesson.phase,
          stepId: lesson.stepId,
          guidedMoves: lesson.guidedMoves,
          narrationEnabled: lesson.narrationEnabled,
          volume: lesson.volume,
          confirmRestart: false,
        };
      } catch {
        return null;
      }
    }

    function onPlayerMove(before, move, after) {
      if (!isActive()) return lesson;
      const L = getL();
      if (L?.committed) {
        lesson = L.committed(lesson, before, move, after);
      }
      return lesson;
    }

    function advance(action, state, { hidden = false, volume = null } = {}) {
      if (!lesson) return { lesson: null, move: null };
      const L = getL();

      if (action === 'restart') {
        confirmRestart = true;
        return { lesson, move: null, confirmRestart: true };
      }
      if (action === 'restart-cancel') {
        confirmRestart = false;
        return { lesson, move: null, confirmRestart: false };
      }
      if (action === 'restart-confirm') {
        confirmRestart = false;
        start(game.create());
        return { lesson, move: null, restarted: true };
      }
      if (action === 'skip') {
        if (L?.advance) {
          const res = L.advance(lesson, state, 'skip');
          lesson = res.lesson;
        } else {
          lesson = { ...lesson, phase: 'DONE', stepId: 'done', paused: false, reason: 'skipped' };
        }
        active = false;
        return { lesson, move: null, skipped: true };
      }
      if (action === 'hide') {
        active = false;
        stopSpeech();
        return { lesson, move: null, hiddenTips: true };
      }
      if (action === 'hint') {
        const v = getView(state);
        onNotify?.(v?.hint || 'Choose the outlined cell.');
        return { lesson, move: v?.move || null, hint: v?.hint };
      }
      if (action === 'replay') {
        const v = getView(state);
        onNotify?.('Explanation repeated. The board is unchanged.');
        if (v?.text) speakText(v.text, { enabled: lesson.narrationEnabled, volume: lesson.volume });
        return { lesson, move: null, replayed: true, text: v?.text };
      }
      if (action === 'voice') {
        if (getLocalEnglishVoice()) {
          lesson = { ...lesson, narrationEnabled: !lesson.narrationEnabled };
        }
        return { lesson, move: null, narrationEnabled: lesson.narrationEnabled };
      }
      if (action === 'volume') {
        const num = Number(volume);
        if (Number.isFinite(num)) {
          lesson = { ...lesson, volume: Math.max(0, Math.min(1, num)) };
        }
        return { lesson, move: null, volume: lesson.volume };
      }
      if (action === 'continue') {
        if (!L?.advance) return { lesson, move: null };
        const transition = L.advance(lesson, state, 'continue', { hidden });
        lesson = transition.lesson;
        if (lesson.phase === 'DONE') {
          active = false;
          return { lesson, move: null, completed: true };
        }
        return { lesson, move: transition.move, completed: false };
      }
      return { lesson, move: null };
    }

    return {
      isAvailable,
      start,
      restore,
      isActive,
      isDone,
      isConfirmRestart,
      allowsMove,
      getView,
      onPlayerMove,
      advance,
      stop() {
        stopSpeech();
        active = false;
        lesson = null;
        confirmRestart = false;
      },
      getSnapshot: () => lesson ? { ...lesson } : null,
    };
  }

  /**
   * Off-thread Worker client runner with generation/revision/gameId fencing.
   * If Worker is unavailable or fails, fallback to synchronous search is NOT automatic;
   * it requires explicit user recovery to prevent main-thread freezing.
   */
  function createBotRunner({
    game = root.MegaGame || G_default,
    runtime = root.MegaBotRuntime || R_default,
    contract = root.MegaBotContract || C_default,
    workerFactory = null,
    timeoutMs = 1800,
  } = {}) {
    let client = null;
    let generation = 0;
    let activeGameId = null;
    let botInfo = null;
    let practice = false;

    function setGameId(id, saved = null, isPractice = false) {
      cancel('NEW_GAME');
      practice = Boolean(isPractice);
      activeGameId = id || `practice-${Date.now()}-${++matchSerial}`;
      botInfo = getR()?.startInfo(saved, practice) || null;
      return getState();
    }

    function getState() {
      return { gameId: activeGameId, botInfo: botInfo ? { ...botInfo } : null, practice };
    }

    function getR() {
      return runtime || root.MegaBotRuntime || null;
    }

    function getClient() {
      const R = getR();
      if (!client && R?.Client) {
        try {
          client = new R.Client({
            workerFactory: workerFactory || (() => {
              if (typeof Worker === 'undefined') throw new Error('BOT_WORKER_UNAVAILABLE');
              return new Worker('/legacy-game/src/bot/worker.js');
            }),
            timeoutMs,
          });
        } catch {}
      }
      return client;
    }

    function cancel(code = 'BOT_CANCELLED') {
      generation += 1;
      if (client) {
        try { client.cancel(code, true); } catch {}
      }
    }

    async function choose({ state, difficulty = 'Easy', engine = null, seed = null, signal = null, allowSyncFallback = false }) {
      if (!activeGameId) setGameId();
      engine = botInfo?.engine || engine || 'legacy';
      seed = botInfo?.seed ?? seed;
      generation += 1;
      const currentGen = generation;
      const revision = state.moves.length;
      const gameId = activeGameId;

      if (!game.LEVELS.includes(difficulty)) difficulty = 'Easy';

      const rngSeed = Number.isInteger(seed) && seed >= 0 && seed <= 4294967295
        ? seed
        : (typeof crypto !== 'undefined' && crypto.getRandomValues
            ? crypto.getRandomValues(new Uint32Array(1))[0]
            : Math.floor(Math.random() * 4294967296));

      const runnerClient = getClient();

      if (runnerClient) {
        try {
          const result = await runnerClient.choose({
            engine,
            difficulty,
            gameId,
            revision,
            state,
            seed: rngSeed,
          }, { signal });

          if (currentGen !== generation || state.moves.length !== revision) {
            return { move: null, diagnostics: null, dropped: true };
          }

          const C = contract || root.MegaBotContract;
          const move = C?.assertMove ? C.assertMove(state, result.move) : result.move;
          return {
            move,
            diagnostics: { ...result.diagnostics, fallback: false, engine: engine || 'legacy' },
            dropped: false,
          };
        } catch (workerError) {
          if (currentGen !== generation || state.moves.length !== revision || signal?.aborted) {
            return { move: null, diagnostics: null, dropped: true };
          }
          if (allowSyncFallback) return computeExplicitFallback(state, difficulty, rngSeed);
          return {
            move: null,
            diagnostics: {
              version: 'bot-fallback-v1',
              difficulty,
              fallback: true,
              recoveryRequired: true,
              reason: workerError?.code || workerError?.message || 'WORKER_FAILURE',
              engine,
              rngSeed,
            },
            dropped: false,
          };
        }
      }
      if (allowSyncFallback) return computeExplicitFallback(state, difficulty, rngSeed);
      // No Worker runtime available: mark recovery required
      return {
        move: null,
        diagnostics: {
          version: 'bot-fallback-v1',
          difficulty,
          fallback: true,
          recoveryRequired: true,
          reason: 'NO_WORKER_RUNTIME',
          engine,
          rngSeed,
        },
        dropped: false,
      };
    }

    /**
     * Explicit measured recovery: user explicitly confirms calculating the move on main thread.
     */
    function computeExplicitFallback(state, difficulty = 'Easy', seed = null) {
      if (!game.LEVELS.includes(difficulty)) difficulty = 'Easy';
      const C = contract || root.MegaBotContract;
      const rngSeed = botInfo?.seed ?? (Number.isInteger(seed) ? seed : getR()?.startInfo(null, true)?.seed);
      const rng = C?.seeded ? C.seeded(rngSeed) : Math.random;
      const chosen = game.choose(state, difficulty, rng);
      if (!chosen) return null;
      return {
        move: { b: chosen.b, c: chosen.c },
        diagnostics: {
          version: 'bot-fallback-v1',
          difficulty,
          fallback: true,
          explicitRecovery: true,
          engine: 'legacy-sync',
          rngSeed,
        },
      };
    }

    return {
      choose,
      computeExplicitFallback,
      cancel,
      setGameId,
      getState,
      destroy() {
        cancel('DESTROY');
        client = null;
      },
    };
  }

  function savePracticeSession({ state, lesson = null, difficulty = 'Beginner', theme = 'cinematic', botInfo = null } = {}) {
    try {
      if (typeof localStorage === 'undefined' || !state) return false;
      const L = root.MegaLesson || L_default;
      const version = L?.VERSION || 'guided-practice-v1';
      const payload = {
        version,
        savedAt: Date.now(),
        state: {
          board: state.board,
          mini: state.mini,
          turn: state.turn,
          required: state.required,
          winner: state.winner,
          line: state.line,
          moves: state.moves,
        },
        lesson: lesson ? {
          lessonVersion: lesson.lessonVersion || version,
          stepId: lesson.stepId,
          phase: lesson.phase,
          gameRevision: lesson.gameRevision,
          practice: true,
          guidedMoves: lesson.guidedMoves,
          narrationEnabled: Boolean(lesson.narrationEnabled),
          volume: typeof lesson.volume === 'number' && Number.isFinite(lesson.volume) ? lesson.volume : 0.8,
          reason: lesson.reason || null,
        } : null,
        difficulty,
        theme,
        botInfo,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  function loadPracticeSession({ game = root.MegaGame || G_default, lessonModule = root.MegaLesson || L_default } = {}) {
    try {
      if (typeof localStorage === 'undefined') return null;
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const L = lessonModule || root.MegaLesson || L_default;
      const expectedVersion = L?.VERSION || 'guided-practice-v1';
      if (parsed.version !== expectedVersion || !parsed.state || !Array.isArray(parsed.state.moves)) return null;

      let canonical = game.create();
      for (const move of parsed.state.moves) {
        canonical = game.apply(canonical, move);
      }

      let restoredLesson = null;
      if (parsed.lesson && L?.restore) {
        restoredLesson = L.restore(parsed.lesson, canonical);
      }

      return {
        state: canonical,
        lesson: restoredLesson,
        difficulty: parsed.difficulty || 'Beginner',
        theme: parsed.theme || 'cinematic',
        botInfo: parsed.botInfo || null,
      };
    } catch {
      return null;
    }
  }

  function clearPracticeSession() {
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY);
      return true;
    } catch {
      return false;
    }
  }

  return {
    STORAGE_KEY,
    createTutorialController,
    createBotRunner,
    savePracticeSession,
    loadPracticeSession,
    clearPracticeSession,
    speakNarration: speakText,
    stopNarration: stopSpeech,
    hasLocalVoice: () => Boolean(getLocalEnglishVoice()),
  };
});
