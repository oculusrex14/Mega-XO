/* Website presentation of the retained rules. Local practice has no server authority. */
export const GAME_THEMES = Object.freeze([
  { id: 'vector', name: 'Vector Light' },
  { id: 'midnight', name: 'Midnight Club' },
  { id: 'paperclub', name: 'Paper Club' },
  { id: 'afterhours', name: 'After Hours' },
]);

const PREVIEW_MOVES = Object.freeze([
  [6, 5], [5, 4], [4, 3], [3, 6], [6, 0], [0, 5], [5, 6], [6, 7],
  [7, 5], [5, 3], [3, 2], [2, 2], [2, 4], [4, 0], [0, 0], [0, 3],
  [3, 7], [7, 2], [2, 3], [3, 4],
]);
const POSITIONS = ['Top left', 'Top centre', 'Top right', 'Middle left', 'Centre', 'Middle right', 'Bottom left', 'Bottom centre', 'Bottom right'];

function rules(game = globalThis.MegaGame) {
  if (!game || !['create', 'legal', 'apply'].every(name => typeof game[name] === 'function')) {
    throw new Error('The approved Mega XOXO game rules did not load.');
  }
  return game;
}

export function generatePreviewState(game = globalThis.MegaGame) {
  const approved = rules(game);
  return PREVIEW_MOVES.reduce((state, [b, c]) => approved.apply(state, { b, c }), approved.create());
}

/** Small local session, also usable without the DOM for rule-parity verification. */
export function createBoardSession(game = globalThis.MegaGame, { preview = false } = {}) {
  const approved = rules(game);
  let state = preview ? generatePreviewState(approved) : approved.create();
  return {
    getState: () => state,
    legal: () => approved.legal(state),
    move(move) { state = approved.apply(state, move); return state; },
    reset({ fresh = !preview } = {}) {
      state = fresh ? approved.create() : generatePreviewState(approved);
      return state;
    },
  };
}

function mark(player, extra = '') {
  const shape = player === 'X'
    ? '<path d="M10 10 30 30M30 10 10 30"/>'
    : '<circle cx="20" cy="20" r="13"/>';
  return `<svg class="gb-mark gb-mark--${player.toLowerCase()} ${extra}" viewBox="0 0 40 40" fill="none" aria-hidden="true">${shape}</svg>`;
}

function boardMarkup(state, game, { preview, thinking = false, focus = null } = {}) {
  const legal = new Set(game.legal(state).map(move => `${move.b}:${move.c}`));
  const first = focus ?? game.legal(state).map(move => `${move.b}:${move.c}`)[0] ?? '0:0';
  return `<div class="gb-grid" role="group" aria-label="Mega XOXO board, nine small boards">
    ${state.board.map((cells, b) => {
      const active = !state.winner && !state.mini[b] && cells.some((_, c) => legal.has(`${b}:${c}`));
      const claimed = state.mini[b];
      const name = `${POSITIONS[b]} board${claimed ? claimed === 'DRAW' ? ', drawn' : `, won by ${claimed}` : ''}`;
      return `<div class="gb-mini${active ? ' gb-mini--active' : ''}${claimed ? ' gb-mini--claimed' : ''}${state.line?.includes(b) ? ' gb-mini--winning' : ''}" role="group" aria-label="${name}" data-gb-mini="${b}">
        ${cells.map((value, c) => {
          const key = `${b}:${c}`;
          const allowed = legal.has(key) && !thinking;
          const label = `${POSITIONS[b]} board, ${POSITIONS[c].toLowerCase()} cell: ${value || 'empty'}${value ? ', occupied' : claimed ? ', board complete' : allowed ? ', legal move' : thinking && legal.has(key) ? ', practice player is thinking' : ', unavailable this turn'}`;
          return `<button class="gb-cell${value ? ` gb-cell--${value.toLowerCase()}` : ''}${allowed ? ' gb-cell--legal' : ''}" type="button" data-gb-cell="${key}" aria-label="${label}" aria-disabled="${!allowed}" tabindex="${key === first ? '0' : '-1'}">${value ? mark(value) : allowed ? '<span class="gb-move-dot" aria-hidden="true"></span>' : ''}</button>`;
        }).join('')}
        ${claimed ? `<div class="gb-claim" aria-hidden="true">${claimed === 'DRAW' ? '<span>DRAW</span>' : mark(claimed)}</div>` : ''}
      </div>`;
    }).join('')}
  </div>`;
}

function turnCopy(state, { mode, thinking, preview }) {
  if (state.winner === 'DRAW') return { title: 'Draw', detail: 'All small boards are complete. Start a new practice game to play again.' };
  if (state.winner) return { title: `${state.winner} wins`, detail: 'Three small boards in a row win the big one. Start a new game to play again.' };
  const title = thinking ? 'Practice is thinking' : mode === 'bot' ? 'Your move' : `${state.turn} to move`;
  const detail = state.required === null
    ? 'Choose any open board. Your cell chooses where the next player moves.'
    : preview
      ? 'Play in the highlighted board. Your move sends the next player to the corresponding board.'
      : `Play in the ${POSITIONS[state.required].toLowerCase()} board. Your cell chooses the next board.`;
  return { title, detail };
}

function toolbar({ mode, difficulty, theme }) {
  return `<div class="gb-toolbar">
    <label>Practice mode<select data-gb-setting="mode"><option value="bot"${mode === 'bot' ? ' selected' : ''}>Play against practice bot</option><option value="local"${mode === 'local' ? ' selected' : ''}>Two players · same screen</option></select></label>
    <label${mode === 'local' ? ' hidden' : ''}>Bot level<select data-gb-setting="difficulty">${['Beginner', 'Easy', 'Medium', 'Hard', 'Expert'].map(level => `<option${difficulty === level ? ' selected' : ''}>${level}</option>`).join('')}</select></label>
    <label>Game theme<select data-gb-setting="theme">${GAME_THEMES.map(item => `<option value="${item.id}"${theme === item.id ? ' selected' : ''}>${item.name}</option>`).join('')}</select></label>
  </div>`;
}

function renderBoard(state, game, { preview = true, mode = 'bot', difficulty = 'Easy', theme = 'vector', thinking = false, focus = null } = {}) {
  const copy = turnCopy(state, { preview, mode, thinking });
  const last = state.moves.at(-1);
  return `<section class="gb-stage${preview ? ' gb-stage--preview' : ' gb-stage--practice'}" data-gb-stage data-gb-theme="${preview ? 'cinematic' : theme}" aria-label="${preview ? 'Interactive practice preview' : 'Local practice game'}">
    ${preview ? '' : toolbar({ mode, difficulty, theme })}
    <div class="gb-frame">
      <div class="gb-hud">
        <div class="gb-player${state.turn === 'X' && !state.winner ? ' gb-player--active' : ''}"><span class="gb-avatar gb-avatar--x">${mark('X')}</span><span><b>${mode === 'local' ? 'Player X' : 'You'}</b><small>Plays X</small></span></div>
        <span class="gb-preview-label">${preview ? 'Interactive<br>practice preview' : 'Local practice<br>Untimed'}</span>
        <div class="gb-player gb-player--right${state.turn === 'O' && !state.winner ? ' gb-player--active' : ''}"><span><b>${mode === 'local' ? 'Player O' : 'Practice'}</b><small>Plays O</small></span><span class="gb-avatar gb-avatar--o">${mark('O')}</span></div>
      </div>
      ${boardMarkup(state, game, { preview, thinking, focus })}
    </div>
    <div class="gb-turn-strip" role="status" aria-live="polite" aria-atomic="true">
      <span class="gb-turn-icon gb-turn-icon--${state.turn.toLowerCase()}">${state.winner === 'DRAW' ? '<span aria-hidden="true">=</span>' : mark(state.winner || state.turn)}</span>
      <strong>${copy.title}</strong><p>${copy.detail}</p>
      <button class="gb-reset" type="button" data-gb-action="reset" aria-label="${preview ? 'Reset practice preview' : 'Start a new practice game'}" title="${preview ? 'Reset preview' : 'New game'}"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 8a8 8 0 1 1-1 7M5 3v5h5"/></svg></button>
    </div>
    ${preview ? '<a class="gb-preview-link" href="/play?mode=practice" data-route>Start a fresh practice game <span aria-hidden="true">↗</span></a>' : `<div class="gb-match-note"><span>${state.moves.length} ${state.moves.length === 1 ? 'move' : 'moves'} played${last ? ` · Last move: ${last.player}, ${POSITIONS[last.b].toLowerCase()} board, ${POSITIONS[last.c].toLowerCase()} cell` : ''}</span><button type="button" data-gb-action="fresh">New game</button></div>`}
  </section>`;
}

export function renderPreview() {
  const game = rules();
  return renderBoard(generatePreviewState(game), game);
}

export function renderPractice() {
  const game = rules();
  return `<section class="gb-practice-page" aria-labelledby="gb-practice-title">
    <header class="gb-page-heading"><span class="gb-eyebrow">PLAY · LOCAL PRACTICE</span><h1 id="gb-practice-title">Small boards.<br><span>Big possibilities.</span></h1><p>A fresh game, a little practice, and your next big move.</p></header>
    <div class="gb-practice-layout"><div class="gb-practice-host" data-board-host data-board-preview="false">${renderBoard(game.create(), game, { preview: false })}</div>
      <aside class="gb-help-panel" aria-labelledby="gb-how-title"><span class="gb-eyebrow">HOW TO PLAY</span><h2 id="gb-how-title">Think one board ahead.</h2><ol><li><b>Win the small boards.</b><p>Place three Xs or Os in a row to claim a small board.</p></li><li><b>Your move sets the route.</b><p>The cell you choose sends the next player to the matching small board. If that board is complete, they can choose any open board.</p></li><li><b>Win the big one.</b><p>Claim three small boards in a row to win the game.</p></li></ol><p class="gb-keyboard-note"><kbd>←</kbd> <kbd>↑</kbd> <kbd>↓</kbd> <kbd>→</kbd> to explore cells. <kbd>Enter</kbd> or <kbd>Space</kbd> to play a legal move.</p><p class="gb-local-note">Local practice · no account needed</p><a href="/play" data-route class="gb-back-link">Explore play modes <span aria-hidden="true">↗</span></a></aside>
    </div>
  </section>`;
}

/** Mount only the supplied board host. Routing owns its lifetime and calls destroy(). */
export function mountBoard(host, { preview = true } = {}) {
  if (!host || typeof host.addEventListener !== 'function') throw new TypeError('A board host is required.');
  const game = rules();
  const session = createBoardSession(game, { preview });
  let destroyed = false;
  let timer = null;
  let generation = 0;
  let mode = 'bot';
  let difficulty = 'Easy';
  let theme = 'vector';
  let focusedCell = null;

  function cancelBot() {
    generation += 1;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }
  const isThinking = () => !session.getState().winner && mode === 'bot' && session.getState().turn === 'O';
  function render({ focusCell = false, setting = null } = {}) {
    if (destroyed) return;
    const html = renderBoard(session.getState(), game, { preview, mode, difficulty, theme, thinking: isThinking(), focus: focusedCell });
    const stage = host.querySelector('[data-gb-stage]');
    if (stage && host.ownerDocument?.createElement) {
      const template = host.ownerDocument.createElement('template');
      template.innerHTML = html;
      const next = template.content;
      for (const selector of ['.gb-frame', '.gb-toolbar', '.gb-match-note']) {
        const currentPart = stage.querySelector(selector);
        const nextPart = next.querySelector(selector);
        if (currentPart && nextPart) currentPart.replaceWith(nextPart);
      }
      // Keep the status node in place so turn changes reach assistive technology.
      stage.querySelector('.gb-turn-strip').innerHTML = next.querySelector('.gb-turn-strip').innerHTML;
      stage.dataset.gbTheme = preview ? 'cinematic' : theme;
    } else host.innerHTML = html;
    if (focusCell && focusedCell) host.querySelector(`[data-gb-cell="${focusedCell}"]`)?.focus({ preventScroll: true });
    if (setting) host.querySelector(`[data-gb-setting="${setting}"]`)?.focus({ preventScroll: true });
  }
  function scheduleBot() {
    if (destroyed || !isThinking() || timer !== null) return;
    const revision = generation;
    timer = setTimeout(() => {
      timer = null;
      if (destroyed || revision !== generation || !isThinking()) return;
      const hadCellFocus = host.contains(host.ownerDocument?.activeElement) && host.ownerDocument?.activeElement?.hasAttribute('data-gb-cell');
      const move = game.choose(session.getState(), difficulty);
      if (move) session.move(move);
      render({ focusCell: hadCellFocus });
    }, 260);
  }
  function reset({ fresh = !preview } = {}) {
    if (destroyed) return;
    cancelBot();
    session.reset({ fresh });
    focusedCell = null;
    render();
  }
  function onClick(event) {
    const target = event.target.closest?.('[data-gb-cell], [data-gb-action]');
    if (!target || !host.contains(target) || destroyed) return;
    if (target.dataset.gbAction) {
      const action = target.dataset.gbAction;
      reset({ fresh: action === 'fresh' || !preview });
      const next = session.legal()[0];
      if (next) {
        focusedCell = `${next.b}:${next.c}`;
        render({ focusCell: true });
      }
      return;
    }
    if (isThinking() || target.getAttribute('aria-disabled') === 'true') return;
    const [b, c] = target.dataset.gbCell.split(':').map(Number);
    if (!session.legal().some(move => move.b === b && move.c === c)) return;
    session.move({ b, c });
    focusedCell = `${b}:${c}`;
    render({ focusCell: true });
    scheduleBot();
  }
  function onKeydown(event) {
    const target = event.target.closest?.('[data-gb-cell]');
    if (!target || !host.contains(target)) return;
    const [b, c] = target.dataset.gbCell.split(':').map(Number);
    let row = Math.floor(b / 3) * 3 + Math.floor(c / 3);
    let col = (b % 3) * 3 + c % 3;
    if (event.key === 'ArrowRight') col = (col + 1) % 9;
    else if (event.key === 'ArrowLeft') col = (col + 8) % 9;
    else if (event.key === 'ArrowDown') row = (row + 1) % 9;
    else if (event.key === 'ArrowUp') row = (row + 8) % 9;
    else if (event.key === 'Home') col = 0;
    else if (event.key === 'End') col = 8;
    else return;
    event.preventDefault();
    const nextB = Math.floor(row / 3) * 3 + Math.floor(col / 3);
    const nextC = (row % 3) * 3 + col % 3;
    focusedCell = `${nextB}:${nextC}`;
    host.querySelectorAll('[data-gb-cell]').forEach(cell => { cell.tabIndex = cell.dataset.gbCell === focusedCell ? 0 : -1; });
    host.querySelector(`[data-gb-cell="${focusedCell}"]`)?.focus();
  }
  function onChange(event) {
    const setting = event.target.dataset.gbSetting;
    if (!setting || preview || destroyed) return;
    if (setting === 'theme' && GAME_THEMES.some(item => item.id === event.target.value)) {
      theme = event.target.value;
      // A theme switch changes CSS only: the board, focus and bot turn stay intact.
      host.querySelector('[data-gb-stage]').dataset.gbTheme = theme;
      return;
    }
    cancelBot();
    if (setting === 'mode') mode = event.target.value === 'local' ? 'local' : 'bot';
    if (setting === 'difficulty' && game.LEVELS.includes(event.target.value)) difficulty = event.target.value;
    render({ setting });
    scheduleBot();
  }
  host.addEventListener('click', onClick);
  host.addEventListener('keydown', onKeydown);
  host.addEventListener('change', onChange);
  render();
  return {
    reset,
    getState: session.getState,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelBot();
      host.removeEventListener('click', onClick);
      host.removeEventListener('keydown', onKeydown);
      host.removeEventListener('change', onChange);
    },
  };
}
