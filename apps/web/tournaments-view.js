import {escapeHtml, button} from './ui.js';
import {errorCopy} from './data.js';
import {tournamentFixture} from './tournaments.js';

const tournamentCount = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('en-US') : '—';
const tournamentError = code => ({
 INELIGIBLE:'This table requires an eligible account with completed placements.',
 INSUFFICIENT_COINS:'Your Coins balance does not cover this table’s entry.',
 INSUFFICIENT_CROWNS:'Your Crowns balance does not cover this table’s entry.',
 ALREADY_QUEUED:'You already have a tournament seat. Return to your existing lobby.',
 ALREADY_IN_MATCH:'Finish your active match before joining a table.',
 ROOM_FULL:'This table is full. Refresh the list and choose a table again.',
 ROOM_NOT_FOUND:'This tournament is no longer available.',
 NOT_IN_ROOM:'This account does not have a seat in that tournament.',
 RULES_CHANGED:'The lobby rules changed. Review the latest entry and ready again.',
 MATCH_NOT_READY:'The fixture is not ready yet. Refresh for its current status.',
 ACCOUNT_HELD:'Your account cannot join this table right now.',
 REQUEST_PENDING:'Confirm the previous request before sending another action.',
 INVALID_TOURNAMENT_RESPONSE:'This tournament could not be updated. Refresh and try again.',
})[code] || errorCopy(Error(code));
const tournamentAction = (label,action,extra = '',disabled = false,kind = 'secondary') => `<button type="button" class="mx-button ${kind}" data-tournament-action="${action}" ${extra}${disabled ? ' disabled' : ''}>${escapeHtml(label)}</button>`;
const currencyName = value => ({coins:'Coins',crowns:'Crowns'})[value] || '—';
const roomStatus = value => ({LOBBY:'Lobby open',RUNNING:'In progress',COMPLETE:'Complete',VOID:'Voided',CANCELLED:'Cancelled',REVIEW:'Under review',PAUSED:'Paused'})[value] || '';

/** Only server quotes/room views enter this renderer. No local seat counts,
 * payouts, escrow approvals or results are presented as service outcomes. */
export function renderTournamentControls(context, {fixtureId} = {}) {
 const state = context.tournaments || {status:'idle',tables:[]};
 const linked = context.sessionStatus === 'linked' && Boolean(context.profile?.id);
 const confirming = context.sessionStatus === 'loading';
 const blocked = state.busy || confirming || state.uncertain;
 let html = `<div class="pg-section-title pg-tournament-controls-heading"><div><h2 id="tournament-live-title">Live tournaments</h2><p>Pick your table. Meet your next rivals.</p></div>${state.uncertain ? '' : tournamentAction('Refresh tables','refresh','',state.busy || confirming)}</div>`;
 if (confirming) html += '<p class="pg-tournament-message" role="status">Confirming your account…</p>';
 else if (!linked) html += `<div class="pg-tournament-signin"><p>Browse the entries, then sign in to take a seat.</p>${button('Sign in to join a tournament','/account','primary','user')}</div>`;
 if (state.status === 'loading' && !state.tables.length) html += '<p class="pg-tournament-message" role="status">Loading available tables…</p>';
 if (state.errorCode) html += `<p class="pg-tournament-message" role="status">${escapeHtml(tournamentError(state.errorCode))}</p>`;
 if (state.message) html += `<p class="pg-tournament-message" role="status">${escapeHtml(state.message)}</p>`;
 if (state.uncertain) html += `<div class="pg-tournament-pending"><p>Your previous request is awaiting confirmation. Check it before choosing another action.</p>${tournamentAction('Confirm previous request','retry','',state.busy || confirming)}</div>`;
 if (state.status === 'ready' && !state.available) html += '<p class="pg-tournament-message">Online tournaments are unavailable right now. Please try again later.</p>';
 const room = linked ? state.room : null;
 if (!room) {
  html += '<div class="pg-tournament-catalog">' + (state.tables || []).map(table => '<article class="pg-panel pg-tournament-table pg-tournament-live-card' + (table.currency === 'crowns' ? ' pg-premium' : '') + '"><span class="mx-chip">' + tournamentCount(table.seats) + ' players · ' + currencyName(table.currency) + '</span><h3>' + escapeHtml(table.name) + ' table</h3><p class="pg-tournament-entry"><strong>' + tournamentCount(table.entry) + '</strong><span>' + currencyName(table.currency) + ' entry</span></p><dl class="pg-tournament-metrics"><div><dt>Total pool</dt><dd>' + tournamentCount(table.pool) + ' ' + currencyName(table.currency) + '</dd></div><div><dt>First place</dt><dd>' + tournamentCount(table.payouts?.[0]) + ' ' + currencyName(table.currency) + '</dd></div></dl><ol class="pg-payouts pg-tournament-payouts">' + (table.payouts || []).slice(0, 5).map((amount, index) => '<li><span>' + (index + 1) + ['st','nd','rd','th','th'][index] + ' place</span><strong>' + tournamentCount(amount) + '</strong></li>').join('') + '</ol><p class="pg-small mx-muted">10% of the original pool is retired. Places 6–10 receive no payout.</p>' + (linked ? tournamentAction('Join game', 'join', 'data-table="' + escapeHtml(table.table) + '" aria-label="Join the ' + escapeHtml(table.name) + ' tournament table"', blocked || !state.available, 'primary') : '') + '</article>').join('') + '</div>';
  return html + '<p class="pg-tournament-footnote">Choose an entry that fits your balance. Coins and Crowns are virtual currency with no cash-out.</p>';
 }
 const playerName = id => room.players.find(player => player.id === id)?.name || 'Player';
 const mine = room.players.find(player => player.id === context.profile.id);
  /* F2: the server-projected members carry the honest rank visibility; the friend action
  * goes straight to the existing /api/community/friend endpoint with one operation key and
  * lets the API decide permissions - the roster button never bypasses a controller. */
  const memberOf = id => (room.members || []).find(member => member.id === id) || null;
  const rankText = member => {
   if (!member) return 'Rank unavailable';
   if (member.statsVisible && member.tier) return member.tier.charAt(0).toUpperCase() + member.tier.slice(1) + ' · ' + Math.round(member.rating || 0);
   return 'Rank unavailable';
  };
 let center = `<div class="pg-tournament-room-heading"><div><h3>${escapeHtml(room.name || 'Your tournament')}</h3><p>${tournamentCount(room.players.length)} / ${tournamentCount(room.capacity)} players</p></div><span class="mx-chip">${roomStatus(room.status)}</span></div>`;
 if (room.status === 'LOBBY') {
  center += `<div class="pg-tournament-lobby"><section class="pg-tournament-roster"><h4>Players at your table</h4><ul>${room.players.map(player => `<li><strong>${escapeHtml(player.name)}${player.id === context.profile.id ? ' (you)' : ''}</strong><small>${(() => { const m = memberOf(player.id); return m && m.statsVisible && m.tier ? m.tier.charAt(0).toUpperCase() + m.tier.slice(1) + ' · ' + m.rating.toFixed(0) : m && m.id === context.profile.id ? 'Rank unavailable' : ''; })()}</small><span class="${player.ready ? 'pg-tournament-ready' : ''}">${player.ready ? 'Ready' : 'Not ready'}</span></li>`).join('')}</ul></section><section class="pg-tournament-entry-terms"><h4>Your entry</h4>`;
  if (room.quote) center += `<p class="pg-tournament-entry"><strong>${tournamentCount(room.quote.entry)}</strong><span>${currencyName(room.quote.currency)}</span></p><p>Entries are reserved together only when all ten players are ready. Your readiness approves this entry.</p><details class="pg-tournament-terms"><summary>Review payouts and entry terms</summary><ol>${room.quote.payouts.map((amount,index) => `<li><span>Place ${index+1}</span><strong>${tournamentCount(amount)} ${currencyName(room.quote.currency)}</strong></li>`).join('')}</ol><p>Pool ${tournamentCount(room.quote.pool)} ${currencyName(room.quote.currency)}. Retired from the pool ${tournamentCount(room.quote.burn)} ${currencyName(room.quote.currency)}. No rebuys or extra per-game fees. Once the event starts, entries stay reserved until it ends. Voided or cancelled events refund their entries.</p></details>`;
  center += `<div class="pg-actions">${tournamentAction(mine?.ready ? 'Withdraw readiness' : 'Ready — approve entry','ready','',blocked,'primary')}${tournamentAction('Leave lobby','leave','',blocked)}</div></section></div>`;
 } else if (room.status === 'COMPLETE') {
  center += `<h3>Final standings</h3><ol class="pg-tournament-standings">${(room.ranking || []).map((id,index) => `<li><strong>${escapeHtml(playerName(id))}</strong>${room.quote ? '<span>'+tournamentCount(room.quote.payouts[index])+' '+currencyName(room.quote.currency)+'</span>' : ''}</li>`).join('')}</ol>`;
 } else if (['VOID','CANCELLED','REVIEW','PAUSED'].includes(room.status)) {
  center += `<p class="pg-tournament-message">${escapeHtml({VOID:'Tournament voided.',CANCELLED:'Tournament cancelled.',REVIEW:'Tournament settlement is under review.',PAUSED:'Tournament paused.'}[room.status])}${room.receipt?.refunded === true ? ' Your entry has been refunded.' : ''}</p>`;
 }
 const fixture = tournamentFixture(room,context.profile.id,fixtureId);
  /* F1: the room workspace - Players left, your match center, other games right; the columns
  * stack with the match first on narrow screens. Spectating reuses the member-authorized room
  * view payload only; a Watch button navigates to the same room route with the fixture id. */
  const rosterRows = room.players.map(player => {
   const member = memberOf(player.id);
   const you = player.id === context.profile.id;
   const friend = !you && member && member.tag ? '<button type="button" class="pg-text-button" data-friend-request="' + escapeHtml(player.id) + '">Add friend</button>' : '<span class="mx-muted">—</span>';
   return '<tr><td>' + escapeHtml(player.name) + (you ? ' <span class="mx-muted">(you)</span>' : '') + '</td><td>' + escapeHtml(rankText(member)) + '</td><td>' + (player.ready ? 'Ready' : 'Waiting') + '</td><td>' + friend + '</td></tr>';
  }).join('');
  const rosterCol = '<section class="pg-tournament-col pg-tournament-players" aria-labelledby="tournament-players-title"><h3 id="tournament-players-title">Players</h3><div class="pg-table-wrap"><table class="pg-table pg-tournament-roster-table"><thead><tr><th scope="col">Player</th><th scope="col">Rank</th><th scope="col">Status</th><th scope="col">Friend</th></tr></thead><tbody>' + rosterRows + '</tbody></table></div></section>';
  const otherFixtures = (room.fixtures || []).filter(entry => Array.isArray(entry.players) && !entry.players.includes(context.profile.id));
  const othersRows = otherFixtures.map(entry => {
   const label = playerName(entry.players[0]) + ' vs ' + playerName(entry.players[1]);
   const control = entry.status === 'PLAYING' ? '<button type="button" class="mx-button secondary" data-tournament-action="watch" data-fixture="' + escapeHtml(entry.id) + '">Watch</button>' : entry.status === 'DONE' ? '<button type="button" class="mx-button secondary" data-tournament-action="watch" data-fixture="' + escapeHtml(entry.id) + '">View result</button>' : '<span class="mx-muted">' + escapeHtml(entry.status.toLowerCase()) + '</span>';
   return '<div class="pg-tournament-other"><span>' + escapeHtml(label) + '</span>' + control + '</div>';
  }).join('');
  const othersCol = '<section class="pg-tournament-col pg-tournament-others" aria-labelledby="tournament-others-title"><h3 id="tournament-others-title">Other games</h3>' + (othersRows || '<p class="mx-muted">No other games in the current round.</p>') + '</section>';
  html += '<div class="pg-tournament-workspace">' + rosterCol + '<div class="pg-tournament-col pg-tournament-center">' + center + '</div>' + othersCol + '</div>';
 if (fixture) {
  center += `<section class="pg-tournament-fixture"><span class="mx-eyebrow">${fixture.status === 'DONE' ? 'MATCH RESULT' : 'YOUR NEXT MATCH'}</span><h3>${escapeHtml(fixture.label || 'Your match')}</h3><p><strong>${escapeHtml(playerName(fixture.players[0]))}</strong> vs <strong>${escapeHtml(playerName(fixture.players[1]))}</strong> · ${escapeHtml(fixture.status.toLowerCase())}</p>`;
  if (room.status === 'RUNNING' && fixture.status === 'READY') {
   const waiting = Number(room.serverNow) < Number(fixture.opens), ready = fixture.ready?.includes(context.profile.id);
   center += `<p>${waiting ? 'Your match opens in '+Math.ceil((Number(fixture.opens)-Number(room.serverNow))/1000)+' seconds.' : ready ? 'You are ready. Waiting for your opponent.' : 'Your next match is ready. Confirm when you are ready to play.'}</p><div class="pg-actions">${tournamentAction(ready ? 'Waiting for opponent' : waiting ? 'Round countdown' : 'Ready to play','match-ready',`data-fixture="${escapeHtml(fixture.id)}"`,blocked || waiting || ready,'primary')}`;
  } else html += '<div class="pg-actions">';
  if (['READY','PLAYING'].includes(fixture.status)) html += tournamentAction('Open tournament game','open',`data-fixture="${escapeHtml(fixture.id)}"`,state.busy);
  center += '</div></section>';
 } else if (room.status === 'RUNNING') html += '<p class="pg-tournament-message">Your next match has not opened yet. Refresh to check the current schedule.</p>';
 html += '<p class="pg-tournament-footnote">Tournament results do not change your Ranked rating. Your match clock keeps running if you lose your connection.</p>';
 return html;
}
