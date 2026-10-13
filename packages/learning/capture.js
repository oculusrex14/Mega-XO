'use strict';
/* Private server-authoritative trajectories. Never import this module into a client bundle.
 * The operational state can carry an adjudicated winner; canonical replay, not that field,
 * determines whether terminal-board value supervision is justified. No search labels are made. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const G = require('../../src/game.js');
const E = require('../../src/bot/encoding.js');
const FORMAT = 'game-capture/v1';
const RULES_HASH = crypto.createHash('sha256').update(fs.readFileSync(require.resolve('../../src/game.js'))).digest('hex');
const MAX_BYTES = 64 * 1024;
const fail = code => { const e = new Error(code); e.code = code; throw e; };
const integer = (n, lo = 0, hi = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(n) && n >= lo && n <= hi;
const hex = n => typeof n === 'string' && /^[a-f0-9]{64}$/.test(n);
function stable(value) {
 if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
 if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
 if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
 if (value && Object.getPrototypeOf(value) === Object.prototype) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
 fail('CAPTURE_NON_JSON');
}
const sha256 = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
function object(value, keys, code) {
 if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(value, k))) fail(code);
}
function text(v, max) { return typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v); }
function time(v) { return v === null || integer(v, 0, 8640000000000000); }
function replay(moves, first = 'X') {
 if (!Array.isArray(moves) || moves.length > 81 || !['X','O'].includes(first)) fail('CAPTURE_MOVES_SHAPE');
 let state = G.create(first);
 for (const m of moves) {
  object(m, ['b','c','player'], 'CAPTURE_MOVE_SHAPE');
  if (m.player !== state.turn || !integer(m.b,0,8) || !integer(m.c,0,8)) fail('CAPTURE_MOVE_TURN');
  try { state = G.apply(state, m); } catch { fail('CAPTURE_ILLEGAL_MOVE'); }
 }
 return state;
}
function board(state) { return {board: state.board, mini: state.mini, turn: state.turn, required: state.required, winner: state.winner, line: state.line}; }
const SOURCE_KEYS = ['kind','id','attempt','revision','status','settled','mode','rated','clockSeconds','incrementSeconds','players','symbols','moves','state','timings','winnerActor','reason','startedAt','endedAt','lastMoveAt','riskFlags','historyOnly'];
/* source is the allowlisted DB projection, never an HTTP request. provenance is trusted deployment
 * metadata; population defaults to unknown unless explicitly classified in the private registry. */
function seal(source, {sourceCommit, environment, population = 'unknown'} = {}) {
 object(source, SOURCE_KEYS, 'CAPTURE_SOURCE_SHAPE');
 if (!/^[a-f0-9]{40}$/.test(sourceCommit || '') || !['test','staging','production'].includes(environment) || !['human-v-human','server-bot','test-fixture','unknown'].includes(population)) fail('CAPTURE_PROVENANCE');
 if (!['match','fixture'].includes(source.kind) || !text(source.id,400) || !integer(source.attempt,0,10000) || !integer(source.revision,0,81)) fail('CAPTURE_SOURCE_ID');
 if (!['FINISHED','VOID'].includes(source.status) || source.settled !== true || !['line','draw','resign','timeout','no-show','void'].includes(source.reason) || (source.status === 'VOID') !== (source.reason === 'void')) fail('CAPTURE_NOT_TERMINAL');
 if (!Array.isArray(source.players) || source.players.length !== 2 || !source.players.every(p => text(p,160)) || source.players[0] === source.players[1]) fail('CAPTURE_PARTICIPANTS');
 object(source.symbols, ['X','O'], 'CAPTURE_SYMBOLS');
 if (new Set(Object.values(source.symbols)).size !== 2 || !Object.values(source.symbols).every(p => source.players.includes(p))) fail('CAPTURE_SYMBOLS');
 if (!['ranked','casual','direct-rated','direct-unrated','tournament'].includes(source.mode) || typeof source.rated !== 'boolean' || !integer(source.clockSeconds,0,86400) || !integer(source.incrementSeconds,0,3600) || typeof source.historyOnly !== 'boolean') fail('CAPTURE_MODE');
 if (source.kind === 'match' && (source.historyOnly || source.mode === 'tournament' || source.attempt !== 0)) fail('CAPTURE_SOURCE_KIND');
 if (source.kind === 'fixture' && (source.mode !== 'tournament' || source.attempt < 1)) fail('CAPTURE_SOURCE_KIND');
 const state = replay(source.moves); // Both current authoritative online sources always start X.
 if (source.moves.length !== source.revision) fail('CAPTURE_REVISION');
 if (source.winnerActor !== null && !source.players.includes(source.winnerActor)) fail('CAPTURE_RESULT_ACTOR');
 const adjudicated = source.winnerActor === null ? null : source.symbols.X === source.winnerActor ? 'X' : 'O';
 if (source.reason === 'line' && (!['X','O'].includes(state.winner) || adjudicated !== state.winner)) fail('CAPTURE_LINE_RESULT');
 if (source.reason === 'draw' && (state.winner !== 'DRAW' || adjudicated !== null)) fail('CAPTURE_DRAW_RESULT');
 if (['resign','timeout','no-show'].includes(source.reason) && (state.winner !== null || adjudicated === null)) fail('CAPTURE_ADJUDICATION');
 if (source.reason === 'timeout' && (source.clockSeconds === 0 || adjudicated === state.turn)) fail('CAPTURE_TIMEOUT');
 if (source.reason === 'no-show' && source.moves.length) fail('CAPTURE_NO_SHOW');
 if (source.reason === 'void' && adjudicated !== null) fail('CAPTURE_VOID');
 if (!source.historyOnly) {
  object(source.state, ['board','mini','turn','required','winner','line','moves'], 'CAPTURE_STATE_SHAPE');
  const expected = structuredClone(state);
  if (source.kind === 'match' && ['resign','timeout','no-show'].includes(source.reason)) expected.winner = adjudicated;
  if (stable(source.state) !== stable(expected)) fail('CAPTURE_STATE_MISMATCH');
 } else if (source.state !== null) fail('CAPTURE_HISTORY_STATE');
 if (![source.startedAt,source.endedAt,source.lastMoveAt].every(time)) fail('CAPTURE_TIME');
 if (source.startedAt !== null && source.endedAt !== null && source.endedAt < source.startedAt) fail('CAPTURE_TIME_ORDER');
 if (source.lastMoveAt !== null && ((source.startedAt !== null && source.lastMoveAt < source.startedAt) || (source.endedAt !== null && source.lastMoveAt > source.endedAt))) fail('CAPTURE_TIME_ORDER');
 if (!Array.isArray(source.riskFlags) || source.riskFlags.length > 64 || !source.riskFlags.every(f => typeof f === 'string' && /^[A-Z0-9_]{1,80}$/.test(f))) fail('CAPTURE_RISK_FLAGS');
 const flags = [];
 if (source.timings === null) flags.push('TIMINGS_UNAVAILABLE');
 else {
  if (!Array.isArray(source.timings) || source.timings.length !== source.moves.length) fail('CAPTURE_TIMING_COUNT');
  for (let i=0; i<source.timings.length; i++) {
   const t = source.timings[i]; object(t, ['actor','ms'], 'CAPTURE_TIMING_SHAPE');
   if (t.actor !== source.symbols[source.moves[i].player] || !integer(t.ms)) fail('CAPTURE_TIMING_ACTOR');
  }
 }
 if (source.historyOnly) flags.push('HISTORY_ONLY');
 if (source.startedAt === null || source.endedAt === null) flags.push('SOURCE_TIME_UNKNOWN');
 if (source.riskFlags.length) flags.push('SOURCE_RISK_FLAGGED');
 if (population === 'unknown') flags.push('POPULATION_UNCLASSIFIED');
 if (source.reason === 'no-show') flags.push('NO_PLAYED_GAME');
 const payload = {
  format: FORMAT,
  source: {kind:source.kind,id:source.id,attempt:source.attempt,revision:source.revision,sha256:sha256(source)},
  rules: {id:'ultimate-3x3x3-v1',sha256:RULES_HASH,actionIndex:'b*9+c'},
  provenance: {sourceCommit,environment,population,verification:'server-authoritative'},
  game: {mode:source.mode,rated:source.rated,clockSeconds:source.clockSeconds,incrementSeconds:source.incrementSeconds,firstSymbol:'X',
   seatSymbols: source.players.map(p => p === source.symbols.X ? 'X' : 'O'), status:source.status,reason:source.reason,
   startedAt:source.startedAt,endedAt:source.endedAt,boardWinner:state.winner,adjudicatedWinner:adjudicated},
  moves: source.moves.map((m,ply) => ({ply,b:m.b,c:m.c,symbol:m.player,action:m.b*9+m.c,thinkMs:source.timings === null ? null : source.timings[ply].ms})),
  final: board(state), qualityFlags:flags,
 };
 if (Buffer.byteLength(stable(payload)) > MAX_BYTES) fail('CAPTURE_TOO_LARGE');
 validate(payload);
 return {payload,sha256:sha256(payload),subjects:source.players.map((actorId,seat) => ({actorId,seat,symbol:payload.game.seatSymbols[seat]}))};
}
/* Revalidation is deliberately usable without the private actor lookup or original DB. */
function validate(p, expectedHash) {
 object(p,['format','source','rules','provenance','game','moves','final','qualityFlags'],'CAPTURE_SHAPE');
 if (Buffer.byteLength(stable(p)) > MAX_BYTES || p.format !== FORMAT) fail('CAPTURE_FORMAT');
 if (expectedHash !== undefined && (!hex(expectedHash) || sha256(p) !== expectedHash)) fail('CAPTURE_HASH');
 object(p.source,['kind','id','attempt','revision','sha256'],'CAPTURE_SOURCE_SHAPE');
 if (!['match','fixture'].includes(p.source.kind) || !text(p.source.id,400) || !integer(p.source.attempt,0,10000) || !integer(p.source.revision,0,81) || !hex(p.source.sha256)) fail('CAPTURE_SOURCE_ID');
 object(p.rules,['id','sha256','actionIndex'],'CAPTURE_RULES');
 if (p.rules.id !== 'ultimate-3x3x3-v1' || p.rules.sha256 !== RULES_HASH || p.rules.actionIndex !== 'b*9+c') fail('CAPTURE_RULES');
 object(p.provenance,['sourceCommit','environment','population','verification'],'CAPTURE_PROVENANCE');
 if (!/^[a-f0-9]{40}$/.test(p.provenance.sourceCommit) || !['test','staging','production'].includes(p.provenance.environment) || !['human-v-human','server-bot','test-fixture','unknown'].includes(p.provenance.population) || p.provenance.verification !== 'server-authoritative') fail('CAPTURE_PROVENANCE');
 object(p.game,['mode','rated','clockSeconds','incrementSeconds','firstSymbol','seatSymbols','status','reason','startedAt','endedAt','boardWinner','adjudicatedWinner'],'CAPTURE_GAME');
 const game = p.game;
 if (game.firstSymbol !== 'X' || !['ranked','casual','direct-rated','direct-unrated','tournament'].includes(game.mode) || typeof game.rated !== 'boolean' || !integer(game.clockSeconds,0,86400) || !integer(game.incrementSeconds,0,3600) || !Array.isArray(game.seatSymbols) || [...game.seatSymbols].sort().join(',') !== 'O,X' || ![game.startedAt,game.endedAt].every(time)) fail('CAPTURE_GAME');
 if (game.startedAt !== null && game.endedAt !== null && game.endedAt < game.startedAt) fail('CAPTURE_TIME_ORDER');
 if (!Array.isArray(p.qualityFlags) || p.qualityFlags.some(f => !['TIMINGS_UNAVAILABLE','HISTORY_ONLY','SOURCE_TIME_UNKNOWN','SOURCE_RISK_FLAGGED','POPULATION_UNCLASSIFIED','NO_PLAYED_GAME'].includes(f)) || new Set(p.qualityFlags).size !== p.qualityFlags.length) fail('CAPTURE_FLAGS');
 if (!Array.isArray(p.moves) || p.moves.length > 81 || p.source.revision !== p.moves.length) fail('CAPTURE_REVISION');
 const moves = p.moves.map((m,i) => {
  object(m,['ply','b','c','symbol','action','thinkMs'],'CAPTURE_MOVE_SHAPE');
  if (m.ply !== i || m.action !== m.b*9+m.c || (m.thinkMs !== null && !integer(m.thinkMs))) fail('CAPTURE_MOVE_FIELDS');
  return {b:m.b,c:m.c,player:m.symbol};
 });
 const s = replay(moves,game.firstSymbol);
 if (stable(board(s)) !== stable(p.final) || game.boardWinner !== s.winner) fail('CAPTURE_FINAL');
 if (!['FINISHED','VOID'].includes(game.status) || !['line','draw','resign','timeout','no-show','void'].includes(game.reason) || (game.status === 'VOID') !== (game.reason === 'void')) fail('CAPTURE_NOT_TERMINAL');
 if (!['X','O',null].includes(game.adjudicatedWinner)) fail('CAPTURE_RESULT_ACTOR');
 if (game.reason === 'line' && (!['X','O'].includes(s.winner) || game.adjudicatedWinner !== s.winner)) fail('CAPTURE_LINE_RESULT');
 if (game.reason === 'draw' && (s.winner !== 'DRAW' || game.adjudicatedWinner !== null)) fail('CAPTURE_DRAW_RESULT');
 if (['resign','timeout','no-show'].includes(game.reason) && (s.winner !== null || game.adjudicatedWinner === null)) fail('CAPTURE_ADJUDICATION');
 if (game.reason === 'timeout' && (game.clockSeconds === 0 || game.adjudicatedWinner === s.turn)) fail('CAPTURE_TIMEOUT');
 if (game.reason === 'no-show' && p.moves.length) fail('CAPTURE_NO_SHOW');
 if (game.reason === 'void' && game.adjudicatedWinner !== null) fail('CAPTURE_VOID');
 return {plies:moves.length,boardWinner:s.winner,terminalValueEligible:['line','draw'].includes(game.reason)};
}
function *positions(p) {
 const verdict = validate(p); let state = G.create(p.game.firstSymbol);
 for (const m of p.moves) {
  const e = E.encode(state);
  yield {ply:m.ply,player:state.turn,state:structuredClone(state),planes:[...e.planes],legalMask:[...e.mask],playedMove:{b:m.b,c:m.c},
   observedAction:m.action,policyTargetSource:'observed-player-action',searchPolicy:null,
   valueTarget:verdict.terminalValueEligible ? E.value(p.game.boardWinner,state.turn) : null,
   valueTargetSource:verdict.terminalValueEligible ? 'terminal-board-outcome' : 'unlabelled-adjudication',
   thinkMs:m.thinkMs};
  state = G.apply(state,{b:m.b,c:m.c});
 }
}
module.exports = {FORMAT,RULES_HASH,MAX_BYTES,stable,sha256,seal,validate,replay,positions,board};
