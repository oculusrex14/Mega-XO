import {icon, button, pageHeading} from './ui.js';

const emptyLinks = Object.freeze({ios: null, android: null});
const mobilePlatform = value => value === 'ios' || value === 'android' ? value : null;

/** iPadOS can report a desktop Safari user agent and MacIntel platform. */
export function detectDownloadPlatform({userAgent = '', platform = '', maxTouchPoints = 0} = {}) {
  const ua = typeof userAgent === 'string' ? userAgent : '';
  const host = typeof platform === 'string' ? platform : '';
  if (/Android/i.test(ua)) return 'android';
  if (/iPad|iPhone|iPod/i.test(ua)) return 'ios';
  if ((/Mac/i.test(host) || /Macintosh/i.test(ua)) && Number.isFinite(maxTouchPoints) && maxTouchPoints > 1) return 'ios';
  return 'desktop';
}

export function downloadHref(device) {
  const platform = mobilePlatform(device);
  return `/api/download${platform ? `?platform=${platform}` : ''}`;
}

/** The parent supplies storeLinks generated from the validated central JSON.
 * Every platform anchor goes through the same server-side availability check. */
export function renderDownloadPage(context = {}) {
  const links = context.storeLinks || emptyLinks;
  const platform = mobilePlatform(context.platform) || mobilePlatform(context.query?.get?.('platform')) || mobilePlatform(context.device);
  const unavailable = context.unavailable === true || context.unavailable === '1' || context.query?.get?.('unavailable') === '1';
  const platforms = [
    {id: 'android', name: 'Android', icon: 'android', store: 'Google Play'},
    {id: 'ios', name: 'iPhone & iPad', icon: 'apple', store: 'the App Store'},
  ];
  const available = id => typeof links[id] === 'string' && links[id].length > 0;
  const anyAvailable = platforms.some(item => available(item.id));
  const notice = unavailable && (!platform || !available(platform))
    ? `<div class="pg-note" role="status">${icon('info')}<p>${platform === 'ios' ? 'The iPhone and iPad' : platform === 'android' ? 'The Android' : 'The requested'} store listing is not available yet. Play in your browser while you wait.</p></div>`
    : '';
  return `<div class="pg-page pg-download-page">${pageHeading('YOUR NEXT MOVE. ANYWHERE.', 'Take the bigger game with you.', anyAvailable ? 'Choose your platform or play now in your browser. Your linked Mega XOXO profile keeps your rank, friends and progress together.' : 'Play instantly in your browser. Coming soon to iPhone, iPad and Android.')}
    ${notice}
    <div class="pg-grid pg-grid-two">${platforms.map(item => `<article class="mx-panel pg-panel pg-feature" aria-labelledby="download-${item.id}-title"><div class="pg-feature-icon">${icon(item.icon)}</div><div class="pg-actions"><span class="mx-chip ${available(item.id) ? 'pg-chip-blue' : 'pg-chip-amber'}">${available(item.id) ? 'Store link available' : 'Coming soon'}</span>${platform === item.id ? '<span class="mx-chip">For your device</span>' : ''}</div><h2 id="download-${item.id}-title">${item.name}</h2><p class="mx-muted">${available(item.id) ? `Continue to the official Mega XOXO listing on ${item.store}. The store shows the current release and device requirements.` : `The official Mega XOXO listing on ${item.store} is not available here yet. You can start a game in your browser today.`}</p>${button(available(item.id) ? `Open ${item.store === 'the App Store' ? 'App Store' : item.store}` : `Check ${item.id === 'ios' ? 'iOS' : 'Android'} availability`, downloadHref(item.id), available(item.id) ? 'primary' : 'secondary', 'download')}</article>`).join('')}</div>
    <section class="mx-panel pg-panel pg-practice-banner" aria-labelledby="download-browser-title"><div class="pg-feature-icon">${icon('monitor')}</div><div><span class="mx-eyebrow">READY IN YOUR BROWSER</span><h2 id="download-browser-title">The next move starts here.</h2><p class="mx-muted">Nine small boards. One bigger game. Play locally right away, or sign in to your permanent profile for online competition.</p></div>${button('Play Now', '/play', 'primary', 'arrow-right')}</section>

  </div>`;
}
