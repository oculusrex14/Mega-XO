import {icon, button, pageHeading, escapeHtml as e} from './ui.js';

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

/** Add the opt-in only to this APK request; the checkbox preference is not persisted. */
export function apkMetricsHref(path, optedIn) {
  const url = new URL(path, 'https://megaxo.online');
  url.searchParams.delete('metrics');
  if (optedIn === true) url.searchParams.set('metrics', '1');
  return url.pathname + url.search + url.hash;
}

/** The parent supplies storeLinks generated from the validated central JSON.
 * Every platform anchor goes through the same server-side availability check. */
export function renderDownloadPage(context = {}) {
  const links = context.storeLinks || emptyLinks;
  const apk = links.androidApk || null;
  const platform = mobilePlatform(context.platform) || mobilePlatform(context.query?.get?.('platform')) || mobilePlatform(context.device);
  const unavailable = context.unavailable === true || context.unavailable === '1' || context.query?.get?.('unavailable') === '1';
  const platforms = [
    {id: 'android', name: 'Android', icon: 'android', store: 'Google Play'},
    {id: 'ios', name: 'iPhone & iPad', icon: 'apple', store: 'the App Store'},
  ];
  const available = id => typeof links[id] === 'string' && links[id].length > 0;
  const anyAvailable = platforms.some(item => available(item.id)) || !!apk;
  const notice = unavailable && (!platform || !available(platform))
    ? `<div class="pg-note" role="status">${icon('info')}<p>${platform === 'android' && apk
      ? 'The Google Play listing is not live yet. Install the signed Android app using the direct download below.'
      : `${platform === 'ios' ? 'The iPhone and iPad' : platform === 'android' ? 'The Android' : 'The requested'} store listing is not available yet. Play in your browser while you wait.`}</p></div>`
    : '';
  return `<div class="pg-page pg-download-page">${pageHeading('YOUR NEXT MOVE. ANYWHERE.', 'Take the bigger game with you.', anyAvailable ? 'Choose your platform or play now in your browser. Your linked Mega XOXO profile keeps your rank, friends and progress together.' : 'Play instantly in your browser. Coming soon to iPhone, iPad and Android.')}
    ${notice}
    <div class="pg-grid pg-grid-two">${platforms.map(item => {
      const apkForItem = item.id === 'android' ? apk : null;
      const statusChip = available(item.id) ? '<span class="mx-chip pg-chip-blue">Store link available</span>' : item.id === 'android' && apkForItem ? '<span class="mx-chip pg-chip-blue">Direct download available</span>' : '<span class="mx-chip pg-chip-amber">Coming soon</span>';
      const featureTop = '<div class="pg-feature-top"><div class="pg-feature-icon">' + icon(item.icon) + '</div>' + statusChip + '</div>';
      const body = available(item.id)
        ? `Continue to the official Mega XOXO listing on ${item.store}. The store shows the current release and device requirements.`
        : item.id === 'android' && apkForItem
          ? `The official Google Play listing is not live yet. Install the signed Mega XOXO app directly while we prepare the Google Play release.`
          : `The official Mega XOXO listing on ${item.store} is not available here yet. You can start a game in your browser today.`;
      const direct = apkForItem
        ? `<div class="pg-apk-direct"><div class="pg-apk-meta"><span class="mx-chip">Version ${e(apkForItem.versionName)}</span><span class="mx-chip">${Math.round(apkForItem.bytes / 1048576)} MB</span></div><a class="mx-button primary" data-apk-download-link data-apk-base-href="${e(apkForItem.path)}" href="${e(apkForItem.path)}" download>Download the Android APK</a><label class="pg-small mx-muted"><input type="checkbox" data-apk-metrics-opt-in> Help count unique downloads (optional)</label><p class="pg-small mx-muted">Unchecked downloads still count server-completed APK responses, including retries, but do not count a participating browser and clear any prior download cookie. Checking this box applies only to this download. Browser estimates cover participating browsers only; they do not confirm installs. Cookie: up to 365 days; keyed deduplication hash and daily buckets: up to 400 days; aggregate lifetime totals: kept indefinitely. <a href="/privacy">Privacy details</a>.</p><p class="pg-small mx-muted">Android shows a Play Protect warning for apps installed outside the Play Store; choose “Install anyway” to continue.</p></div>`
        : '';
      return `<article class="mx-panel pg-panel pg-feature" aria-labelledby="download-${item.id}-title">${featureTop}<div class="pg-actions">${platform === item.id ? '<span class="mx-chip">For your device</span>' : ''}</div><h2 id="download-${item.id}-title">${item.name}</h2><p class="mx-muted">${body}</p>${button(available(item.id) ? `Open ${item.store === 'the App Store' ? 'App Store' : item.store}` : `Check ${item.id === 'ios' ? 'iOS' : 'Android'} availability`, downloadHref(item.id), available(item.id) ? 'primary' : 'secondary', 'download')}${direct}</article>`;
    }).join('')}</div>
    <section class="mx-panel pg-panel pg-practice-banner" aria-labelledby="download-browser-title"><div class="pg-feature-icon">${icon('monitor')}</div><div><span class="mx-eyebrow">READY IN YOUR BROWSER</span><h2 id="download-browser-title">The next move starts here.</h2><p class="mx-muted">Nine small boards. One bigger game. Play locally right away, or sign in to your permanent profile for online competition.</p></div>${button('Play Now', '/play', 'primary', 'arrow-right')}</section>

  </div>`;
}
