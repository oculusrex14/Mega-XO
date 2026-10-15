import {icon, escapeHtml as e, button, pageHeading} from './ui.js';
import {FRIENDS_PAGE_SIZE} from './friends.js';

const panel = (content, className = '') => `<section class="mx-panel pg-panel ${className}">${content}</section>`;
const linked = context => context.sessionStatus === 'linked' || (!context.sessionStatus && Boolean(context.profile));
const nameOf = player => player?.name || player?.displayName || player?.username || 'Player';
const countLabel = (count, partial) => `${count}${partial ? '+' : ''}`;

/** Render only the active actor's protected projection. Pagination is a view, not a new data authority. */
export function renderFriendsPage(context = {}) {
 const profile = linked(context) ? context.profile : null;
 const state = profile?.id && context.friends?.actorId === profile.id ? context.friends : null;
 const busy = state?.busy === true || ['loading','refreshing'].includes(state?.status);
 const disabled = busy ? ' disabled' : '';
 const action = (label, command, player, kind = 'secondary') => `<button class="mx-button ${kind}" type="button" data-friend-action="${e(command)}" data-friend-target="${e(player.id)}" aria-label="${e(label)} ${e(nameOf(player))}"${disabled}>${e(label)}</button>`;
 const row = (player, group) => {
  const presence = ({online:'Online', 'in-match':'In a match', queued:'In a queue', 'in-lobby':'In a lobby', away:'Away', offline:'Offline'})[player.presence?.state] || 'Presence hidden';
  let controls = '';
  if (group === 'incoming') controls = action('Accept request', 'accept', player, 'primary') + action('Decline request', 'decline', player);
  else if (group === 'outgoing') controls = action('Cancel request', 'cancel', player);
  else if (group === 'blocked') controls = action('Unblock', 'unblock', player);
  else if (group === 'friends') controls = `<details class="pg-friend-manage"><summary>Manage friendship</summary><div class="pg-actions">${action('Remove friend', 'confirm-remove', player)}${action('Block player', 'confirm-block', player)}</div></details>`;
  else if (player.relation === 'friend') controls = '<span class="mx-chip">Friends</span>';
  else if (player.relation === 'incoming') controls = action('Accept request', 'accept', player, 'primary') + action('Decline request', 'decline', player);
  else if (player.relation === 'outgoing') controls = action('Cancel request', 'cancel', player);
  else controls = action('Add friend', 'request', player, 'primary');
  return `<li class="pg-friend-row" data-friend-row="${e(group)}"><span class="pg-friend-avatar" aria-hidden="true">${icon('user')}</span><div class="pg-friend-identity"><strong>${e(nameOf(player))}</strong><span>@${e(player.username)}${player.tag ? ` <span class="pg-friend-tag">${e(player.tag)}</span>` : ''}</span>${group !== 'blocked' ? `<small class="pg-friend-presence${player.presence?.online ? ' is-online' : ''}">${e(presence)}</small>` : ''}</div><div class="pg-friend-actions">${controls}</div></li>`;
 };
 const requestList = (id, title, group, emptyCopy) => `<details class="pg-friend-requests" id="${id}"><summary><span>${title}</span><span class="pg-friend-count">${countLabel(state?.[group]?.length || 0, state?.truncated)}</span></summary><div class="pg-friend-request-content">${state?.[group]?.length ? `<ul class="pg-friend-list" aria-label="${title}">${state[group].map(player => row(player, group)).join('')}</ul>` : `<p class="mx-muted">${emptyCopy}</p>`}</div></details>`;

 let contents;
 if (context.sessionStatus === 'error') {
  // Carried over from PR #15: a failed account check must show the real error and a Retry action,
  // never the guest sign-in prompt. PR #16 moved this renderer into its own module, so the fix is
  // applied here rather than to the inline body it replaced.
  contents = `<h2>Your account could not be checked.</h2><p role="status" tabindex="-1" data-friends-status>${e(context.accountMessage || 'Try checking your account again.')}</p><button class="mx-button secondary" type="button" data-account-action="retry">Retry account check</button>`;
 } else if (!profile) {
  contents = context.sessionStatus === 'loading' ? '<p role="status">Checking your account…</p>' : `<div class="pg-signin"><span class="pg-row-icon">${icon('user')}</span><div><strong>Sign in to play online</strong><p>Find friends, manage requests and keep your people close.</p></div>${button('Open account', '/account', 'primary', 'arrow-right')}</div>`;
 } else if (!state || ['idle','loading','refreshing'].includes(state.status)) {
  contents = '<p role="status" tabindex="-1" data-friends-status>Checking your friends and requests…</p>';
 } else if (['error','refresh-error'].includes(state.status)) {
  contents = `<h2>Friends need a connection.</h2><p role="status" tabindex="-1" data-friends-status>${e(state.message)}</p><button class="mx-button secondary" type="button" data-friend-action="refresh">Try again</button>`;
 } else {
  const confirmation = context.friendConfirmation;
  const confirmationHTML = confirmation?.actorId === profile.id ? `<div class="pg-friend-confirm" role="group" aria-labelledby="friend-confirm-title"><h3 id="friend-confirm-title">${confirmation.action === 'block' ? 'Block' : 'Remove'} ${e(confirmation.name)}?</h3><p>${confirmation.action === 'block' ? 'This removes the friendship and prevents requests from this player. You can review blocked players below.' : 'This removes your friendship. You can send a new request later.'}</p><div class="pg-actions"><button class="mx-button secondary" type="button" data-friend-action="confirm"${disabled}>${confirmation.action === 'block' ? 'Block player' : 'Remove friend'}</button><button class="mx-button secondary" type="button" data-friend-action="dismiss-confirm"${disabled}>Keep friendship</button></div></div>` : '';
  const searchStatus = state.searchMessage || (state.searchStatus === 'loading' ? 'Finding players…' : '');
  const results = state.searchStatus === 'ready' ? `<section id="friend-search-results" aria-labelledby="friend-results-title"><h3 id="friend-results-title">Search results</h3>${state.results.length ? `<ul class="pg-friend-list">${state.results.map(player => row(player, 'search')).join('')}</ul>` : '<p class="mx-muted">No visible players match. Check the player tag or username.</p>'}</section>` : '';
  const total = state.friends.length;
  const pages = Math.max(1, Math.ceil(total / FRIENDS_PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Number.isSafeInteger(state.page) ? state.page : 1));
  const start = (page - 1) * FRIENDS_PAGE_SIZE;
  const visible = state.friends.slice(start, start + FRIENDS_PAGE_SIZE);
  const pageButton = (label, target, isDisabled) => `<button class="mx-button secondary" type="button" data-friend-action="page" data-friend-page="${target}" aria-controls="friend-list-rows"${busy || isDisabled ? ' disabled' : ''}>${label}</button>`;
  const pagination = total > FRIENDS_PAGE_SIZE ? `<nav class="pg-friend-pagination" aria-label="Friends pages">${pageButton('Previous', page - 1, page === 1)}<span aria-live="polite" aria-atomic="true">Page ${page} of ${pages}</span>${pageButton('Next', page + 1, page === pages)}</nav>` : '';
  contents = `<div class="pg-friends-heading"><div><h2>Your friends</h2><p class="mx-muted">Good rivals are always worth keeping.</p></div><button class="mx-button secondary" type="button" data-friend-action="refresh"${disabled}>${icon('refresh')} Refresh</button></div>
   <p class="pg-form-message" role="status" tabindex="-1" data-friends-status${state.message ? '' : ' hidden'}>${e(state.message || '')}</p>${confirmationHTML}
   <form class="pg-friend-search" data-friends-search aria-busy="${state.searchStatus === 'loading'}"><label for="friend-query">Find a player</label><div><input id="friend-query" name="query" value="${e(state.query || '')}" placeholder="Username or MEGA tag" maxlength="64" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="friend-search-help"${disabled}><button class="mx-button primary" type="submit"${busy || state.searchStatus === 'loading' ? ' disabled' : ''}>${icon('search')} Search</button></div><p id="friend-search-help" class="pg-profile-help">Use an exact player tag or at least three username characters.</p><p role="status" tabindex="-1" data-friends-search-status>${e(searchStatus)}</p></form>
   ${results}<section class="pg-friend-section pg-friend-primary-list" id="friend-list" aria-labelledby="friend-list-title"><div class="pg-friend-list-heading"><h3 id="friend-list-title" tabindex="-1">Friends <span class="pg-friend-count">${countLabel(total, state.truncated)}</span></h3><span class="mx-muted">${total ? `${start + 1}–${Math.min(start + FRIENDS_PAGE_SIZE, total)} of ${countLabel(total, state.truncated)}` : 'Your next rival starts here'}</span></div>${total ? `<ul class="pg-friend-list" id="friend-list-rows">${visible.map(player => row(player, 'friends')).join('')}</ul>` : '<p class="pg-friend-list-empty mx-muted">Search for a player above and send your first friend request.</p>'}${pagination}</section>
   <div class="pg-friend-request-groups" aria-label="Friend requests and blocked players">${requestList('friend-requests', 'Incoming requests', 'incoming', 'No incoming friend requests.')}${requestList('friend-outgoing', 'Sent requests', 'outgoing', 'No requests waiting for a reply.')}${state.blocked.length ? requestList('friend-blocked', 'Blocked players', 'blocked', 'No blocked players.') : ''}</div>
   ${state.truncated ? '<p class="pg-form-message">The service returned a partial list. These pages show only the players received; search by exact player tag to find someone else.</p>' : ''}`;
 }
 return `<div class="pg-page pg-friends-page">${pageHeading('GOOD RIVALS. BETTER FRIENDS.', 'Make it a friendly challenge.', 'Find your people, exchange a player tag, and take the board together.')}
  <div class="pg-grid pg-grid-sidebar"><aside class="pg-stack">${panel(`<div class="pg-profile-orb">${icon('user')}</div><h2>${profile ? e(nameOf(profile)) : 'Your player identity'}</h2><p class="mx-muted">${profile?.tag ? e(profile.tag) : 'One permanent tag follows you across devices.'}</p>${button(profile ? 'View / edit your profile' : 'Create or recover your profile', profile ? '/profile' : '/account', 'secondary', 'user')}<a class="pg-text-link pg-friend-challenge-link" href="/challenge">Direct challenges ${icon('arrow-right')}</a>`, 'pg-self-card')}</aside>
   ${panel(`<div id="friends-controls" aria-busy="${busy}">${contents}</div>`, 'pg-friends-main')}
  </div></div>`;
}
