/* Website presentation of the retained rules. Local practice has no server authority. */
export const GAME_THEMES = Object.freeze([
  { id: 'cinematic', name: 'Mega XOXO Neon' },
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
const escapeText = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const localOptions = (options = {}) => ({
  mode: options.mode === 'local' ? 'local' : 'bot',
  difficulty: ['Beginner', 'Easy', 'Medium', 'Hard', 'Expert'].includes(options.difficulty) ? options.difficulty : 'Easy',
  theme: GAME_THEMES.some(theme => theme.id === options.theme) ? options.theme : 'cinematic',
});

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
    move: m => {
      state = approved.apply(state, m);
      return state;
    },
    reset: ({ fresh = false } = {}) => {
      state = preview && !fresh ? generatePreviewState(approved) : approved.create();
      return state;
    },
  };
}

function serverSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') throw new TypeError('A server snapshot is required.');
  if (!['PLAYING', 'FINISHED', 'VOID'].includes(snapshot.status)) throw new Error('INVALID_MATCH_STATUS');
  if (!snapshot.symbols || snapshot.symbols.X === snapshot.symbols.O) throw new Error('INVALID_MATCH_SYMBOLS');
  const state = JSON.parse(JSON.stringify(snapshot.state));
  if (!state || !Array.isArray(state.board) || state.board.length !== 9 || !Array.isArray(state.mini) || state.mini.length !== 9) {
    throw new Error('INVALID_MATCH_SNAPSHOT');
  }
  if (!['X', 'O'].includes(state.turn) || (state.required !== null && (!Number.isInteger(state.required) || state.required < 0 || state.required > 8))) {
    throw new Error('INVALID_MATCH_SNAPSHOT');
  }
  return {
    id: String(snapshot.id),
    status: snapshot.status,
    symbols: { X: snapshot.symbols.X, O: snapshot.symbols.O },
    state,
    revision: Number(snapshot.revision ?? state.moves.length),
    playerNames: snapshot.playerNames || {},
    receipt: snapshot.receipt || null,
    quote: snapshot.quote || null,
    terms: snapshot.terms || null,
  };
}

/** Read-only server authority: this adapter never invokes the local apply/reset path. */
export function createServerBoardSession(game, snapshot, { actorId } = {}) {
  const approved = rules(game);
  let current = serverSnapshot(snapshot);
  return {
    getState: () => current.state,
    getSnapshot: () => current,
    canPlay: () => current.status === 'PLAYING' && !!actorId && current.symbols[current.state.turn] === actorId,
    legal: () => (current.status === 'PLAYING' && !!actorId && current.symbols[current.state.turn] === actorId ? approved.legal(current.state) : []),
    receive: candidate => {
      const next = serverSnapshot(candidate);
      if (next.id !== current.id || next.symbols.X !== current.symbols.X || next.symbols.O !== current.symbols.O) return false;
      if (current.status !== 'PLAYING' && next.status === 'PLAYING') return false;
      if (next.revision < current.revision || next.state.moves.length < current.state.moves.length) return false;
      for (let i = 0; i < current.state.moves.length; i++) {
        const a = current.state.moves[i], b = next.state.moves[i];
        if (a.b !== b.b || a.c !== b.c || a.player !== b.player) return false;
      }
      current = next;
      return true;
    },
  };
}

function mark(player, extra = '') {
  const shape = player === 'X'
    ? '<path d="M10 10 30 30M30 10 10 30"/>'
    : '<circle cx="20" cy="20" r="13"/>';
  return `<svg class="gb-mark gb-mark--${player.toLowerCase()} ${extra}" viewBox="0 0 40 40" fill="none" aria-hidden="true">${shape}</svg>`;
}

function boardMarkup(state, game, { thinking = false, blocked = false, focus = null, guidedTargetCell = null, guidedDestination = null } = {}) {
  const legal = new Set(game.legal(state).map(move => `${move.b}:${move.c}`));
  const legalList = game.legal(state);
  const first = focus ?? (guidedTargetCell ? guidedTargetCell : (legalList[0] ? `${legalList[0].b}:${legalList[0].c}` : '0:0'));
  return `<div class="gb-grid" role="group" aria-label="Mega XOXO board, nine small boards">
    ${state.board.map((cells, b) => {
      const isGuidedDest = guidedDestination !== null && b === guidedDestination;
      const active = !state.winner && !state.mini[b] && cells.some((_, c) => legal.has(`${b}:${c}`));
      const claimed = state.mini[b];
      const name = `${POSITIONS[b]} board${claimed ? claimed === 'DRAW' ? ', drawn' : `, won by ${claimed}` : ''}`;
      return `<div class="gb-mini${active ? ' gb-mini--active' : ''}${claimed ? ' gb-mini--claimed' : ''}${state.line?.includes(b) ? ' gb-mini--winning' : ''}${isGuidedDest ? ' gb-mini--guided-destination' : ''}" role="group" aria-label="${name}" data-gb-mini="${b}">
        ${cells.map((value, c) => {
          const key = `${b}:${c}`;
          const isTarget = guidedTargetCell !== null && key === guidedTargetCell;
          const allowed = guidedTargetCell !== null
            ? (isTarget && !thinking && !blocked)
            : (legal.has(key) && !thinking && !blocked);
          const label = `${POSITIONS[b]} board, ${POSITIONS[c].toLowerCase()} cell: ${value || 'empty'}${value ? ', occupied' : claimed ? ', board complete' : isTarget ? ', required guided move' : allowed ? ', legal move' : thinking && legal.has(key) ? ', bot is thinking' : ', unavailable this turn'}`;
          return `<button class="gb-cell${value ? ` gb-cell--${value.toLowerCase()}` : ''}${allowed ? ' gb-cell--legal' : ''}${isTarget ? ' gb-cell--guided-target' : ''}" type="button" data-gb-cell="${key}" aria-label="${label}" aria-disabled="${!allowed}" tabindex="${key === first ? '0' : '-1'}">${value ? mark(value) : allowed ? '<span class="gb-move-dot" aria-hidden="true"></span>' : ''}</button>`;
        }).join('')}
        ${claimed ? `<div class="gb-claim" aria-hidden="true">${claimed === 'DRAW' ? '<span>DRAW</span>' : mark(claimed)}</div>` : ''}
      </div>`;
    }).join('')}
  </div>`;
}

function turnCopy(state, { mode, thinking, preview, snapshot, actorId, pending, error, botRecovery = null }) {
  if (snapshot) {
    if (snapshot.status === 'VOID') return { title: 'Match cancelled', detail: 'This match is complete. Choose a play mode for your next game.' };
    if (snapshot.status === 'FINISHED') return { title: snapshot.receipt?.winner === null ? 'Draw' : snapshot.receipt?.winner === actorId ? 'You win' : 'Match finished', detail: 'This match is complete. Choose a play mode for your next game.' };
    if (['AUTH_REQUIRED', 'LINK_ACCOUNT_REQUIRED'].includes(error)) return { title: 'Sign in to play online', detail: 'Link your profile to continue this online match.' };
    if (error) return { title: 'Connection interrupted', detail: 'Check the latest match state before retrying your move.' };
    if (pending) return { title: pending === 'resign' ? 'Ending match' : 'Sending your move', detail: pending === 'resign' ? 'Waiting for your resignation to be confirmed.' : 'Waiting for your move to be confirmed.' };
    return { title: snapshot.symbols[state.turn] === actorId ? 'Your move' : 'Opponent’s move', detail: state.required === null ? 'The next player can choose any open board.' : `The next move is in the ${POSITIONS[state.required].toLowerCase()} board.` };
  }
  if (botRecovery) return { title: 'Worker calculation failed', detail: 'Worker calculation was interrupted or unavailable. Calculate move on this device?' };
  if (state.winner === 'DRAW') return { title: 'Draw', detail: 'All small boards are complete. Start a new practice game to play again.' };
  if (state.winner) return { title: `${state.winner} wins`, detail: 'Three small boards in a row win the big one. Start a new game to play again.' };
  const title = thinking ? 'Bot is thinking' : mode === 'bot' ? 'Your move' : `${state.turn} to move`;
  const detail = state.required === null
    ? 'Choose any open board. Your cell chooses where the next player moves.'
    : preview
      ? 'Play in the highlighted board. Your move sends the next player to the corresponding board.'
      : `Play in the ${POSITIONS[state.required].toLowerCase()} board. Your cell chooses the next board.`;
  return { title, detail };
}

function toolbar({ mode, difficulty, theme, snapshot, guidedLocked = false, workspace = false, gameMode = mode }) {
  return `<div class="gb-toolbar">
    ${snapshot ? `<span class="gb-online-mode">${snapshot.terms?.source === 'tournament' ? 'Tournament' : snapshot.quote?.rated ? 'Ranked' : snapshot.terms?.source === 'queue' ? 'Casual' : 'Friendly match'}</span>` : `<label>Play mode<select ${workspace ? 'data-game-mode' : 'data-gb-setting="mode"'}${guidedLocked ? ' disabled aria-describedby="gb-guided-title"' : ''}><option value="bot"${gameMode === 'bot' ? ' selected' : ''}>Play against Bot</option><option value="local"${gameMode === 'local' ? ' selected' : ''}>Two players · same screen</option>${workspace ? ['ranked','casual','friends'].map(value => `<option value="${value}"${gameMode === value ? ' selected' : ''}>${({ranked:'Ranked · online',casual:'Casual · online',friends:'Play with friends'})[value]}</option>`).join('') : ''}</select></label>
    <label${gameMode !== 'bot' ? ' hidden' : ''}>Bot level<select aria-label="Bot level" data-gb-setting="difficulty"${guidedLocked ? ' disabled aria-describedby="gb-guided-title"' : ''}>${['Beginner', 'Easy', 'Medium', 'Hard', 'Expert'].map(level => `<option${difficulty === level ? ' selected' : ''}>${level}</option>`).join('')}</select></label>`}
    <label>Game theme<select aria-label="Game theme" data-gb-setting="theme">${GAME_THEMES.map(item => `<option value="${item.id}"${theme === item.id ? ' selected' : ''}>${item.name}</option>`).join('')}</select></label>
  </div>`;
}

function guidedPanel(view) {
  if (!view) return '';
  const isPrompt = view.phase === 'PROMPT' && !view.confirmRestart;
  return `<section class="gb-guided-panel" role="region" aria-label="Guided practice tutorial" data-gb-guided-phase="${escapeText(view.phase)}">
    <div class="gb-guided-header">
      <span class="gb-guided-progress">${escapeText(view.phase === 'DONE' ? 'Unpaid Beginner practice' : `Guided move ${view.guidedMoves} / 6`)}</span>
      <h2 class="gb-guided-title" id="gb-guided-title" tabindex="-1">${escapeText(view.title)}</h2>
    </div>
    <p class="gb-guided-caption" id="gb-guided-caption" role="status" aria-live="polite" aria-atomic="true">${escapeText(view.text)}</p>
    ${isPrompt ? `<div class="gb-guided-diagram" role="img" aria-label="Three X marks claim one Mini Board. Three claimed Mini Boards in a line win the Mega Board.">
      <div class="gb-guided-diagram-step"><span>Mini Board</span><b>X · X · X</b><small>Win 1 small board</small></div>
      <span class="gb-guided-arrow" aria-hidden="true">→</span>
      <div class="gb-guided-diagram-step"><span>Mega Board</span><b>[X] · [X] · [X]</b><small>Win 3 in a line</small></div>
    </div>` : ''}
    <div class="gb-guided-controls">
      ${view.confirmRestart ? `<button class="gb-guided-btn gb-guided-btn--danger" type="button" data-gb-guided="restart-confirm">Restart now</button>
      <button class="gb-guided-btn gb-guided-btn--secondary" type="button" data-gb-guided="restart-cancel">Keep playing</button>` : view.phase === 'DONE' ? `<button class="gb-guided-btn gb-guided-btn--secondary" type="button" data-gb-guided="hide">Keep playing</button>
      <button class="gb-guided-btn gb-guided-btn--secondary" type="button" data-gb-guided="restart">Restart tutorial</button>` : `${view.phase === 'AWAIT_MOVE' ? `<button class="gb-guided-btn gb-guided-btn--secondary" type="button" data-gb-guided="hint">Hint</button>` : `<button class="gb-guided-btn gb-guided-btn--primary" type="button" data-gb-guided="continue">${view.phase === 'PROMPT' ? 'Show my first move' : view.guidedMoves === 6 ? 'Play from here' : 'Continue'}</button>`}
      <button class="gb-guided-btn gb-guided-btn--secondary" type="button" data-gb-guided="skip">Skip guidance</button>`}
    </div>
    ${!view.confirmRestart && view.phase !== 'DONE' ? `<details class="gb-guided-details">
      <summary>Explanation and audio</summary>
      <div class="gb-guided-details-body">
        <button class="gb-guided-btn gb-guided-btn--secondary" type="button" data-gb-guided="replay">Replay explanation</button>
        <button class="gb-guided-btn gb-guided-btn--secondary" type="button" data-gb-guided="restart">Restart tutorial</button>
        <button class="gb-guided-btn gb-guided-btn--secondary" type="button" data-gb-guided="voice" aria-pressed="${view.narrationEnabled ? 'true' : 'false'}">${view.narrationEnabled ? 'Mute narration' : 'Enable narration'}</button>
        <label class="gb-guided-volume-label">
          <span>Narration volume</span>
          <input class="gb-guided-volume" type="range" min="0" max="1" step="0.1" value="${typeof view.volume === 'number' ? view.volume : 0.8}" data-gb-guided="volume" aria-label="Narration volume">
        </label>
      </div>
    </details>` : ''}
  </section>`;
}

const gameIcon = name => {
  const paths = {
    setup: '<path d="M4 7h16M4 17h16M8 4v6M16 14v6"/>',
    players: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M17 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v2"/>',
    guide: '<path d="M12 5v15M3 4c4-1 6 0 9 2 3-2 5-3 9-2v15c-4-1-6 0-9 2-3-2-5-3-9-2z"/>',
    reset: '<path d="M4 10a8 8 0 1 1 1 8M4 4v6h6"/>',
    share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m9 10 6-4M9 14l6 4"/>',
    stats: '<path d="M5 20v-6h3v6M11 20V9h3v11M17 20V4h3v16"/>',
    route: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="19" r="2"/><path d="M8 5h8a4 4 0 0 1 0 8H8a3 3 0 0 0 0 6h8"/>',
  };
  return `<svg class="gb-ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.setup}</svg>`;
};

function gameDashboard(state, game, options) {
  const {mode, difficulty, theme, snapshot, actorId, pending, error, uncertain, requestKind, canResign, guidedView, botRecovery, powersView, gameMode = mode, accountPending = false} = options;
  const waitingOnline = !snapshot && ['ranked','casual','friends'].includes(gameMode);
  const copy = waitingOnline ? {title:'Ready for your next rival',detail:gameMode === 'friends' ? 'Choose a friend in Game Setup to arrange your next match.' : `Use Game Setup to join the ${gameMode === 'ranked' ? 'Ranked' : 'Casual'} queue.`} : turnCopy(state, options);
  const playerName = player => snapshot ? snapshot.symbols[player] === actorId ? 'You' : escapeText(snapshot.playerNames?.[snapshot.symbols[player]] || 'Opponent') : waitingOnline ? player === 'X' ? 'You' : 'Opponent' : mode === 'local' ? `Player ${player}` : player === 'X' ? 'You' : 'Bot';
  const blocked = waitingOnline || !!snapshot && (snapshot.status !== 'PLAYING' || snapshot.symbols[state.turn] !== actorId || pending || uncertain || !!error || accountPending);
  const powerPanel = !snapshot && !waitingOnline && mode === 'bot' && !guidedView && globalThis.MegaWebPowers?.render
    ? globalThis.MegaWebPowers.render(powersView || {mode:'bot', available:false}, {workspace:true}) : !snapshot && !waitingOnline && mode==='bot' && !guidedView ? '<section class="gb-powers" data-gb-powers aria-label="Optional powers"><h2>Powers</h2><p>Bot Undo and Tactical Hint controls are unavailable until the verified powers service loads.</p></section>' : '';
  return `<section class="gb-stage gb-stage--practice gb-dashboard" data-gb-stage data-gb-theme="${theme}" aria-label="${snapshot ? 'Online Mega XOXO match' : 'Local Mega XOXO game'}">
    <aside class="gb-game-left" aria-label="Game setup and players">
      <section class="gb-game-panel gb-game-setup"><h2>${gameIcon('setup')}Game Setup</h2>${toolbar({mode, difficulty, theme, snapshot, workspace:true, gameMode, guidedLocked:!!guidedView})}<div class="mx-online-controls gb-online-controls" data-online-controls aria-live="polite"></div></section>
      <section class="gb-game-panel gb-game-players"><h2>${gameIcon('players')}Players</h2>${['X','O'].map(player=>`<div class="gb-roster-player${state.turn===player&&!state.winner?' gb-roster-player--active':''}"><span class="gb-avatar gb-avatar--${player.toLowerCase()}">${mark(player)}</span><span><b>${playerName(player)}</b><small>${snapshot ? `Plays ${player}` : waitingOnline ? 'Online player' : mode==='local' ? 'Same-screen player' : player==='X' ? 'Player' : `${difficulty} difficulty`}</small></span><strong aria-label="${state.mini.filter(v=>v===player).length} small boards won">${state.mini.filter(v=>v===player).length}<small>boards</small></strong></div>`).join('')}</section>
      <div class="gb-turn-strip" role="status" aria-live="polite" aria-atomic="true"><span class="gb-turn-icon gb-turn-icon--${state.turn.toLowerCase()}">${state.winner==='DRAW'?'=':mark(state.winner||state.turn)}</span><div>${snapshot&&['AUTH_REQUIRED','LINK_ACCOUNT_REQUIRED'].includes(error)?'<a class="gb-sign-in" href="/account" data-route>Sign in to play online</a>':`<strong>${copy.title}</strong>`}<p>${copy.detail}</p></div>${botRecovery?'<button class="gb-reset" type="button" data-gb-action="bot-recovery">Calculate</button>':''}</div>
    </aside>
    <div class="gb-game-centre">${guidedPanel(guidedView)}<div class="gb-frame">${boardMarkup(state,game,{...options,blocked})}</div>
      <div class="gb-match-note"><span class="gb-move-count">${gameIcon('stats')}<span>Moves<strong data-gb-move-total>${state.moves.length}</strong></span></span><div class="gb-game-actions">${snapshot ? `${uncertain&&error&&!['AUTH_REQUIRED','LINK_ACCOUNT_REQUIRED'].includes(error)?`<button type="button" data-gb-action="retry">Retry ${requestKind==='resign'?'resignation':'move'}</button>`:''}${canResign&&snapshot.status==='PLAYING'?`<button type="button" data-gb-action="resign"${pending||uncertain||error?' disabled':''}>Resign</button>`:''}` : waitingOnline ? '' : `<button type="button" data-gb-action="fresh">${gameIcon('reset')}Reset board</button><button type="button" data-gb-action="rematch">${gameIcon('players')}New game</button>`}<button type="button" data-gb-action="share">${gameIcon('share')}Share game</button></div></div>
      <p class="gb-route-note">Your cell determines the opponent’s next board.</p>
    </div>
    <aside class="gb-game-right" aria-label="Powers and game guide">${powerPanel}
      <details class="gb-game-panel gb-help-panel" aria-labelledby="gb-how-title"><summary><span>${gameIcon('guide')}<span id="gb-how-title">Guided Practice<small>Learn in six interactive moves</small></span></span><span class="gb-guide-chevron" aria-hidden="true">⌄</span></summary><div class="gb-guide-content"><p class="gb-guide-intro">One cell sends your opponent to the matching small board. Try it step by step.</p><ol><li><b>Make your move.</b><p>See exactly where it sends your opponent.</p></li><li><b>Win three in a row.</b><p>Claim small boards, then connect three to win the game.</p></li></ol>${snapshot?'':waitingOnline?'<a class="gb-button gb-button--guided" href="/game?mode=bot&amp;tutorial=guided" data-route>Start guided practice →</a>':`<button class="gb-button gb-button--guided" type="button" data-gb-action="start-guided">Start guided practice <span aria-hidden="true">→</span></button>`}<a class="gb-full-guide" href="/how-to-play" data-route>Read the rules <span aria-hidden="true">→</span></a><details class="gb-game-shortcuts"><summary>Keyboard controls</summary><p class="gb-keyboard-note"><kbd>←</kbd> <kbd>↑</kbd> <kbd>↓</kbd> <kbd>→</kbd> to explore cells. <kbd>Enter</kbd> or <kbd>Space</kbd> to play a legal move.</p></details></div></details>
    </aside>
  </section>`;
}

function renderBoard(state, game, {
  preview = true,
  mode = 'bot',
  difficulty = 'Easy',
  theme = 'cinematic',
  thinking = false,
  focus = null,
  snapshot = null,
  actorId = '',
  pending = false,
  error = '',
  uncertain = false,
  requestKind = '',
  canResign = false,
  guidedView = null,
  guidedTargetCell = null,
  guidedDestination = null,
  botRecovery = null,
  powersView = null,
  workspace = false,
  gameMode = mode,
  accountPending = false,
} = {}) {
  if (!preview && workspace) return gameDashboard(state, game, {preview, mode, difficulty, theme, thinking, focus, snapshot, actorId, pending, error, uncertain, requestKind, canResign, guidedView, guidedTargetCell, guidedDestination, botRecovery, powersView, gameMode, accountPending});
  const copy = turnCopy(state, { preview, mode, thinking, snapshot, actorId, pending, error, botRecovery });
  const last = state.moves.at(-1);
  const playerName = player => snapshot ? snapshot.symbols[player] === actorId ? 'You' : escapeText(snapshot.playerNames?.[snapshot.symbols[player]] || 'Opponent') : mode === 'local' ? `Player ${player}` : player === 'X' ? 'You' : 'Bot';
  const blocked = !!snapshot && (snapshot.status !== 'PLAYING' || snapshot.symbols[state.turn] !== actorId || pending || uncertain || !!error);
  return `<section class="gb-stage${preview ? ' gb-stage--preview' : ' gb-stage--practice'}" data-gb-stage data-gb-theme="${preview ? 'cinematic' : theme}" aria-label="${preview ? 'Interactive practice preview against Bot' : snapshot ? 'Online Mega XOXO match' : 'Local Mega XOXO game'}">
    ${preview ? '' : toolbar({ mode, difficulty, theme, snapshot, guidedLocked: !!guidedView })}
    ${guidedPanel(guidedView)}
    <div class="gb-frame">
      <div class="gb-hud">
        <div class="gb-player${state.turn === 'X' && !state.winner ? ' gb-player--active' : ''}"><span class="gb-avatar gb-avatar--x">${mark('X')}</span><span><b>${playerName('X')}</b><small>Plays X</small></span></div>
        <span class="gb-hud-spacer" aria-hidden="true"></span>
        <div class="gb-player gb-player--right${state.turn === 'O' && !state.winner ? ' gb-player--active' : ''}"><span><b>${playerName('O')}</b><small>Plays O</small></span><span class="gb-avatar gb-avatar--o">${mark('O')}</span></div>
      </div>
      ${boardMarkup(state, game, { thinking, blocked, focus, guidedTargetCell, guidedDestination })}
    </div>
    <div class="gb-turn-strip" role="status" aria-live="polite" aria-atomic="true">
      <span class="gb-turn-icon gb-turn-icon--${state.turn.toLowerCase()}">${state.winner === 'DRAW' ? '<span aria-hidden="true">=</span>' : mark(state.winner || state.turn)}</span>
      ${snapshot && ['AUTH_REQUIRED', 'LINK_ACCOUNT_REQUIRED'].includes(error) ? '<a class="gb-sign-in" href="/account" data-route>Sign in to play online</a>' : `<strong>${copy.title}</strong>`}<p>${copy.detail}</p>
      ${snapshot ? '' : botRecovery ? '<button class="gb-reset" type="button" data-gb-action="bot-recovery" title="Calculate on device">Calculate</button>' : `<button class="gb-reset" type="button" data-gb-action="reset" aria-label="${preview ? 'Reset practice preview' : 'Start a new game'}" title="${preview ? 'Reset preview' : 'New game'}"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 8a8 8 0 1 1-1 7M5 3v5h5"/></svg></button>`}
    </div>
    ${preview ? '<a class="gb-preview-link" href="/game" data-route>Start a fresh game <span aria-hidden="true">↗</span></a>' : `<div class="gb-match-note"><span>${state.moves.length} ${state.moves.length === 1 ? 'move' : 'moves'} played${last ? ` · Last move: ${last.player}, ${POSITIONS[last.b].toLowerCase()} board, ${POSITIONS[last.c].toLowerCase()} cell` : ''}</span>${snapshot ? `${uncertain && error && !['AUTH_REQUIRED', 'LINK_ACCOUNT_REQUIRED'].includes(error) ? `<button type="button" data-gb-action="retry">Retry ${requestKind === 'resign' ? 'resignation' : 'move'}</button>` : ''}${canResign && snapshot.status === 'PLAYING' ? `<button type="button" data-gb-action="resign"${pending || uncertain || error ? ' disabled' : ''}>Resign</button>` : ''}` : botRecovery ? '<button type="button" data-gb-action="bot-recovery">Calculate on this device</button>' : '<button type="button" data-gb-action="fresh">Reset board</button>'}</div>`}
    ${!preview && !snapshot && mode === 'bot' && !guidedView ? globalThis.MegaWebPowers?.render ? globalThis.MegaWebPowers.render(powersView || { mode: 'bot', available: false }) : '<section class="gb-powers" data-gb-powers aria-label="Optional powers"><h2>Bot Undo</h2><p>Power controls are unavailable until the verified powers service loads.</p><button type="button" disabled>Use earned Undo</button></section>' : ''}
  </section>`;
}

export function renderPreview() {
  const game = rules();
  return renderBoard(generatePreviewState(game), game);
}

/** A first-class website game route. Online data, when supplied, remains server-owned. */
export function renderGame(context = {}) {
  const game = rules();
  const options = localOptions(context);
  const snapshot = context.match ? serverSnapshot(context.match) : null;
  const actorId = typeof context.actorId === 'string' ? context.actorId : '';
  return `<section class="gb-practice-page gb-game-page" aria-labelledby="gb-game-title">
    <header class="gb-page-heading"><div><span class="gb-eyebrow">MEGA XOXO · ${snapshot ? 'ONLINE MATCH' : 'PLAY IN BROWSER'}</span><h1 id="gb-game-title">Your next <span>big move.</span></h1><p>${snapshot ? 'Every move matters. Think one board ahead.' : 'Play against Bot or share a screen with a friend.'}</p></div><a href="/play" data-route class="gb-back-link">Explore play modes <span aria-hidden="true">↗</span></a></header>
    <div class="gb-practice-layout"><div class="gb-practice-host" data-board-host data-board-preview="false" data-board-layout="workspace" data-board-mode="${options.mode}" data-board-difficulty="${options.difficulty}" data-board-theme="${options.theme}">${renderBoard(snapshot ? snapshot.state : game.create(), game, { preview: false, workspace: true, ...options, gameMode: context.mode || options.mode, snapshot, actorId })}</div></div>
  </section>`;
}

export function renderPractice(context = {}) {
  const game = rules();
  const options = localOptions(context);
  const snapshot = context.match ? serverSnapshot(context.match) : null;
  const actorId = typeof context.actorId === 'string' ? context.actorId : '';
  return `<section class="gb-practice-page gb-legacy-practice-page" aria-labelledby="gb-game-title">
    <header class="gb-page-heading"><div><span class="gb-eyebrow">MEGA XOXO · ${snapshot ? 'ONLINE MATCH' : 'PLAY IN BROWSER'}</span><h1 id="gb-game-title">Your next <span>big move.</span></h1><p>${snapshot ? 'Every move matters. Think one board ahead.' : 'Play against Bot or share a screen with a friend.'}</p></div><a href="/play" data-route class="gb-back-link">Explore play modes <span aria-hidden="true">↗</span></a></header>
    <div class="gb-practice-layout"><div class="gb-practice-host" data-board-host data-board-preview="false" data-board-mode="${options.mode}" data-board-difficulty="${options.difficulty}" data-board-theme="${options.theme}">${renderBoard(snapshot ? snapshot.state : game.create(), game, { preview: false, ...options, snapshot, actorId })}</div>
      <aside class="gb-help-panel" aria-labelledby="gb-how-title"><span class="gb-eyebrow">HOW TO PLAY</span><h2 id="gb-how-title">Think one board ahead.</h2>${snapshot ? '' : `<div class="gb-guided-cta"><button class="gb-button gb-button--guided" type="button" data-gb-action="start-guided">Start guided practice</button><p class="gb-guided-subtext">Learn Mega XOXO in six interactive moves. Wrong taps blocked, no rewards or pressure.</p></div>`}<ol><li><b>Win the small boards.</b><p>Place three Xs or Os in a row to claim a small board.</p></li><li><b>Your move sets the route.</b><p>The cell you choose sends the next player to the matching small board. If that board is complete, they can choose any open board.</p></li><li><b>Win the big one.</b><p>Claim three small boards in a row to win the game.</p></li></ol><p class="gb-keyboard-note"><kbd>←</kbd> <kbd>↑</kbd> <kbd>↓</kbd> <kbd>→</kbd> to explore cells. <kbd>Enter</kbd> or <kbd>Space</kbd> to play a legal move.</p><p class="gb-local-note">${snapshot ? 'Watch the highlighted board for the next turn.' : 'Two players on the same screen or play against the offline bot.'}</p><div class="gb-mode-links"><a href="/ranked" data-route>Ranked</a><a href="/casual" data-route>Casual</a><a href="/friends" data-route>Play with a friend</a></div></aside>
    </div>
  </section>`;
}


/** Mount only the supplied board host. Routing owns its lifetime and calls destroy(). */
export function mountBoard(host, {
  preview = true,
  mode: initialMode,
  difficulty: initialDifficulty,
  theme: initialTheme,
  online = null,
  tutorial: initialTutorial = false,
  compat: injectedCompat = null,
  workerFactory = null,
  workspace = host?.dataset?.boardLayout === 'workspace',
  linked, sessionStatus, profile,
} = {}) {
  if (!host || typeof host.addEventListener !== 'function') throw new TypeError('A board host is required.');
  const game = rules();
  if (online) preview = false;
  if (online && typeof online.onMove !== 'function') throw new TypeError('An online move callback is required.');
  const session = online ? createServerBoardSession(game, online.match, { actorId: online.actorId }) : createBoardSession(game, { preview });
  let destroyed = false;
  let timer = null;
  let generation = 0;
  let { mode, difficulty, theme } = localOptions({ mode: initialMode ?? host.dataset?.boardMode, difficulty: initialDifficulty ?? host.dataset?.boardDifficulty, theme: initialTheme ?? host.dataset?.boardTheme });
  let selectedMode = ['bot','local','ranked','casual','friends'].includes(initialMode) ? initialMode : mode;
  let accountState = {linked:linked ?? Boolean(online), sessionStatus:sessionStatus || (online ? 'linked' : 'loading'), profile:profile || null};
  let focusedCell = null;
  let pending = false;
  let uncertain = false;
  let request = null;
  let error = '';
  let botRecovery = null;
  // Local practice has no verified permanent actor/match binding. Reader presentation
  // is useful here; writes remain closed even if a powers/v1 object is present.
  const powers = !preview && !online ? globalThis.MegaWebPowers?.createController?.({
    getMatchSummary: () => ({ mode, difficulty, revision: session.getState().moves.length, status: session.getState().winner ? 'FINISHED' : 'PLAYING' }),
    onChange: () => render(),
  }) : null;

  const compat = injectedCompat || globalThis.MegaWebBotCompat || null;
  const botRunner = compat?.createBotRunner ? compat.createBotRunner({ game, workerFactory }) : null;
  const tutorialController = compat?.createTutorialController ? compat.createTutorialController({
    game,
    onNotify: message => {
      const toast = host.ownerDocument?.querySelector('#notification');
      if (toast) {
        toast.textContent = message;
        toast.hidden = false;
        setTimeout(() => { toast.hidden = true; }, 3500);
      }
    },
  }) : null;
  const guidedStart = !online && !preview
    ? host.closest?.('.gb-practice-layout')?.querySelector('[data-gb-action="start-guided"]')
    : null;
  const beginMatch = (saved = null, practice = false) => !online && botRunner?.setGameId(null, saved, practice);
  const saveGuided = () => compat?.savePracticeSession?.({
    state: session.getState(), lesson: tutorialController.getSnapshot(), difficulty, theme,
    botInfo: botRunner?.getState?.().botInfo,
  });
  beginMatch();

  if (!online && !preview && tutorialController) {
    let shouldStart = initialTutorial || host.dataset?.boardGuided === 'true';
    if (!shouldStart && typeof window !== 'undefined') {
      try {
        const query = new URLSearchParams(window.location?.search);
        if (['1','guided'].includes(query.get('tutorial')) || query.get('mode') === 'tutorial') shouldStart = true;
      } catch {}
    }
    if (shouldStart) {
      selectedMode = 'bot';
      difficulty = 'Beginner';
      mode = 'bot';
      beginMatch(null, true);
      tutorialController.start(session.getState());
      saveGuided();
    } else if (compat.loadPracticeSession) {
      const saved = compat.loadPracticeSession({ game });
      if (saved && saved.lesson) {
        session.reset({ fresh: true });
        for (const m of saved.state.moves) session.move(m);
        beginMatch(saved.botInfo, true);
        tutorialController.restore(saved.lesson, session.getState());
        mode = 'bot';
        if (saved.difficulty) difficulty = saved.difficulty;
        if (saved.theme) theme = saved.theme;
      }
    }
  }

  function cancelBot() {
    generation += 1;
    clearTimeout(timer);
    timer = null;
    botRecovery = null;
    botRunner?.cancel();
  }

  const isThinking = () => !online && !host.ownerDocument?.hidden && (!tutorialController || !tutorialController.isActive()) && !session.getState().winner && mode === 'bot' && session.getState().turn === 'O';

  function render({ focusCell = false, setting = null } = {}) {
    if (destroyed) return;
    const guidedView = tutorialController && (tutorialController.isActive() || tutorialController.isConfirmRestart()) ? tutorialController.getView(session.getState()) : null;
    const guidedTargetCell = guidedView?.phase === 'AWAIT_MOVE' && guidedView.move ? `${guidedView.move.b}:${guidedView.move.c}` : null;
    const guidedDestination = guidedView?.phase === 'AWAIT_CONTINUE' ? session.getState().required : null;

    const html = renderBoard(session.getState(), game, {
      preview,
      workspace,
      gameMode: selectedMode,
      accountPending: Boolean(online) && (accountState.sessionStatus !== 'linked' || Boolean(accountState.profile?.id && accountState.profile.id !== online.actorId)),
      mode,
      difficulty,
      theme,
      thinking: isThinking() && !botRecovery,
      focus: focusedCell,
      snapshot: online ? session.getSnapshot() : null,
      actorId: online?.actorId,
      pending: pending && request?.kind,
      error,
      uncertain,
      requestKind: request?.kind,
      canResign: typeof online?.onResign === 'function' && Object.values(session.getSnapshot().symbols).includes(online.actorId),
      guidedView,
      guidedTargetCell,
      guidedDestination,
      botRecovery,
      powersView: powers?.refresh(),
    });
    const stage = host.querySelector('[data-gb-stage]');
    if (stage && host.ownerDocument?.createElement) {
      const template = host.ownerDocument.createElement('template');
      template.innerHTML = html;
      const next = template.content;
      for (const selector of ['.gb-guided-panel', '.gb-frame', '.gb-toolbar', '.gb-game-players', '.gb-match-note', '.gb-powers']) {
        const currentPart = stage.querySelector(selector);
        const nextPart = next.querySelector(selector);
        if (selector === '.gb-powers' && currentPart && nextPart) {
          const details = currentPart.querySelector('details');
          if (details?.open) nextPart.querySelector('details').open = true;
        }
        if (currentPart && nextPart) currentPart.replaceWith(nextPart);
        else if (!currentPart && nextPart && selector === '.gb-guided-panel') {
          stage.querySelector('.gb-frame')?.before(nextPart);
        } else if (!currentPart && nextPart && selector === '.gb-powers') {
          (stage.querySelector('.gb-game-right') || stage).prepend(nextPart);
        } else if (currentPart && !nextPart && ['.gb-guided-panel', '.gb-powers'].includes(selector)) {
          currentPart.remove();
        }
      }
      stage.querySelector('.gb-turn-strip').innerHTML = next.querySelector('.gb-turn-strip').innerHTML;
      stage.dataset.gbTheme = preview ? 'cinematic' : theme;
    } else host.innerHTML = html;
    if (focusCell && focusedCell) host.querySelector(`[data-gb-cell="${focusedCell}"]`)?.focus({ preventScroll: true });
    if (setting) host.querySelector(`[data-gb-setting="${setting}"]`)?.focus({ preventScroll: true });
    if (workspace && typeof CustomEvent !== 'undefined') host.dispatchEvent?.(new CustomEvent('gb:render', {bubbles:true}));
  }

  function scheduleBot() {
    if (destroyed || !isThinking() || timer !== null) return;
    const revision = generation;
    timer = setTimeout(() => {
      timer = null;
      if (destroyed || revision !== generation || !isThinking()) return;
      const hadCellFocus = host.contains(host.ownerDocument?.activeElement) && host.ownerDocument?.activeElement?.hasAttribute('data-gb-cell');

      if (botRunner) {
        botRunner.choose({
          state: session.getState(),
          difficulty,
          // The runner pins the canonical startInfo recipe for this match.
        }).then(result => {
          if (destroyed || revision !== generation || !isThinking()) return;
          if (result?.move) {
            session.move(result.move);
            if (botRunner.getState?.().practice) saveGuided();
            render({ focusCell: hadCellFocus });
          } else if (result?.diagnostics?.recoveryRequired) {
            botRecovery = { difficulty, reason: result.diagnostics.reason };
            render();
          }
        }).catch(() => {
          if (destroyed || revision !== generation || !isThinking()) return;
          botRecovery = { difficulty, reason: 'WORKER_FAILURE' };
          render();
        });
      } else {
        // Fallback when botRunner runtime is not loaded (preserves original G.choose behavior in unit tests)
        const move = game.choose(session.getState(), difficulty);
        if (move) session.move(move);
        render({ focusCell: hadCellFocus });
      }
    }, 260);
  }

  function reset({ fresh = !preview } = {}) {
    if (destroyed || online) return;
    cancelBot();
    tutorialController?.stop();
    compat?.clearPracticeSession?.();
    session.reset({ fresh });
    beginMatch();
    focusedCell = null;
    render();
  }

  function startGuided() {
    if (destroyed || online || preview || host.ownerDocument?.hidden) return;
    if (!tutorialController) {
      const toast = host.ownerDocument?.querySelector('#notification');
      if (toast) { toast.textContent = 'Tutorial is loading. Please try again.'; toast.hidden = false; }
      return;
    }
    cancelBot();
    session.reset({ fresh: true });
    difficulty = 'Beginner';
    mode = 'bot';
    selectedMode = 'bot';
    beginMatch(null, true);
    tutorialController.start(session.getState());
    saveGuided();
    const view = tutorialController.getView(session.getState());
    if (view?.text) compat?.speakNarration?.(view.text, { enabled: view.narrationEnabled, volume: view.volume });
    render();
    host.querySelector('#gb-guided-title')?.focus?.({preventScroll:false});
  }

  function receive(snapshot) {
    if (destroyed || !online) return false;
    if (!session.receive(snapshot)) return false;
    if (!request || ['AUTH_REQUIRED', 'LINK_ACCOUNT_REQUIRED'].includes(error) || session.getSnapshot().status !== 'PLAYING' || session.getState().moves.length > request.revision) {
      request = null;
      pending = false;
      uncertain = false;
      error = '';
    }
    render();
    return true;
  }

  function submit(operation) {
    if (destroyed || pending) return;
    request = operation;
    pending = true;
    uncertain = false;
    error = '';
    render();
    const active = operation;
    const callback = operation.kind === 'resign' ? online.onResign : online.onMove;
    let result;
    try { result = callback(Object.freeze({ id: operation.id, revision: operation.revision, ...(operation.move ? { move: Object.freeze({ ...operation.move }) } : {}), key: operation.key })); }
    catch (failure) { result = Promise.reject(failure); }
    Promise.resolve(result).then(snapshot => {
      if (destroyed || request !== active) return;
      if (snapshot === false && operation.kind === 'resign') { request = null; pending = false; render(); }
      else if (snapshot) receive(snapshot);
    }).catch(failure => {
      if (destroyed || request !== active) return;
      pending = false;
      uncertain = true;
      error = typeof failure?.code === 'string' ? failure.code : typeof failure?.message === 'string' ? failure.message : 'NETWORK_ERROR';
      render();
      online.onError?.(failure);
    });
  }

  const operation = (kind, move) => ({ kind, id: session.getSnapshot().id, revision: session.getState().moves.length, move, key: online.operationId ? online.operationId() : (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Math.random())) });

  function onClick(event) {
    const powerTarget = event.target.closest?.('[data-gb-power]');
    if (powerTarget?.dataset?.gbPower && host.contains(powerTarget) && !destroyed && !host.ownerDocument?.hidden) {
      if (powerTarget.dataset.gbPower === 'refresh') {
        powers?.refresh({ notify: true });
        host.querySelector('[data-gb-power="refresh"]')?.focus({ preventScroll: true });
      }
      // Local practice intentionally does not wire rewarded requests or application.
      return;
    }
    const target = event.target.closest?.('[data-gb-cell], [data-gb-action], [data-gb-guided]');
    if (!target || !host.contains(target) || destroyed || host.ownerDocument?.hidden) return;

    if (target.dataset.gbGuided && tutorialController) {
      const action = target.dataset.gbGuided;
      if (action === 'continue') {
        const transition = tutorialController.advance('continue', session.getState());
        if (transition.move) {
          const before = session.getState();
          session.move(transition.move);
          tutorialController.onPlayerMove(before, transition.move, session.getState());
          saveGuided();
          const view = tutorialController.getView(session.getState());
          if (view?.text) compat?.speakNarration?.(view.text, { enabled: view.narrationEnabled, volume: view.volume });
          render();
        } else if (transition.completed) {
          mode = 'bot';
          difficulty = 'Beginner';
          saveGuided();
          const view = tutorialController.getView(session.getState());
          if (view?.text) compat?.speakNarration?.(view.text, { enabled: view.narrationEnabled, volume: view.volume });
          render();
        } else {
          const view = tutorialController.getView(session.getState());
          if (view?.text) compat?.speakNarration?.(view.text, { enabled: view.narrationEnabled, volume: view.volume });
          render();
        }
        return;
      }
      if (action === 'skip') {
        tutorialController.advance('skip', session.getState());
        mode = 'bot';
        difficulty = 'Beginner';
        saveGuided();
        render();
        scheduleBot();
        return;
      }
      if (action === 'hint') {
        const v = tutorialController.advance('hint', session.getState());
        if (v?.move) {
          focusedCell = `${v.move.b}:${v.move.c}`;
          render({ focusCell: true });
        }
        return;
      }
      if (action === 'replay') {
        tutorialController.advance('replay', session.getState());
        return;
      }
      if (action === 'restart') {
        tutorialController.advance('restart', session.getState());
        render();
        return;
      }
      if (action === 'restart-cancel') {
        tutorialController.advance('restart-cancel', session.getState());
        render();
        return;
      }
      if (action === 'restart-confirm') {
        cancelBot();
        session.reset({ fresh: true });
        difficulty = 'Beginner';
        beginMatch(null, true);
        tutorialController.start(session.getState());
        saveGuided();
        render();
        return;
      }
      if (action === 'voice') {
        tutorialController.advance('voice', session.getState());
        saveGuided();
        render();
        return;
      }
      if (action === 'hide') {
        tutorialController.advance('hide', session.getState());
        render();
        return;
      }
      return;
    }

    if (target.dataset.gbAction) {
      const action = target.dataset.gbAction;
      if (action === 'start-guided') {
        startGuided();
        return;
      }
      if (action === 'bot-recovery') {
        if (botRunner && botRecovery) {
          const recovered = botRunner.computeExplicitFallback(session.getState(), botRecovery.difficulty);
          botRecovery = null;
          if (recovered?.move) {
            session.move(recovered.move);
            if (botRunner.getState?.().practice) saveGuided();
            render();
          }
        }
        return;
      }
      if (action === 'share') {
        const url = new URL('/game', window.location.href);
        if (!online) { url.searchParams.set('mode', workspace ? selectedMode : mode); url.searchParams.set('difficulty', difficulty); url.searchParams.set('theme', theme); }
        const notice = message => { const toast = host.ownerDocument?.querySelector('#notification'); if (toast) { toast.textContent = message; toast.hidden = false; } };
        if (navigator.share) navigator.share({title:'Mega XOXO', text:'Your next big move.', url:url.href}).catch(failure => { if (failure?.name !== 'AbortError') notice('Sharing is unavailable. Copy the page address to invite a friend.'); });
        else if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url.href).then(()=>notice('Game link copied. Your current match stays private.'),()=>notice('Copy the page address to invite a friend.'));
        else notice('Copy the page address to invite a friend.');
        return;
      }
      if (online) {
        if (accountState.sessionStatus !== 'linked') return;
        if (action === 'retry' && uncertain && request && !['AUTH_REQUIRED', 'LINK_ACCOUNT_REQUIRED'].includes(error)) submit(request);
        else if (action === 'resign' && typeof online.onResign === 'function' && !pending && !uncertain && session.getSnapshot().status === 'PLAYING' && Object.values(session.getSnapshot().symbols).includes(online.actorId)) submit(operation('resign'));
        return;
      }
      reset({ fresh: action === 'fresh' || !preview });
      const next = session.legal()[0];
      if (next) {
        focusedCell = `${next.b}:${next.c}`;
        render({ focusCell: true });
      }
      return;
    }

    if ((workspace && !online && ['ranked','casual','friends'].includes(selectedMode)) || (online && (accountState.sessionStatus !== 'linked' || (accountState.profile?.id && accountState.profile.id !== online.actorId))) || isThinking() || pending || uncertain || error || target.getAttribute('aria-disabled') === 'true' || (online && !session.canPlay())) return;
    const [b, c] = target.dataset.gbCell.split(':').map(Number);
    if (!session.legal().some(m => m.b === b && m.c === c)) return;

    if (tutorialController?.isActive()) {
      if (!tutorialController.allowsMove(session.getState(), { b, c })) {
        const view = tutorialController.getView(session.getState());
        if (view?.hint) {
          const toast = host.ownerDocument?.querySelector('#notification');
          if (toast) {
            toast.textContent = view.hint;
            toast.hidden = false;
            setTimeout(() => { toast.hidden = true; }, 3500);
          }
        }
        if (view?.move) {
          focusedCell = `${view.move.b}:${view.move.c}`;
          render({ focusCell: true });
        }
        return;
      }
      focusedCell = `${b}:${c}`;
      const before = session.getState();
      session.move({ b, c });
      tutorialController.onPlayerMove(before, { b, c }, session.getState());
      saveGuided();
      const view = tutorialController.getView(session.getState());
      if (view?.text) compat?.speakNarration?.(view.text, { enabled: view.narrationEnabled, volume: view.volume });
      render({ focusCell: true });
      return;
    }

    focusedCell = `${b}:${c}`;
    if (online) { submit(operation('move', { b, c })); return; }
    session.move({ b, c });
    if (botRunner?.getState?.().practice) saveGuided();
    render({ focusCell: true });
    scheduleBot();
  }

  function onKeydown(event) {
    const target = event.target.closest?.('[data-gb-cell]');
    if (!target || !host.contains(target) || destroyed) return;
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
      const stage = host.querySelector('[data-gb-stage]');
      if (stage) stage.dataset.gbTheme = theme;
      return;
    }
    if (online) return;
    // The lesson owns bot mode and Beginner until its explicit skip/handoff.
    // Ignore synthetic change events as well as disabling the controls in the DOM.
    if (tutorialController?.isActive() || tutorialController?.isConfirmRestart()) {
      if (setting === 'mode' || setting === 'difficulty') render({ setting });
      return;
    }
    cancelBot();
    if (setting === 'mode') mode = event.target.value === 'local' ? 'local' : 'bot';
    if (setting === 'difficulty' && game.LEVELS.includes(event.target.value)) difficulty = event.target.value;
    render({ setting });
    scheduleBot();
  }

  function onInput(event) {
    if (event.target.dataset?.gbGuided === 'volume' && tutorialController) {
      tutorialController.advance('volume', session.getState(), { volume: event.target.value });
      saveGuided();
    }
  }

  const onVisibility = () => {
    if (destroyed) return;
    if (host.ownerDocument?.hidden) {
      cancelBot();
      compat?.stopNarration?.();
    } else {
      render();
      scheduleBot();
    }
  };
  host.ownerDocument?.addEventListener?.('visibilitychange', onVisibility);

  host.addEventListener('click', onClick);
  if (guidedStart && !host.contains(guidedStart)) guidedStart.addEventListener('click', startGuided);
  host.addEventListener('keydown', onKeydown);
  host.addEventListener('change', onChange);
  host.addEventListener('input', onInput);
  render();
  scheduleBot();

  return {
    reset,
    receive,
    updateAccount(next = {}) {
      const before = accountState.sessionStatus, previousMode = selectedMode;
      accountState = {...accountState, ...next};
      if (['bot','local','ranked','casual','friends'].includes(next.mode)) selectedMode = next.mode;
      const picker = host.querySelector('[data-game-mode]');
      if (picker) picker.value = selectedMode;
      if ((online && before !== accountState.sessionStatus) || previousMode !== selectedMode) render();
      return {...accountState};
    },
    getState: session.getState,
    getTutorialSnapshot: () => tutorialController?.getSnapshot() || null,
    getBotState: () => botRunner?.getState?.() || null,
    startGuided,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelBot();
      botRunner?.destroy();
      powers?.destroy();
      tutorialController?.stop();
      compat?.stopNarration?.();
      host.ownerDocument?.removeEventListener?.('visibilitychange', onVisibility);
      host.removeEventListener('click', onClick);
      guidedStart?.removeEventListener('click', startGuided);
      host.removeEventListener('keydown', onKeydown);
      host.removeEventListener('change', onChange);
      host.removeEventListener('input', onInput);
    },
  };
}
