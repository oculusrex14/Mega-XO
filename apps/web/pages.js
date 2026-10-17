import { icon, escapeHtml, button, pageHeading } from './ui.js';
import {renderDownloadPage} from './downloads.js';
import {renderFriendsPage} from './friends-view.js';
import {researchConsentCard} from './consent.js';

/** Public page copy is product documentation. Player state is never fabricated. */
export const routes = [
  { path: '/download', title: 'Download', description: 'Choose Android, iPhone or iPad downloads when available, or play Mega XOXO in your browser today.' },
  { path: '/faq', title: 'Frequently asked questions', description: 'Answers about Mega XOXO rules, browser play, accounts, appearances and mobile downloads.' },
  { path: '/play', title: 'Play', description: 'Choose local practice, Ranked, Casual or a game with friends.' },
  { path: '/casual', title: 'Casual', description: 'All the Mega XOXO strategy with no Elo at stake.' },
  { path: '/ranked', title: 'Ranked', description: 'Climb the Mega XOXO leagues through skill and seasonal competition.' },
  { path: '/tournaments', title: 'Tournaments', description: 'Explore ten-player Mega XOXO tournament tables and find your next competition.' },
  { path: '/season', title: 'Season', description: 'Quarterly Ranked seasons, qualification and weekly rewards.' },
  { path: '/friends', title: 'Friends', description: 'Your friends, invitations and permanent Mega XOXO player tag.', private: true },
  { path: '/challenge', title: 'Direct challenge', description: 'Challenge a friend or a qualified leaderboard player.', private: true },
  { path: '/leaderboard', title: 'Leaderboard', description: 'Understand the seasonal skill and wealth leaderboards.' },
  { path: '/rewards', title: 'Rewards', description: 'Coins, Crowns, daily rewards and account-bound Cosmetic Credits.' },
  { path: '/store', title: 'Store', description: 'Explore Crown packs and permanent Remove Ads for your Mega XOXO profile.' },
  { path: '/sponsors', title: 'Sponsors', description: 'Optional sponsor information and your advertising interests.' },
  { path: '/ads', title: 'Sponsors', description: 'Optional sponsor information and your advertising interests.' },
  { path: '/themes', title: 'Themes', description: 'Preview Mega XOXO Neon, Vector Light, Midnight Club, Paper Club and After Hours.' },
  { path: '/profile', title: 'Your profile', description: 'Manage your permanent player identity and profile preferences.', private: true },
  { path: '/account', title: 'Account', description: 'Sign in, recover your profile and manage linked account methods.', private: true },
  { path: '/how-to-play', title: 'How to play', description: 'Nine small boards. One big strategy. Learn the rules of Mega XOXO.' },
  { path: '/support', title: 'Support', description: 'Get account, purchase, gameplay and privacy help from Antimatter Innovations.' },
  { path: '/help', title: 'Help', description: 'Answers to Mega XOXO account, gameplay, purchase and privacy questions.' },
  { path: '/accessibility', title: 'Accessibility', description: 'Keyboard navigation, reduced motion and accessibility support for Mega XOXO.' },
  { path: '/about', title: 'About', description: 'Mega XOXO by Antimatter Innovations. Bigger moves. Brighter minds.' },
  { path: '/privacy', title: 'Privacy', description: 'Read the current Mega XOXO privacy policy and privacy controls.' },
  { path: '/terms', title: 'Terms', description: 'Read the current Mega XOXO terms of service.' },
  { path: '/delete-account', title: 'Delete account', description: 'How to request permanent deletion of your Mega XOXO account.' },
  { path: '/privacy-choices', title: 'Privacy choices', description: 'Data export, profile visibility, advertising privacy and account deletion.' },
  ...['privacy', 'terms', 'support', 'delete-account', 'privacy-choices'].map(name => ({ path: `/legal/${name}`, title: name === 'terms' ? 'Terms of Service' : name === 'privacy' ? 'Privacy Policy' : name.replaceAll('-', ' '), description: 'Mega XOXO document from Antimatter Innovations.' })),
  { path: '/status', title: 'Service status', description: 'Check service information and troubleshoot connection issues.' },
  { path: '/news', title: 'News', description: 'Mega XOXO release information and product updates.' },
  { path: '/offline', title: 'You are offline', description: 'Keep thinking bigger with local practice.' },
  { path: '/404', title: 'Page not found', description: 'Find your way back to Mega XOXO.' },
];

const tiers = [
  ['Wood', 0, 2, 20], ['Stone', 700, 4, 25], ['Iron', 900, 6, 30],
  ['Bronze', 1100, 8, 40], ['Silver', 1300, 10, 50], ['Gold', 1500, 12, 65],
  ['Diamond', 1700, 16, 85], ['Emerald', 1900, 20, 110],
  ['Champion', 2200, 24, 150], ['Master', 2400, 30, 220], ['Grandmaster', 2600, 40, 300],
];

const themes = [
  { id: 'cinematic', name: 'Mega XOXO Neon', tagline: 'Your default browser atmosphere.', canvas: '#030917', x: '#39CFFF', o: '#FF63B6', surface: '#0B1320', ink: '#F3F7FF', accent: '#17B7FF', copy: 'The homepage atmosphere, brought to every move. Dark blue boards, cyan Xs, pink Os and a luminous blue route. Available on the web.' },
  { id: 'vector', name: 'Vector Light', tagline: 'Clear board. Clear thinking.', canvas: '#E9ECEF', x: '#246BFD', o: '#F45669', surface: '#F8F9FB', ink: '#15181C', accent: '#C6FF42', copy: 'Bright neutral surfaces, crisp blue Xs and coral Os. The clean original.' },
  { id: 'midnight', name: 'Midnight Club', tagline: 'Find focus after dark.', canvas: '#080B10', x: '#6F9DFF', o: '#FF7A98', surface: '#101720', ink: '#D4DCE5', accent: '#B9F03C', copy: 'Deep charcoal, soft blue and pink marks, with a lime active-board accent.' },
  { id: 'paperclub', name: 'Paper Club', tagline: 'A little ink. A bigger idea.', canvas: '#B9AB8F', x: '#2A4F9B', o: '#C23A2E', surface: '#F6EFDC', ink: '#27221B', accent: '#FFD23F', copy: 'Warm notebook paper, ruled details and hand-drawn blue and red marks.' },
  { id: 'afterhours', name: 'After Hours', tagline: 'Stay for one more move.', canvas: '#07030F', x: '#2CF2FF', o: '#FF4FB6', surface: '#0F0722', ink: '#F1EAFF', accent: '#FFD83D', copy: 'Retro arcade purple, cyan and pink glow, and a yellow active-board accent.' },
];

const e = escapeHtml;
const tierId = value => {
  const raw = typeof value === 'object' && value ? value.id || value.name : value;
  const key = typeof raw === 'string' ? raw.toLowerCase().replaceAll(' ', '') : '';
  return tiers.some(([name]) => name.toLowerCase() === key) ? key : null;
};
const tierName = value => tiers.find(([name]) => name.toLowerCase() === tierId(value))?.[0] || 'Unpublished';
const rankImage = (value, className = 'pg-rank-image') => {
  const key = tierId(value);
  return key ? `<img class="${className}" src="/assets/art/ranks/${key}.webp" width="96" height="96" alt="">` : icon('shield', className);
};
const numeric = (value, digits = 0) => {
  if (typeof value === 'string' && digits === 0 && /^\d+$/.test(value)) {
    try { return BigInt(value).toLocaleString('en-US'); } catch { return '—'; }
  }
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—';
};
const displayName = profile => profile?.displayName || profile?.name || profile?.username || 'Player';
const isLinked = context => context.sessionStatus === 'linked' || (!context.sessionStatus && Boolean(context.profile));
const heading = (eyebrow, title, copy) => pageHeading(eyebrow, title, copy);
const panel = (content, className = '') => `<section class="mx-panel pg-panel ${className}">${content}</section>`;
const sectionTitle = (title, copy = '', suffix = '') => `<div class="pg-section-title"><div><h2>${title}</h2>${copy ? `<p class="mx-muted">${copy}</p>` : ''}</div>${suffix}</div>`;
const actions = (...links) => `<div class="pg-actions">${links.join('')}</div>`;
const feature = (symbol, title, copy, footer = '') => panel(`<div class="pg-feature-icon">${icon(symbol)}</div><h2>${title}</h2><p class="mx-muted">${copy}</p>${footer}`, 'pg-feature');
const pill = (text, extra = '') => `<span class="mx-chip ${extra}">${text}</span>`;
const linkRow = (symbol, title, copy, href) => `<a class="pg-link-row" href="${href}"><span class="pg-row-icon">${icon(symbol)}</span><span><strong>${title}</strong><small>${copy}</small></span>${icon('chevron-right')}</a>`;
const note = (text, symbol = 'info') => `<div class="pg-note">${icon(symbol)}<p>${text}</p></div>`;
const empty = (symbol, title, copy, links = '', className = '', headingTag = 'h2') => `<div class="pg-empty ${className}"><div class="pg-empty-art" aria-hidden="true">${icon(symbol)}<span></span><span></span></div><${headingTag}>${title}</${headingTag}><p>${copy}</p>${links}</div>`;
const signin = (copy = 'Your rank, friends and rewards belong to one permanent profile.') => `<div class="pg-signin"><span class="pg-row-icon">${icon('user')}</span><div><strong>Sign in to play online</strong><p>${copy}</p></div>${button('Open account', '/account', 'primary', 'arrow-right')}</div>`;
const sessionPrompt = (context, copy) => isLinked(context) ? '' : context.sessionStatus === 'loading' ? '<p class="pg-session-status mx-muted" role="status">Checking your account…</p>' : context.sessionStatus === 'error' ? `<div class="pg-note" role="status"><p>We could not check your account. ${button('Check account', '/account', 'secondary', 'refresh')}</p></div>` : signin(copy);
const shortList = (items) => `<ul class="pg-check-list">${items.map((item) => `<li>${icon('check')}<span>${item}</span></li>`).join('')}</ul>`;
const mini = (marks = ['X', '', 'O', '', 'X', '', '', '', 'O'], className = '') => `<div class="pg-mini ${className}" aria-hidden="true">${marks.map((mark) => `<span class="${mark === 'X' ? 'pg-x' : mark === 'O' ? 'pg-o' : ''}">${mark}</span>`).join('')}</div>`;
const rankGem = tier => `<div class="pg-rank-gem" data-rank-tier="${tierId(tier) || ''}" aria-hidden="true">${rankImage(tier)}</div>`;

function playerIdentityCard(context) {
  const profile = isLinked(context) ? context.profile : null;
  if (!profile) return panel(`${sectionTitle('Your skill stands alone')}<p>Coins, Crowns, stake size and purchase history never affect Elo.</p><p class="mx-muted">Wealth includes liquid and reserved holdings in Coin-equivalent. It is not a record of lifetime purchases.</p>${context.sessionStatus === 'loading' ? '<p role="status">Checking your profile…</p>' : button('Sign in to your profile', '/account', 'secondary', 'user')}`);
  const index = tiers.findIndex(([name]) => name.toLowerCase() === tierId(profile.tier));
  const games = Number.isSafeInteger(profile.games) && profile.games >= 0 ? profile.games : null;
  const rating = typeof profile.rating === 'number' && Number.isFinite(profile.rating) && profile.rating >= 0 ? profile.rating : null;
  let progress = '<p class="mx-muted">Your published rank progress will appear when available.</p>';
  if (games !== null && games < 10) {
    progress = `<label class="pg-rank-progress-label" for="player-rank-progress">Rated placements <strong>${games} / 10</strong></label><progress id="player-rank-progress" max="10" value="${games}" aria-label="Rated placement progress">${games} of 10 placements</progress><p class="pg-small mx-muted">Complete ten lifetime rated games before your normal public rank is published.</p>`;
  } else if (index >= 0 && rating !== null) {
    const floor = tiers[index][1], next = tiers[index + 1];
    if (next) {
      const remaining = Math.max(0, next[1] - rating), buffer = Math.max(0, rating - floor);
      const value = Math.max(0, Math.min(100, ((rating - floor) / (next[1] - floor)) * 100));
      progress = `<label class="pg-rank-progress-label" for="player-rank-progress">Rating toward ${next[0]}<strong>${numeric(rating, 2)} / ${numeric(next[1])}</strong></label><progress id="player-rank-progress" max="100" value="${value}" aria-label="Rating progress from the published ${tiers[index][0]} floor to the ${next[0]} floor">${Math.round(value)}%</progress><div class="pg-rank-boundaries"><span>${floor ? `${numeric(buffer, 2)} rating above the ${tiers[index][0]} floor` : 'Wood has no lower league'}</span><span>${remaining ? `${numeric(remaining, 2)} to the next rating floor` : 'Next rating floor reached'}</span></div>${rating < floor ? '<p class="pg-small mx-muted">Your rating is below this league’s floor. The server publishes your current league and eligibility.</p>' : ''}${!remaining ? '<p class="pg-small mx-muted">Your published league remains the one shown above. Placements, eligibility and weekly allocation can affect publication.</p>' : ''}`;
    } else progress = `<p class="pg-small mx-muted">${numeric(Math.max(0, rating - floor), 2)} rating above the Grandmaster floor. This is the highest league.</p>`;
    if (index >= 7) progress += '<p class="pg-small mx-muted">Champion, Master and Grandmaster have limited weekly seats and activity requirements. Rating progress alone does not guarantee promotion or prevent a seat change.</p>';
  }
  return panel(`<div class="pg-player-card-heading">${rankImage(profile.tier, 'pg-player-card-rank')}<div><span class="mx-eyebrow">YOUR PLAYER CARD</span><h2>${e(displayName(profile))}</h2><p>${tierName(profile.tier)} · <strong>${numeric(profile.rating, 2)}</strong> rating</p></div></div><dl class="pg-player-card-id"><dt>Player ID</dt><dd>${e(profile.tag || profile.friendCode || 'Not available')}</dd></dl>${progress}${button('Your profile', '/profile', 'secondary', 'user')}`, 'pg-player-id-card');
}

function utcSeason(value) {
  const candidate = value ? new Date(value) : new Date();
  const date = Number.isFinite(candidate.getTime()) ? candidate : new Date();
  const quarter = Math.floor(date.getUTCMonth() / 3);
  const start = new Date(Date.UTC(date.getUTCFullYear(), quarter * 3, 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), quarter * 3 + 3, 0));
  const format = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return { title: `Q${quarter + 1} ${date.getUTCFullYear()}`, range: `${format(start)} – ${format(end)}, ${date.getUTCFullYear()}`, end: `${end.toISOString().slice(0, 10)} 23:59 UTC` };
}

function playPage(context) {
  return `<div class="pg-page">${heading('THE NEXT MOVE IS YOURS', 'Choose your arena.', 'Nine small boards. A world of possibility. Start with practice, or bring your strategy online.')}
    <div class="pg-grid pg-grid-three pg-mode-grid">
      ${panel(`<div class="pg-mode-art pg-mode-ranked">${rankGem()}</div>${pill('RATED', 'pg-chip-blue')}<h2>Ranked</h2><p>Every move counts. Compete with matched opponents and climb through the leagues.</p>${button('Play Ranked', '/game?mode=ranked', 'primary', 'swords')}<small>Requires a linked account · Coin entry</small>`, 'pg-mode')}
      ${panel(`<div class="pg-mode-art pg-mode-casual">${mini()}${mini(['', 'X', '', 'O', '', '', 'X', '', 'O'])}</div>${pill('NO ELO CHANGE')}<h2>Casual</h2><p>Find an online opponent and try a new strategy without changing your rating.</p>${button('Play Casual', '/game?mode=casual', 'secondary', 'globe')}<small>Requires a linked account</small>`, 'pg-mode')}
      ${panel(`<div class="pg-mode-art pg-mode-friends">${icon('people')}<span class="pg-mode-cross">×</span></div>${pill('YOUR PEOPLE')}<h2>With friends</h2><p>Find your friends by player tag, send an invite, and make the next move together.</p>${button('Find your friends', '/friends', 'secondary', 'people')}<small>Free friend games do not change Elo</small>`, 'pg-mode')}
    </div>
    ${panel(`<div class="pg-practice-art" aria-hidden="true">${mini(['X', '', '', '', 'O', '', '', '', 'X'])}</div><div><span class="mx-eyebrow">NO ACCOUNT NEEDED</span><h2>Think bigger. Start smaller.</h2><p class="mx-muted">Get comfortable with the board in local practice. Learn how one small move can shape the whole game.</p></div>${button('Start practicing with bots', '/game?mode=bot', 'primary', 'arrow-right')}`, 'pg-practice-banner')}
    ${actions(button('Learn the rules', '/how-to-play', 'secondary', 'help'), button('Explore tournaments', '/tournaments', 'secondary', 'trophy'))}
  </div>`;
}

function rankedPage(context) {
  const season = utcSeason(context.now);
  const profile = isLinked(context) ? context.profile : null;
  const publishedTier = tierId(profile?.tier);
  const personal = profile ? `<h2>${publishedTier ? tierName(publishedTier) : 'Your rank is unpublished'}</h2><p class="pg-personal-rating"><strong>${numeric(profile.rating, 2)}</strong> rating</p><p class="mx-muted">${e(displayName(profile))}${profile.tag ? ` · ${e(profile.tag)}` : ''}</p>` : '<h2>It starts with a move.</h2>';
  return `<div class="pg-page">${heading('SKILL HAS THE LAST WORD', 'Earn your place.', 'From your first placement to the highest leagues, your rating is decided by how you play.')}
    <div class="pg-grid pg-grid-sidebar">
      <aside class="pg-stack pg-ranked-aside">${panel(`<div class="pg-rank-orbit">${rankGem(profile ? publishedTier : 'diamond')}</div><span class="mx-eyebrow">YOUR RANKED JOURNEY</span>${personal}<p class="mx-muted">New profiles start at 600 rating. Complete ten lifetime rated placements before your normal public skill rank is published.</p>${context.sessionStatus === 'loading' ? '<p role="status">Checking your account…</p>' : button(profile ? 'Open Ranked' : 'Sign in to play online', profile ? '/game?mode=ranked' : '/account', 'primary', 'swords')}<div class="pg-divider"></div><div class="pg-inline-stat"><span>Current season</span><strong>${season.title}</strong></div><p class="pg-small mx-muted">${season.range} · UTC</p><a class="pg-text-link" href="/season">Season qualification ${icon('arrow-right')}</a>`, 'pg-rank-summary')}${panel(`${sectionTitle('Build your next good move')}<ol class="pg-ranked-tips"><li><strong>Watch the destination.</strong><p>Every cell sends your opponent to the matching small board.</p></li><li><strong>Protect two boards at once.</strong><p>A local win helps only if you also protect the big-board line.</p></li><li><strong>Warm up at your pace.</strong><p>Try a bot game before joining the Ranked queue.</p></li></ol>${button('Practice with bots', '/game?mode=bot', 'secondary', 'arrow-right')}`)}</aside>
      <div class="pg-stack">${panel(`${sectionTitle('One ladder. Pure skill.', 'Coins, Crowns and purchases never enter the Elo formula.')}<div class="pg-grid pg-grid-three pg-compact-grid">${feature('swords', 'Play', 'Enter the Ranked queue and compete with matched opponents.')}${feature('shield', 'Qualify', 'Complete your placements and qualify again each quarter.')}${feature('trophy', 'Climb', 'Build your rating through rated games. Elo is retained at rollover.')}</div>`, 'pg-rank-explainer')}
        ${panel(`${sectionTitle('The leagues', 'Rating floors, queue entry and full weekly rewards. Actual weekly payouts require qualification and are prorated.')}<div class="pg-table-wrap" role="region" aria-label="League rating floors, entry fees and rewards" tabindex="0"><table class="pg-table"><caption class="pg-sr-only">Mega XOXO league rating floors, queue fees and full weekly rewards</caption><thead><tr><th scope="col">League</th><th scope="col">Rating floor</th><th scope="col">Entry</th><th scope="col">Weekly</th></tr></thead><tbody>${tiers.map(([name, floor, fee, reward]) => `<tr><th scope="row">${rankImage(name, 'pg-tier-image')}${name}</th><td>${floor.toLocaleString('en-US')}</td><td>${fee} Coins</td><td>${reward} Coins</td></tr>`).join('')}</tbody></table></div>${note('Champion, Master and Grandmaster are limited weekly seats with additional eligibility requirements. Their rating floor alone does not guarantee a seat.')}`)}
      </div>
    </div>
    ${panel(`${sectionTitle('What a Ranked win means')}<div class="pg-grid pg-grid-three"><div><h3>Same entry for both players</h3><p>The pairing uses the lower configured league fee. Half the combined pot is retired and half goes to the winner.</p></div><div><h3>A separate win reward</h3><p>A qualifying queue win earns floor(60% of your pre-match league fee), capped at 50 Coins per UTC day.</p></div><div><h3>Your skill stays yours</h3><p>Rated queue and rated direct challenges use K=24 Elo. Casual, local and public tournament games do not change normal Ranked Elo.</p></div></div>`, 'pg-copy-panel')}
  </div>`;
}

function casualPage(context) {
  return `<div class="pg-page">${heading('ALL THE STRATEGY. NO ELO AT STAKE.', 'Play for the next good move.', 'Warm up, try a different route, or simply enjoy the game. Casual results do not change your Ranked rating.')}
    ${panel(`<div class="pg-about-symbol" aria-hidden="true"><span>×</span><span>○</span><span>×</span><span>○</span></div><div class="pg-about-copy"><span class="mx-eyebrow">ONLINE CASUAL</span><h2>A fresh board. A new rival.</h2><p>Find an online rival for a fresh challenge. Your permanent profile stays with you, and your normal Ranked Elo stays unchanged.</p>${actions(button(isLinked(context) ? 'Find a Casual match' : 'Choose Casual online', '/game?mode=casual', 'primary', 'globe'), button('Practice with bots', '/game?mode=bot', 'secondary', 'arrow-right'))}</div>`, 'pg-about-hero')}
    <div class="pg-grid pg-grid-three">${feature('globe', 'Find an opponent', 'Choose Casual in the online game to join the shared matchmaking pool.')}${feature('shield', 'Explore your strategy', 'Casual does not alter Elo. The same small-board routing and big-board win rules apply.')}${feature('people', 'Play with friends', 'Use a free friend game when you already have a rival in mind.', `<a class="pg-text-link" href="/friends">Find your friends ${icon('arrow-right')}</a>`)}</div>
    ${note('Local practice is available without linking an account. Online Casual uses your permanent profile.')}
  </div>`;
}

function tournamentsPage(context) {
  return '<div class="pg-page">' + heading('TEN PLAYERS. ONE TOP SPOT.', 'Bring your best game.', 'A tournament is its own challenge. Compete for placement and prizes while your normal Ranked Elo stays unchanged.')
    + panel('<div class="pg-tournament-intro"><div class="pg-trophy-art" aria-hidden="true"><img src="/assets/art/trophy.webp" width="552" height="552" alt=""></div><div><span class="mx-eyebrow">PUBLIC TABLES</span><h2>A fair field from the start.</h2><p>Every paid public tournament assembles exactly ten players within a maximum 200 Elo spread.</p></div><div class="pg-tournament-facts"><span><strong>10</strong>players per table</span><span><strong>200</strong>maximum Elo spread</span><span><strong>5</strong>prize places</span></div></div>', 'pg-tournament-hero')
    + sectionTitle('Choose your table', 'Compare entry and prizes below, then take a seat.')
    + '<section class="mx-panel pg-panel pg-tournament-live" data-tournament-controls aria-live="polite"></section>'
    + note('Public tournament fixtures do not mint normal Ranked win bonuses. Coins and Crowns have no cash-out or real-world redemption.')
    + '</div>';
}

function seasonPage(context) {
  const season = utcSeason(context.now);
  return `<div class="pg-page">${heading('A NEW QUARTER. A NEW CHALLENGE.', 'The season is yours to shape.', 'Your Elo carries forward. Your seasonal qualification, record, peak and leaderboard participation begin again each quarter.')}
    ${panel(`<div class="pg-season-display"><div class="pg-season-symbol" aria-hidden="true">${icon('trophy')}</div><div><span class="mx-eyebrow">CURRENT UTC QUARTER</span><h2>${season.title}</h2><p>${season.range}</p><span class="mx-chip">Quarterly Ranked season</span></div><div class="pg-season-cutoff"><span class="mx-muted">Quarter ends</span><strong>${season.end}</strong><a class="pg-text-link" href="/ranked">Explore Ranked ${icon('arrow-right')}</a></div></div>`, 'pg-season-hero')}
    <div class="pg-grid pg-grid-two">${panel(`${sectionTitle('Get season-qualified', 'Requalify during each quarterly UTC season.')}<div class="pg-rule-number"><strong>5</strong><span>rated games</span></div><div class="pg-rule-number"><strong>3</strong><span>matchmade Ranked queue games</span></div><div class="pg-rule-number"><strong>3</strong><span>unique rated opponents</span></div>${button('Open Ranked', '/game', 'primary', 'swords')}`)}
      ${panel(`${sectionTitle('Make it a rewarding week', 'The week runs from Monday 00:00 UTC to the next Monday.')}<ul class="pg-bullet-list"><li>5 qualifying rated games</li><li>3 matchmade queue games and 3 unique opponents</li><li>Activity on 3 days</li><li>At least 3 valid daily tier snapshots</li></ul><p class="mx-muted">The reward uses the lower of your end-of-week tier and the lower median observed tier, prorated by valid snapshot days out of seven.</p><a class="pg-text-link" href="/rewards">Understand your rewards ${icon('arrow-right')}</a>`)}
    </div>
    ${panel(`${sectionTitle('A seat at the very top', 'Champion · Master · Grandmaster')}<div class="pg-grid pg-grid-three pg-seat-grid"><div><strong>1,000</strong><span>Champion seats</span></div><div><strong>200</strong><span>Master seats</span></div><div><strong>20</strong><span>Grandmaster seats</span></div></div><p>Elite allocation activates when the eligible population reaches 5,000. Candidates need 50 lifetime rated games, ten unique rated opponents, a 14-day-old account, season qualification and recent qualifying activity.</p><p class="mx-muted">Seats publish weekly. Inactivity releases a seat without removing Elo; eligible open-league status remains based on rating.</p>`, 'pg-copy-panel')}
    ${sessionPrompt(context, 'Sign in to track your season qualification and reward status.')}
  </div>`;
}

function friendsPage(context) {
  return renderFriendsPage(context);
}

function challengePage(context) {
  return `<div class="pg-page">${heading('CALL YOUR NEXT MATCH', 'A worthy opponent awaits.', 'Play a free game with a friend, or make a rated challenge. Review the invitation and terms before you accept.')}
    <div class="pg-grid pg-grid-two">${panel(`<div class="pg-duel-symbols" aria-hidden="true"><span>×</span>${icon('swords')}<span>○</span></div>${pill('NO ELO CHANGE')}<h2>A friendly game</h2><p>Invite a friend to play for free. Try a route, settle a rivalry, or simply enjoy the board together.</p>${button('Open Friends', '/friends', 'primary', 'people')}`, 'pg-challenge-card')}${panel(`<div class="pg-duel-symbols pg-duel-crowns" aria-hidden="true">${icon('crown')}</div>${pill('RATED')}<h2>A direct rated challenge</h2><p>The challenger funds the Crown contribution. The invited player contributes zero. Stakes never change the Elo formula.</p>${button('Open challenges', '/friends?view=challenges', 'secondary', 'swords')}`, 'pg-challenge-card')}</div>
    ${panel(`${sectionTitle('Know the terms before you accept')}<div class="pg-grid pg-grid-three"><div><h3>Friend-stake games</h3><p>Require mutual server-recorded friendship. The challenger contributes between 2 and 20 Crowns.</p></div><div><h3>Leaderboard challenges</h3><p>The minimum contribution is calculated from the target league and tier gap. The game shows the server quote before confirmation.</p></div><div><h3>Clear settlement</h3><p>For a decisive rated result, 50% of the challenger-funded pot is retired and 50% is paid to the winner. A draw or trusted server void returns the contribution.</p></div></div>`, 'pg-copy-panel')}
    ${isLinked(context) ? actions(button('View your invitations', '/friends?view=challenges', 'primary', 'people')) : sessionPrompt(context, 'Sign in to view invitations and eligibility. Rated challenges require your completed placements.')}
  </div>`;
}

function leaderboardPage(context) {
  const state = context.leaderboard || { status: 'loading', rows: [] };
  const metric = state.metric === 'wealth' ? 'wealth' : 'rating';
  const scope = state.scope === 'region' ? 'region' : 'global';
  const league = tierId(state.league) || 'all';
  const rows = state.status === 'ready' && Array.isArray(state.rows) ? state.rows.filter(row => row && typeof row === 'object').slice(0, 100) : [];
  const selected = (a, b) => a === b ? ' selected' : '';
  const authRequired = state.status === 'auth-required' || ['AUTH_REQUIRED', 'LINK_ACCOUNT_REQUIRED'].includes(state.code || state.error?.code || state.error);
  let body;
  if (state.status === 'loading') body = `<div class="pg-loading-state" role="status" aria-live="polite">${icon('refresh')}<h3>Loading the standings…</h3><p>Getting the latest published leaderboard.</p></div>`;
  else if (authRequired) body = isLinked(context) ? empty('refresh', 'The standings need a refresh.', 'Your profile is signed in. Refresh to check the latest published standings.', '<button class="mx-button secondary" type="button" data-leaderboard-action="refresh">Refresh standings</button>') : context.sessionStatus === 'loading' ? '<p role="status">Checking your account…</p>' : empty('user', 'Sign in to play online', 'Use your permanent profile to view the published standings.', button('Open account', '/account', 'primary', 'arrow-right'));
  else if (state.status === 'error') body = empty('cloud', 'The standings could not be loaded.', 'Try refreshing the leaderboard. Your filter choices will stay in place.', `<button class="mx-button secondary" type="button" data-leaderboard-action="refresh">${icon('refresh')} Try again</button>`);
  else if (!rows.length) body = empty('trophy', 'The next place is waiting.', 'No published players match these filters yet. Try all leagues or global standings.');
  else body = `<div class="pg-table-wrap pg-standings-wrap" role="region" tabindex="0" aria-label="Scrollable leaderboard"><table class="pg-table pg-standings"><caption class="pg-sr-only">${metric === 'wealth' ? 'Wealth' : 'Skill'} leaderboard, ${scope === 'region' ? 'your region' : 'global'}, ${league === 'all' ? 'all leagues' : tierName(league)}</caption><thead><tr><th scope="col">Place</th><th scope="col">Player</th><th scope="col">League</th><th scope="col">${metric === 'wealth' ? 'Coin-equivalent' : 'Rating'}</th><th scope="col">Region</th></tr></thead><tbody>${rows.map((row, i) => `<tr ${row.id && row.id === context.profile?.id ? 'class="pg-current-player"' : ''}><td class="pg-place">${Number.isSafeInteger(row.position) && row.position > 0 ? row.position : i + 1}</td><th scope="row"><span class="pg-player-name">${e(displayName(row))}${row.id && row.id === context.profile?.id ? ' <span class="mx-chip">You</span>' : ''}</span><small class="pg-player-tag">${e(row.tag || '')}</small></th><td><span class="pg-standing-tier">${rankImage(row.tier, 'pg-tier-image')}<span>${tierName(row.tier)}</span></span></td><td class="pg-score">${metric === 'wealth' ? numeric(row.wealth ?? row.value) : numeric(row.rating, 2)}</td><td>${e(row.region || '—')}</td></tr>`).join('')}</tbody></table></div>`;
  const updated = typeof state.updatedAt === 'number' && Number.isFinite(new Date(state.updatedAt).getTime()) ? `<time datetime="${new Date(state.updatedAt).toISOString()}">Updated ${e(new Date(state.updatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }))} UTC</time>` : '';
  return `<div class="pg-page">${heading('THE BOARD DOES THE TALKING', 'Play your way up.', 'Seasonal skill reflects your competitive rating. Wealth reflects current holdings. They are separate measures.')}
    ${panel(`<div class="pg-leaderboard-heading"><div><span class="mx-eyebrow">PUBLISHED STANDINGS</span><h2>Every position is earned.</h2></div>${icon('trophy')}</div><div class="pg-leaderboard-controls"><label>Leaderboard<select data-leaderboard-filter="metric"><option value="rating"${selected(metric, 'rating')}>Skill rating</option><option value="wealth"${selected(metric, 'wealth')}>Wealth</option></select></label><label>Scope<select data-leaderboard-filter="scope"><option value="global"${selected(scope, 'global')}>Global</option><option value="region"${selected(scope, 'region')}>Your region</option></select></label><label>League<select data-leaderboard-filter="league"><option value="all"${selected(league, 'all')}>All leagues</option>${tiers.map(([name]) => `<option value="${name.toLowerCase()}"${selected(league, name.toLowerCase())}>${name}</option>`).join('')}</select></label><button class="mx-button secondary" type="button" data-leaderboard-action="refresh" ${state.status === 'loading' ? 'disabled' : ''}>${icon('refresh')} Refresh</button></div><div data-leaderboard-results aria-busy="${state.status === 'loading'}">${body}</div><div class="pg-leaderboard-note"><span>${icon('shield')} Skill = rating</span><span>${icon('coin')} Wealth = current holdings</span>${updated}</div>`, 'pg-live-leaderboard')}
    <div class="pg-grid pg-grid-two">${panel(`${sectionTitle('When your rank appears')}<ul class="pg-bullet-list"><li>Ten lifetime rated placements complete</li><li>Current-season qualification</li><li>Recent rated activity</li></ul><p class="pg-small mx-muted">Open-league players leave the public skill leaderboard after 28 days without rated activity and keep their Elo.</p>${button('Explore the leagues', '/ranked', 'secondary', 'shield')}`)}${playerIdentityCard(context)}</div>
  </div>`;
}

function rewardsPage(context) {
  const balances = isLinked(context) ? `<div class="pg-store-wallet pg-reward-balances"><span>${icon('coin')} Coins <strong>${numeric(context.profile?.wallet?.coins)}</strong></span><span>${icon('crown')} Crowns <strong>${numeric(context.profile?.wallet?.crowns)}</strong></span><span>${icon('star')} Cosmetic Credits <strong>${numeric(context.profile?.cosmeticCredits)}</strong></span></div>` : '';
  return `<div class="pg-page">${heading('GOOD MOVES GO FURTHER', 'Make every game count.', 'Earn through play. Your skill and your wallet stay independent.')}
    ${balances ? panel(balances) : ''}
    <div class="pg-grid pg-grid-three pg-wallet-grid">${feature('coin', 'Coins', 'Your everyday gameplay currency for Ranked entries and Coin tournament tables.', '<p class="pg-wallet-foot">New profiles start with <strong>150 Coins</strong>.</p>')}${feature('crown', 'Crowns', 'The same utility whether bought or earned. Use Crowns for rated direct challenges and Premium tables.', '<p class="pg-wallet-foot"><strong>10 Coins = 1 Crown</strong> in both directions.</p>')}${feature('star', 'Cosmetic Credits', 'Account-bound credits saved for future themes. They do not affect wealth or rating.', '<p class="pg-wallet-foot">Cannot be purchased, converted, transferred or staked.</p>')}</div>
    <div class="pg-grid pg-grid-two">${panel(`${sectionTitle('Build a daily rhythm', 'Reward-bearing games must meet the normal qualification rules.')}<div class="pg-reward-line"><span>${icon('check')} Daily quests</span><strong>Up to 30 Coins/day</strong></div><div class="pg-reward-line"><span>${icon('swords')} Bot wins</span><strong>Up to 20 Coins/day</strong></div><div class="pg-reward-line"><span>${icon('shield')} Ranked queue wins</span><strong>Up to 50 Coins/day</strong></div><p class="mx-muted">Bot rewards are 1 / 1 / 2 / 4 / 6 Coins for Beginner through Expert, with at most three rewarded wins at each difficulty.</p>${button('View your rewards in game', '/game', 'primary', 'coin')}`)}${panel(`${sectionTitle('A week well played', 'Weekly rewards recognise qualified activity.')}<p>Play five qualifying rated games, including three matchmade queue games against three unique opponents. Be active on three days and record at least three valid daily tier snapshots.</p><p class="mx-muted">The paid tier uses the lower of the end-of-week tier and lower median observed tier. Valid snapshot days determine the prorated payout.</p>${button('Season & weekly rules', '/season', 'secondary', 'trophy')}<div class="pg-divider"></div><a class="pg-text-link" href="/themes">Explore all four themes ${icon('arrow-right')}</a>`)}</div>
    ${note('Coins and Crowns cannot be cashed out or redeemed for real-world money. Local practice on this website does not mint account rewards.')}
    ${sessionPrompt(context, 'Sign in to view your balances and claimable account rewards.')}
  </div>`;
}

function themesPage() {
  const cards = themes.map(theme => panel('<div class="pg-theme-preview pg-theme-' + theme.id + '" style="--pg-preview-canvas:' + theme.canvas + ';--pg-preview-surface:' + theme.surface + ';--pg-preview-x:' + theme.x + ';--pg-preview-o:' + theme.o + ';--pg-preview-ink:' + theme.ink + ';--pg-preview-accent:' + theme.accent + '"><span class="pg-theme-label">' + theme.tagline + '</span><div class="pg-theme-board">' + Array.from({ length: 9 }, (_, i) => mini(i === 4 ? ['X', '', 'O', '', 'X', '', '', '', 'O'] : i === 0 ? ['X', 'O', '', '', '', '', '', '', ''] : Array(9).fill(''), i === 4 ? 'pg-theme-active' : '')).join('') + '</div><div class="pg-theme-swatches"><span style="background:' + theme.x + '"></span><span style="background:' + theme.o + '"></span><span style="background:' + theme.accent + '"></span></div></div><div class="pg-theme-copy"><div><h2>' + theme.name + '</h2><p>' + theme.copy + '</p></div><a class="mx-button secondary" href="/game">Open in game ' + icon('arrow-right') + '</a></div>', 'pg-theme-card')).join('');
  const soon = panel('<div class="pg-theme-preview pg-theme-soon" aria-hidden="true"><span class="pg-theme-label">New looks are on the way.</span><div class="pg-theme-board pg-theme-soon-board">' + icon('palette') + '</div></div><div class="pg-theme-copy"><div><h2>More coming soon!</h2><p>New appearances are in the works. Every future theme keeps the same board, legal moves and competitive balance.</p></div></div>', 'pg-theme-card pg-theme-soon-card');
  return '<div class="pg-page">' + heading('FIVE MOODS. ONE GAME.', 'Find your kind of focus.', 'Your board, your atmosphere. Every theme keeps the same rules, legal moves and competitive balance.')
    + '<div class="pg-grid pg-grid-two pg-theme-grid">' + cards + soon + '</div>'
    + note('Choose your browser theme with the Game theme control. Changing the atmosphere does not reset your match or turn timer.')
    + panel('<div class="pg-theme-future">' + icon('star') + '<div><h2>Credits for the future.</h2><p class="mx-muted">Your Cosmetic Credits are saved for future themes. All five browser appearances keep the same game and rules.</p></div><a class="pg-text-link" href="/rewards">Rewards ' + icon('arrow-right') + '</a></div>')
    + '</div>';
}

function profilePage(context) {
  const profile = isLinked(context) ? context.profile : null;
  const name = profile ? displayName(profile) : 'Your next chapter';
  const details = profile ? `<div class="pg-profile-rank">${rankImage(profile.tier, 'pg-account-rank')}<span>${tierName(profile.tier)}<small>${numeric(profile.rating, 2)} rating · ${numeric(profile.games)} games</small></span></div>` : '';
  const editor = profileEditorPanel(context, profile);
  return `<div class="pg-page">${heading('ONE PLAYER. EVERY PLATFORM.', 'Your identity stays with you.', 'A permanent player tag. Your friends, progression and settings. One profile across supported clients.')}
    <div class="pg-grid pg-grid-sidebar">${panel(`<div class="pg-profile-orb">${profile ? `<span>${e(String(name).slice(0, 1).toUpperCase())}</span>` : icon('user')}</div><h2>${e(name)}</h2><p class="mx-muted">${profile?.tag ? e(profile.tag) : 'Sign in to reveal your permanent MEGA tag.'}</p>${details}${button(profile ? 'View / edit your profile' : 'Sign in to your profile', profile ? '#profile-editor' : '/account', 'primary', 'user')}<div class="pg-divider"></div><p class="pg-small mx-muted">A username can change. Your stable player tag does not.</p>`, 'pg-self-card')}
      <div class="pg-stack">${panel(`${sectionTitle('Make it yours')}<div class="pg-grid pg-grid-two pg-profile-options"><div>${icon('user')}<h3>Name & username</h3><p>Update your display name and username from this signed-in profile. Your current avatar stays unchanged.</p></div><div>${icon('shield')}<h3>Visibility</h3><p>Control stats visibility and whether your online presence is shown.</p></div><div>${icon('cloud')}<h3>Cloud practice</h3><p>A linked account keeps your cloud practice save with your permanent identity.</p></div><div>${icon('star')}<h3>Cosmetic Credits</h3><p>View your account-bound balance, reserved for future themes.</p></div></div>${button('Open profile controls', '#profile-editor', 'secondary', 'arrow-right')}`)}${panel(`${linkRow('people', 'Your friends', 'View friends and invitations', '/friends')}${linkRow('settings', 'Account & recovery', 'Linked sign-in methods and security', '/account')}${linkRow('shield', 'Privacy choices', 'Export, visibility and deletion', '/privacy-choices')}`, 'pg-nav-panel')}</div>
    </div>
    ${editor}
  </div>`;
}

function profileEditorPanel(context, profile) {
  const state = context.profileEditor || {};
  const title = '<h2 id="profile-editor-title">Profile details & privacy</h2>';
  const heldDraft = ['refreshing','refresh-error'].includes(state.status) && state.actorId && state.draft;
  if (heldDraft && ['loading','error'].includes(context.sessionStatus)) {
    const message = context.sessionStatus === 'error'
      ? context.accountMessage || 'We could not confirm your current account. Your unsaved edits remain in this tab and are locked.'
      : 'Confirming your signed-in account. Your unsaved edits remain in this tab and are locked until the same account is verified.';
    return panel(`<section id="profile-editor" class="pg-profile-editor-state" aria-labelledby="profile-editor-title" aria-busy="${context.sessionStatus === 'loading' ? 'true' : 'false'}">${title}<p class="pg-form-message" data-profile-message role="status" aria-live="polite" tabindex="-1">${e(message)}</p><button class="mx-button secondary" type="button" data-account-action="retry">Retry account check</button></section>`, 'pg-profile-editor');
  }
  if (context.sessionStatus === 'loading') return panel(`<section id="profile-editor" class="pg-profile-editor-state" aria-labelledby="profile-editor-title" aria-busy="true">${title}<p class="pg-form-message" data-profile-message role="status" aria-live="polite" tabindex="-1">Checking your signed-in profile…</p></section>`, 'pg-profile-editor');
  if (context.sessionStatus === 'error') return panel(`<section id="profile-editor" class="pg-profile-editor-state" aria-labelledby="profile-editor-title">${title}<p class="pg-form-message" data-profile-message role="status" aria-live="polite" tabindex="-1">${e(context.accountMessage || 'Your account could not be checked.')}</p><button class="mx-button secondary" type="button" data-account-action="retry">Retry account check</button></section>`, 'pg-profile-editor');
  if (!profile) return panel(`<section id="profile-editor" class="pg-profile-editor-state" aria-labelledby="profile-editor-title">${title}<p>Sign in to load and edit your profile details.</p>${button('Sign in to edit your profile', '/account', 'primary', 'user')}</section>`, 'pg-profile-editor');

  if (state.actorId !== profile.id || state.status === 'idle' || state.status === 'loading' || !state.profile) {
    const message = state.status === 'error' ? state.message : 'Loading your protected profile details…';
    const retry = state.status === 'error' ? '<button class="mx-button secondary" type="button" data-profile-action="retry-load">Retry profile check</button>' : '';
    return panel(`<section id="profile-editor" class="pg-profile-editor-state" aria-labelledby="profile-editor-title" aria-busy="${state.status === 'loading' || state.status === 'idle' ? 'true' : 'false'}">${title}<p class="pg-form-message" data-profile-message role="status" aria-live="polite" tabindex="-1">${e(message || 'Loading your protected profile details…')}</p>${retry}</section>`, 'pg-profile-editor');
  }

  const draft = state.draft || {};
  const busy = ['saving','refreshing','refresh-error'].includes(state.status);
  const disabled = busy ? ' disabled' : '';
  const option = (value, label, current) => `<option value="${value}"${current === value ? ' selected' : ''}>${label}</option>`;
  const message = state.message ? `<p class="pg-form-message" data-profile-message role="status" aria-live="polite" tabindex="-1">${e(state.message)}</p>` : '<p class="pg-form-message" data-profile-message role="status" aria-live="polite" tabindex="-1" hidden></p>';
  const keepUsername = state.errorCode === 'USERNAME_COOLDOWN' && draft.username !== state.profile.username
    ? '<button class="pg-text-button" type="button" data-profile-action="keep-username">Use your current username and keep the other edits</button>' : '';
  const retryRefresh = state.status === 'refresh-error' ? '<button class="pg-text-button" type="button" data-profile-action="retry-refresh">Retry profile refresh</button>' : '';
  return panel(`<section id="profile-editor" class="pg-profile-editor-state" aria-labelledby="profile-editor-title" aria-busy="${busy ? 'true' : 'false'}">${title}
    <p class="pg-profile-editor-intro">Update the details and visibility settings attached to your signed-in account. Your permanent player tag and game progress stay with this profile.</p>
    <form class="pg-profile-form" data-profile-form>
      <label for="profile-username">Username</label>
      <input id="profile-username" name="username" type="text" value="${e(draft.username || '')}" minlength="3" maxlength="20" pattern="[A-Za-z][A-Za-z0-9_]{2,19}" autocomplete="username" autocapitalize="none" spellcheck="false" required aria-describedby="profile-username-help"${disabled}>
      <p class="pg-profile-help" id="profile-username-help">3–20 letters, numbers or underscores; start with a letter. Username changes are limited to once every 7 days.</p>
      <label for="profile-display-name">Display name</label>
      <input id="profile-display-name" name="displayName" type="text" value="${e(draft.displayName || '')}" maxlength="28" autocomplete="nickname" required aria-describedby="profile-display-name-help"${disabled}>
      <p class="pg-profile-help" id="profile-display-name-help">Up to 28 characters. This is the name shown around Mega XOXO.</p>
      <label for="profile-stats-visibility">Stats visibility</label>
      <select id="profile-stats-visibility" name="statsVisibility" required aria-describedby="profile-stats-help"${disabled}>${option('public', 'Public', draft.statsVisibility)}${option('friends', 'Friends', draft.statsVisibility)}${option('private', 'Private', draft.statsVisibility)}</select>
      <p class="pg-profile-help" id="profile-stats-help">Choose who can view your profile statistics.</p>
      <label for="profile-presence-visibility">Online presence</label>
      <select id="profile-presence-visibility" name="presenceVisibility" required aria-describedby="profile-presence-help"${disabled}>${option('friends', 'Friends only', draft.presenceVisibility)}${option('hidden', 'Hidden', draft.presenceVisibility)}</select>
      <p class="pg-profile-help" id="profile-presence-help">Choose whether friends can see when you are online.</p>
      ${message}
      ${retryRefresh}
      ${keepUsername}
      <div class="pg-actions"><button class="mx-button primary" type="submit"${disabled}>${state.status === 'saving' ? 'Saving your profile…' : state.status === 'refreshing' ? 'Confirming your account…' : state.status === 'refresh-error' ? 'Profile refresh needs a retry' : 'Save profile changes'}</button><button class="mx-button secondary" type="button" data-profile-action="discard"${disabled}>Reset unsaved edits</button></div>
      <p class="pg-profile-avatar-note">Your current avatar is unchanged. Avatar selection is not available on this website.</p>
    </form>
  </section>`, 'pg-profile-editor');
}


function accountPage(context) {
  const linked = isLinked(context);
  const view = ['email', 'verify', 'recover', 'reset'].includes(context.accountView) ? context.accountView : 'email';
  const busy = Boolean(context.accountBusy);
  const disabled = busy ? ' disabled' : '';
  const providerDisabled = name => busy || context.providers?.[name]?.web !== true ? ' disabled' : '';
  const message = context.accountMessage ? `<p class="pg-form-message" role="status" aria-live="polite">${e(context.accountMessage)}</p>` : '';
  const emailInput = `<label>Email address<input type="email" name="email" autocomplete="email" maxlength="254" value="${e(context.accountEmail || '')}" required></label>`;
  const email = `<form class="pg-account-form" data-account-form="email">${emailInput}<label>Password<input type="password" name="password" autocomplete="current-password" minlength="10" maxlength="256" required></label><button class="mx-button primary" type="submit"${disabled}>${icon('mail')} ${busy ? 'Continuing…' : 'Continue with email'}</button><button class="pg-text-button" type="button" data-account-action="view" data-account-view="recover">Forgot password?</button></form>`;
  const verify = `<form class="pg-account-form" data-account-form="verify"><p>Enter the six-digit code sent to your mailbox. Codes expire after ten minutes.</p><label>Verification code<input name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required></label><button class="mx-button primary" type="submit"${disabled}>${icon('check')} Verify email</button><button class="pg-text-button" type="button" data-account-action="resend"${disabled}>Resend code</button><button class="pg-text-button" type="button" data-account-action="view" data-account-view="email">Back to email sign-in</button></form>`;
  const recover = `<form class="pg-account-form" data-account-form="recover"><p>Request a password-reset code for your verified email account.</p>${emailInput}<button class="mx-button primary" type="submit"${disabled}>${icon('mail')} Send recovery code</button><button class="pg-text-button" type="button" data-account-action="view" data-account-view="email">Back to sign in</button></form>`;
  const reset = `<form class="pg-account-form" data-account-form="reset"><label>Recovery code<input name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required></label><label>New password<input name="password" type="password" autocomplete="new-password" minlength="10" maxlength="256" required></label><label>Confirm new password<input name="confirmPassword" type="password" autocomplete="new-password" minlength="10" maxlength="256" required></label><p class="pg-small mx-muted">Use at least ten characters, including a letter and a number.</p><button class="mx-button primary" type="submit"${disabled}>${icon('shield')} Reset password</button><button class="pg-text-button" type="button" data-account-action="view" data-account-view="email">Back to sign in</button></form>`;
  let account;
  if (context.sessionStatus === 'loading') account = `<div class="pg-loading-state" role="status">${icon('refresh')}<h2>Checking your account…</h2><p>Restoring your current session.</p></div>`;
  else if (context.sessionStatus === 'error') account = `${empty('shield', 'We could not check your account.', 'Retry to restore your session before continuing.', `<button class="mx-button primary" type="button" data-account-action="retry">${icon('refresh')} Retry account check</button>`)}`;
  else if (linked) account = `<div class="pg-account-emblem" aria-hidden="true">${icon('user')}</div><h2>${e(displayName(context.profile))}</h2><p class="pg-account-tag">${e(context.profile?.tag || '')}</p>${rankImage(context.profile?.tier, 'pg-account-rank')}<p class="mx-muted">${tierName(context.profile?.tier)} · ${numeric(context.profile?.rating, 2)} rating</p>${button('Your profile', '/profile', 'primary', 'user')}${button('Linked accounts & recovery', '/game', 'secondary', 'shield')}<button class="pg-text-button" type="button" data-account-action="logout">Sign out</button>${researchConsentCard(context)}${message}`;
  else account = `<div class="pg-account-emblem" aria-hidden="true">${icon('user')}</div><h2>${view === 'verify' ? 'Verify your email' : view === 'recover' ? 'Recover your profile' : view === 'reset' ? 'Choose a new password' : 'Continue to Mega XOXO'}</h2>${view === 'email' ? '<p class="pg-small mx-muted">Sign in to play online.</p>' : ''}${message}${{ email, verify, recover, reset }[view]}${view === 'email' ? `<div class="pg-auth-divider"><span>or continue with</span></div><div class="pg-provider-actions"><button type="button" class="mx-button secondary" data-account-action="provider" data-provider="google"${providerDisabled('google')}>Google</button><button type="button" class="mx-button secondary" data-account-action="provider" data-provider="apple"${providerDisabled('apple')}>${icon('apple')} Apple</button></div><p class="pg-small mx-muted">Already have a profile? Sign in with your email. New here? Verify your email to create one.</p>` : ''}`;
  return `<div class="pg-page">${heading('YOUR GAME COMES WITH YOU', linked ? 'Keep your profile close.' : 'Welcome to your next move.', 'One identity for your friends, your rank and your progress across supported web, iOS and Android clients.')}
    <div class="pg-grid pg-grid-two pg-account-grid">${panel(account, 'pg-account-card pg-auth-card')}
      ${panel(`${sectionTitle('One profile. A few ways in.')}<div class="pg-account-method">${icon('mail')}<div><h3>Continue with email</h3><p>Existing players sign in. New players verify mailbox ownership with a six-digit code before the profile is created.</p></div></div><div class="pg-account-method">${icon('shield')}<div><h3>Use a linked sign-in method</h3><p>Continue with Google or Apple to access the same permanent profile. Link recovery methods to keep it secure.</p></div></div><div class="pg-account-method">${icon('refresh')}<div><h3>Recover your account</h3><p>Choose Forgot password when signing in with email. Support will never ask for your password or verification code.</p></div></div><a class="pg-text-link" href="/privacy-choices">Understand your data choices ${icon('arrow-right')}</a>`, 'pg-account-info')}</div>

  </div>`;
}

function storePage(context) {
  const state = context.products || { status: 'error', rows: [] };
  const allowed = { crowns_100: { title: '100 Crowns', amount: 100 }, crowns_525: { title: '525 Crowns', amount: 525 }, crowns_1100: { title: '1,100 Crowns', amount: 1100 }, remove_ads: { title: 'Remove Ads', amount: 0 } };
  const rows = state.status === 'ready' && Array.isArray(state.rows) ? state.rows.filter(row => row && Object.hasOwn(allowed, row.id)) : [];
  /* A2: the price precedence is the native localized price, then the server web quote (Polar minor
   * units formatted by the normalizer), then the Cashfree INR amount. A missing price never
   * becomes a zero or an estimate; the action simply stays disabled. */
  const priceText = row => typeof row.localizedPrice === 'string' && row.localizedPrice.trim() ? row.localizedPrice : typeof row.polarPrice === 'string' && row.polarPrice.trim() ? row.polarPrice : typeof row.inr === 'string' && row.inr.trim() ? '₹' + row.inr : null;
  const webReady = state.webCheckoutAvailable === true;
  const passState = state.pass && typeof state.pass === 'object' ? state.pass : { active: false, periodEnd: null, cancelAtPeriodEnd: false };
  const purchaseButton = row => {
    const price = priceText(row);
    const available = row.owned !== true && Boolean(price) && ((state.purchasesAvailable === true && row.enabled === true) || webReady);
    if (!isLinked(context)) return context.sessionStatus === 'loading' ? '<button class="mx-button secondary" type="button" disabled>Checking your account…</button>' : button('Sign in to continue', '/account', 'secondary', 'user');
    if (row.owned === true) return '<span class="mx-chip">Owned</span>';
    const label = available ? (row.localizedPrice ? 'Purchase options' : row.inr ? 'Buy · UPI or card' : 'Buy now') : 'Unavailable here';
    return '<button class="mx-button ' + (available ? 'primary' : 'secondary') + '" type="button" data-store-action="purchase" data-product-id="' + row.id + '"' + (available ? '' : ' disabled') + '>' + label + '</button>';
  };
  let products;
  if (state.status === 'loading') products = '<div class="pg-loading-state" role="status">' + icon('refresh') + '<h2>Loading the store…</h2><p>Checking current availability and prices.</p></div>';
  else if (state.status === 'error') {
    /* A2: a failed read never wipes the page - the known product descriptions stay visible
     * without prices, with one inline retry for the real failed fetch. */
    const fallbackRows = Object.keys(allowed).map(id => ({ id, owned: false }));
    products = '<p class="pg-store-error" role="status">The store could not be checked just now — prices are hidden and actions are off until a retry succeeds. <button class="mx-button secondary" type="button" data-store-action="refresh">' + icon('refresh') + ' Retry store check</button></p><div class="pg-grid pg-grid-four pg-store-grid">' + fallbackRows.map(row => {
      const item = allowed[row.id];
      return panel('<div class="pg-store-art" aria-hidden="true">' + icon(item.amount ? 'crown' : 'shield') + '</div>' + pill(item.amount ? 'CROWN PACK' : 'PERMANENT AD REMOVAL') + '<h2>' + item.title + '</h2><p>' + (item.amount ? 'Works the same way in the game as earned Crowns.' : 'Turn off automatic ads where supported. Optional rewarded ads remain a separate choice.') + '</p><div class="pg-store-price"><span class="mx-muted">Price unavailable</span></div><button class="mx-button secondary" type="button" disabled>Unavailable here</button>', 'pg-store-card');
    }).join('') + '</div>';
  }
  else if (!rows.length) products = empty('crown', 'No products are available here yet.', 'Check back for products and prices available on your platform.');
  else products = '<div class="pg-grid pg-grid-four pg-store-grid">' + rows.map(row => {
    const item = allowed[row.id], price = priceText(row);
    const overlap = row.id === 'remove_ads' && passState.active === true ? '<p class="pg-small mx-muted">Your Mega Pass already keeps automatic ads off. This permanent removal keeps working after the pass ends.</p>' : '';
    return panel('<div class="pg-store-art" aria-hidden="true">' + icon(item.amount ? 'crown' : 'shield') + '</div>' + pill(item.amount ? 'CROWN PACK' : 'PERMANENT AD REMOVAL') + '<h2>' + item.title + '</h2><p>' + (item.amount ? 'Works the same way in the game as earned Crowns.' : 'Turn off automatic ads where supported. Optional rewarded ads remain a separate choice.') + '</p>' + overlap + '<div class="pg-store-price">' + (price ? e(price) : '<span class="mx-muted">Price unavailable</span>') + '</div>' + purchaseButton(row), 'pg-store-card');
  }).join('') + '</div>';
  const passRow = state.status === 'ready' && Array.isArray(state.rows) ? (state.rows.find(row => row && row.id === 'mega_pass') || null) : null;
  const passOwned = passState.active === true || (passRow ? passRow.owned === true : false);
  const passPrice = passRow ? priceText(passRow) : null;
  const passAvailable = Boolean(passRow && passRow.owned !== true && passState.active !== true && ((state.purchasesAvailable === true && passRow.enabled === true) || (webReady && (passRow.polarPrice || passRow.inr))));
  const passAction = !isLinked(context)
    ? (context.sessionStatus === 'loading' ? '<button class="mx-button secondary" type="button" disabled>Checking your account…</button>' : button('Sign in to subscribe', '/account', 'secondary', 'user'))
    : passOwned
      ? '<span class="mx-chip">Active — thank you!</span>'
      : '<button class="mx-button ' + (passAvailable ? 'primary' : 'secondary') + '" type="button"' + (passAvailable ? ' data-store-action="purchase" data-product-id="mega_pass"' : '') + (passAvailable ? '' : ' disabled') + '>' + (passAvailable ? 'Subscribe · renews monthly' : 'Unavailable here') + '</button>';
  const passPeriod = passOwned && passState.periodEnd ? '<p class="pg-small mx-muted">Your pass is paid through ' + new Date(passState.periodEnd).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) + (passState.cancelAtPeriodEnd ? ' and will not renew.' : '.') + '</p>' : (passOwned ? '' : '<p class="pg-small mx-muted">Auto-renewing subscription. Cancel anytime in your store subscriptions. Crowns and Coins you already have are kept if the pass lapses.</p>');
  const passPanel = '<div class="pg-pass-panel" data-mega-pass><div class="pg-pass-media"><img class="pg-pass-art" src="/assets/art/mega-pass.webp" alt="" loading="lazy" width="768" height="481"></div><div class="pg-pass-copy"><span class="mx-chip">MEGA PASS · MONTHLY</span><h2>Mega Pass</h2><ul class="pg-pass-benefits"><li>150 Crowns every billing month, delivered 50 on days 1, 11 and 21</li><li>2× Coins from bot wins — daily caps still apply</li><li>Coin-to-Crown exchange at 8:1 for the first 200 Coins each month</li><li>15% off up to two Crown packs per month</li><li>Automatic ads off; rewarded ads stay your choice</li></ul><div class="pg-pass-action"><div class="pg-store-price pg-pass-price">' + (passPrice ? e(passPrice) + '<span class="pg-pass-period">/ month</span>' : '<span class="mx-muted">Price unavailable</span>') + '</div>' + passAction + '</div>' + passPeriod + '</div></div>';
  const wallet = isLinked(context) ? panel('<div class="pg-store-wallet"><span>' + icon('coin') + ' Coins <strong>' + numeric(context.profile?.wallet?.coins) + '</strong></span><span>' + icon('crown') + ' Crowns <strong>' + numeric(context.profile?.wallet?.crowns) + '</strong></span>' + (passState.active === true ? '<span class="mx-chip">Mega Pass active</span>' : '') + button('Your rewards', '/rewards', 'secondary', 'arrow-right') + '</div>') : sessionPrompt(context, 'Link your permanent profile before making a purchase.');
  return '<div class="pg-page">' + heading('MORE POSSIBILITIES. THE SAME SKILL.', 'Your game, your choice.', 'The monthly Mega Pass, Crown packs and permanent Remove Ads in one store. Purchases never change Elo, legal moves or competitive balance.')
    + passPanel
    + wallet
    + '<div data-store-products>' + products + '</div>'
    + note('Prices come from your store’s current catalog. Coins and Crowns cannot be cashed out or redeemed for real-world money. For a store issue, include the platform, product and approximate purchase time. <a class="pg-text-link" href="/support">Purchase support</a>.')
    + '</div>';
}

function sponsorsPage(context) {
  const topics = ['Strategy games', 'Technology', 'Creative tools', 'Learning', 'Gaming gear', 'Entertainment'];
  const preferences = context.sponsorPreferences || {};
  const chosen = Array.isArray(preferences.interests) ? preferences.interests.filter(topic => topics.includes(topic)) : [];
  /* D1: the compact disclosure replaces the two large panels (comment 3 removes the duplicate).
   * A saved message keeps it open so the focus stays with the form after save or clear. */
  const interests = '<details class="pg-sponsor-disclosure"' + (context.sponsorMessage ? ' open' : '') + '><summary>Ad interests (optional)' + (chosen.length ? ' · ' + chosen.length + ' saved' : '') + '</summary><form class="pg-sponsor-form" data-sponsor-preferences><fieldset><legend>Topics you would like to see</legend><div class="pg-interest-grid">' + topics.map(topic => '<label><input type="checkbox" name="interest" value="' + e(topic) + '"' + (chosen.includes(topic) ? ' checked' : '') + '><span>' + topic + '</span></label>').join('') + '</div></fieldset><label class="pg-consent-checkbox"><input type="checkbox" name="consent" required' + (preferences.consent === true ? ' checked' : '') + '><span>I agree to save these optional interest preferences in this browser. This does not enable advertising tracking.</span></label><button class="mx-button secondary" type="submit">' + icon('check') + ' Save my choices</button><button class="pg-text-button" type="button" data-sponsor-action="clear">Clear saved choices</button><p class="pg-form-message" role="status" data-sponsor-message>' + e(context.sponsorMessage || '') + '</p></form></details>';
  const slot = (id, title, copy, symbol) => panel('<span class="pg-ad-label">Advertisement</span><div class="pg-ad-slot" data-sponsor-slot="' + id + '" aria-label="Advertisement space">' + icon(symbol) + '<span>No active sponsor</span></div><h2>' + title + '</h2><p class="mx-muted">' + copy + '</p>', 'pg-sponsor-card');
  const slots = [
    slot('sponsors-featured', 'Featured sponsor', 'New supporters will appear here. Check back to discover what’s next.', 'globe'),
    slot('sponsors-community', 'From our community', 'Community supporters will appear here. Visiting one is always optional.', 'people'),
    slot('sponsors-discover', 'Discover something new', 'A rotating sponsor slot. Clearly labeled and never part of the game.', 'star'),
    slot('sponsors-spotlight', 'Sponsored spotlight', 'A reserved placement for approved sponsors and launches.', 'crown'),
    slot('sponsors-pick', 'Editor’s pick', 'Hand-picked tools and reading for the Mega XOXO community.', 'shield'),
    slot('sponsors-next', 'Coming up next', 'More sponsor placements roll in as the community grows.', 'trophy'),
  ];
  const banner = '<div class="pg-ad-banner" data-sponsor-slot="sponsors-leaderboard" role="complementary" aria-label="Advertisement space"><span class="pg-ad-label">Advertisement</span><div class="pg-ad-slot pg-ad-wide"><span class="pg-ad-placeholder">Your brand in front of the sharpest players on the internet. <a class="pg-text-link" href="/support">Become a sponsor</a>.</span></div></div>';
  return '<div class="pg-page pg-sponsors-page">' + heading('A LITTLE SUPPORT FOR A BIGGER GAME', 'Discover our supporters.', 'Optional, clearly labeled sponsorship can help support Mega XOXO. Your game and your competitive standing stay independent.')
    + banner
    + '<div class="pg-grid pg-grid-three pg-sponsor-grid">' + slots.join('') + '</div>'
    + panel('<div class="pg-sponsor-preferences"><h2>Your advertising interests</h2><p class="mx-muted">Optional interests, saved only in this browser after you agree. They never enable third-party tracking and never change your gameplay.</p>' + interests + '<p class="pg-small mx-muted">Change or clear them any time. <a class="pg-text-link" href="/privacy-choices">Privacy choices</a>.</p></div>', 'pg-sponsor-preferences-panel')
    + '</div>';
}

function howToPlayPage() {
  return `<div class="pg-page">${heading('BIGGER MOVES. BRIGHTER MINDS.', 'Small boards. Big decisions.', 'Win the small boards to win the big one. Every move also decides where your opponent plays next.')}
    <div class="pg-grid pg-grid-three pg-tutorial-grid">${panel(`<span class="pg-step">01</span>${mini(['X', 'X', 'X', '', 'O', '', 'O', '', ''])}<h2>Win a small board.</h2><p>Place three of your marks in a row, column or diagonal to claim a small board.</p>`, 'pg-tutorial-card')}${panel(`<span class="pg-step">02</span><div class="pg-routing-art" aria-hidden="true">${mini(['', '', '', '', '', '', '', '', 'X'], 'pg-route-from')}${icon('arrow-right')}${mini(Array(9).fill(''), 'pg-route-to')}</div><h2>Send the next move.</h2><p>The cell you choose sends your opponent to the corresponding small board. Bottom-right cell? They play the bottom-right board.</p>`, 'pg-tutorial-card')}${panel(`<span class="pg-step">03</span>${mini(['X', 'O', '', '', 'X', '', '', '', 'X'], 'pg-macro-demo')}<h2>Win the big board.</h2><p>Claim three small boards in a row, column or diagonal to win the match.</p>`, 'pg-tutorial-card')}</div>
    <div class="pg-grid pg-grid-two">${panel(`${sectionTitle('Every move has a destination.')}<p>The first player may choose any empty cell. After that, the highlighted board tells you where to play. Occupied cells are never legal moves.</p><p class="mx-muted">If the destination board is already won or drawn, the next player may choose any unfinished board. A full small board without a winning line is drawn.</p>${shortList(['A cell chooses both your mark and your opponent’s destination.', 'Won and drawn small boards are closed to further moves.', 'If all small boards finish without a big-board line, the match is drawn.'])}`)}${panel(`<span class="mx-eyebrow">LEARN BY DOING</span><h2>Still finding your way?</h2><p class="mx-muted">Play a short guided tutorial. We’ll show you where to move, how the next board is chosen, and how small-board wins connect.</p>${button('Play the guided tutorial', '/game?tutorial=guided', 'primary', 'arrow-right')}<div class="pg-divider"></div><p class="pg-small mx-muted">Six guided moves. No account or timer. Pause, restart, or leave whenever you like.</p>${button('Practice with bots', '/game?mode=bot', 'secondary', 'arrow-right')}`, 'pg-tutorial-cta')}</div>
  </div>`;
}

function supportPage() {
  const faqs = [
    ['How do I sign in or recover my profile?', 'Open the game and use Continue with email, Google or Apple. For an email password reset, choose Forgot password. Never share your password or six-digit code with support.'],
    ['Why does online play ask me to sign in?', 'Online play uses a linked permanent identity. A guest can practice locally; sign in to keep rank, wallet, friends and progression with one profile.'],
    ['Why did the move send me to another board?', 'The cell chosen by your opponent sets your next small board. If that board is already won or drawn, you can choose any unfinished board.'],
    ['How do I get help with a store purchase?', 'If purchases are enabled in your build, include the store platform, product name and approximate purchase time. Refund handling follows the applicable Apple or Google process. Do not send full receipts or card details.'],
    ['How do I report player conduct?', 'Use the in-game report feature where available so the report is connected to the correct player and category. Contact support for account-security concerns.'],
  ];
  return `<div class="pg-page">${heading('LET’S GET YOU BACK TO THE BOARD', 'A little help for your next move.', 'Account access, gameplay, purchases or privacy. Start here.')}
    <div class="pg-grid pg-grid-sidebar">${panel(`<div class="pg-feature-icon">${icon('mail')}</div><h2>Talk to the developer.</h2><p class="mx-muted">Mega XOXO is developed by Antimatter Innovations.</p>${button('Email support', 'mailto:contact@antimatterinnovations.com', 'primary', 'mail')}<p class="pg-small pg-contact">contact@antimatterinnovations.com</p><div class="pg-divider"></div><h3>Include what helps.</h3><p class="pg-small mx-muted">Your platform, app version, the action you tried and an MX- support code if one appeared.</p><p class="pg-small mx-muted">Do not include passwords, OTPs, session cookies, private keys or full payment receipts.</p>`, 'pg-support-contact')}${panel(`${sectionTitle('Frequently asked questions')}<div class="pg-faq">${faqs.map(([question, answer]) => `<details><summary>${question}${icon('chevron-right')}</summary><p>${answer}</p></details>`).join('')}</div>`)}</div>
    <div class="pg-grid pg-grid-three">${feature('help', 'Learn the game', 'Understand small boards, routes and the big-board win.', `<a class="pg-text-link" href="/how-to-play">How to play ${icon('arrow-right')}</a>`)}${feature('shield', 'Manage your data', 'Find visibility, export and account-deletion guidance.', `<a class="pg-text-link" href="/privacy-choices">Privacy choices ${icon('arrow-right')}</a>`)}${feature('globe', 'Connection help', 'Know where to check if your online connection is interrupted.', `<a class="pg-text-link" href="/status">Service information ${icon('arrow-right')}</a>`)}</div>
  </div>`;
}

function aboutPage() {
  return `<div class="pg-page">${heading('BY ANTIMATTER INNOVATIONS', 'A familiar game. A bigger idea.', 'Mega XOXO turns the smallest move into a decision that shapes the whole board.')}
    ${panel(`<div class="pg-about-symbol" aria-hidden="true"><span>×</span><span>○</span><span>×</span><span>○</span></div><div class="pg-about-copy"><span class="mx-eyebrow">BIGGER MOVES. BRIGHTER MINDS.</span><h2>Think one board ahead.</h2><p>Win small boards to build a line on the big one. Choose a cell and send your opponent to their next board. A simple rule opens up an entirely different kind of strategy.</p>${actions(button('Play now', '/play', 'primary', 'arrow-right'), button('Learn the rules', '/how-to-play', 'secondary', 'help'))}</div>`, 'pg-about-hero')}
    <div class="pg-grid pg-grid-three">${feature('swords', 'Competition through skill', 'Elo follows rated results. Currency, purchase history and stake size never create a skill advantage.')}${feature('cloud', 'A profile that stays with you', 'One permanent identity, designed to carry your progression and connections across supported clients.')}${feature('palette', 'Your game. Your atmosphere.', 'Five browser themes. The same board, legal moves and competitive rules.')}</div>
    ${panel(`<div class="pg-about-footer"><div><span class="mx-eyebrow">THE DEVELOPER</span><h2>Antimatter Innovations</h2><p class="mx-muted">Questions, account help or feedback: contact@antimatterinnovations.com</p></div>${button('Get in touch', '/support', 'secondary', 'mail')}</div>`)}
  </div>`;
}

function accessibilityPage() {
  return `<div class="pg-page pg-reading-page">${heading('A BOARD FOR YOUR NEXT MOVE', 'Play at your own pace.', 'Keyboard access, clear game states and motion preferences help keep the focus on the game.')}
    <div class="pg-grid pg-grid-two">${feature('monitor', 'Keyboard navigation', 'Use Tab and Shift + Tab to move between controls. Enter follows links. Space or Enter activates buttons. The website includes a skip link to main content.')}${feature('settings', 'Motion preferences', 'This website respects your system’s reduced-motion setting. Decorative movement and nonessential transitions are removed when reduced motion is requested.')}${feature('help', 'Clear controls', 'Interactive controls use text labels or accessible names. X and O keep distinct shapes, and local-practice cells expose their board, position and move state.')}${feature('palette', 'Presentation choices', 'Play with Mega XOXO Neon on the web or choose one of the four original palettes in the game. A theme changes presentation while the rules stay the same.')}</div>
    ${panel(`${sectionTitle('Local practice controls')}<p>Use Tab to enter the board. Arrow keys move across the visual nine-by-nine grid and wrap at its edges. Home and End move to the first or last cell in the current visual row. Press Enter or Space to place a legal move.</p><p class="mx-muted">The nine small boards and each cell have accessible names. A polite live status reports turns, wins and draws. Difficulty, restart, local two-player and theme controls use labeled native controls.</p>${button('Try local practice', '/game?mode=bot', 'primary', 'arrow-right')}`)}
    ${panel(`${sectionTitle('Tell us what gets in your way')}<p>If a control, device or assistive technology makes the website difficult to use, contact Antimatter Innovations. Include the page, browser or device, the action attempted and the accessibility tool used.</p><p class="mx-muted">This page documents available controls. It does not claim independent accessibility certification.</p>${button('Contact support', '/support', 'secondary', 'mail')}`)}
  </div>`;
}

function legalPage(type) {
  const privacy = type === 'privacy';
  const title = privacy ? 'Your privacy matters.' : 'Know the rules of the platform.';
  return `<div class="pg-page pg-reading-page">${heading(privacy ? 'PRIVACY & TRANSPARENCY' : 'TERMS & RESPONSIBILITIES', title, privacy ? 'Understand account information, gameplay records and the choices available to you.' : 'Read the terms covering your account, competitive play, virtual currency and supported services.')}
    ${panel(`<h2>${privacy ? 'Privacy Policy' : 'Terms of Service'}</h2><p>Read how Mega XOXO handles your information and the terms that apply when you use the game.</p><p class="mx-muted">Read the full document for details and contact information.</p>${button(`Read the full ${privacy ? 'Privacy Policy' : 'Terms'}`, `/legal/${type}`, 'primary', 'arrow-right')}`, 'pg-legal-card')}
    ${panel(`${sectionTitle('Your next steps')}${linkRow('shield', 'Privacy choices', 'Profile visibility, data export and deletion', '/privacy-choices')}${linkRow('user', 'Account deletion', 'The permanent deletion process', '/delete-account')}${linkRow('mail', 'Contact the developer', 'Privacy or account questions', '/support')}`, 'pg-nav-panel')}
  </div>`;
}

function deletionPage() {
  return `<div class="pg-page pg-reading-page">${heading('ACCOUNT & DATA', 'A clear way to leave.', 'Account deletion is permanent. You must sign in and verify your identity before submitting the request.')}
    ${panel(`${sectionTitle('Delete from Mega XOXO')}<ol class="pg-numbered-list"><li><span>1</span><div><strong>Open your account.</strong><p>Sign in to the profile you want to delete.</p></div></li><li><span>2</span><div><strong>Find your privacy controls.</strong><p>Open Your profile, then Linked accounts &amp; recovery.</p></div></li><li><span>3</span><div><strong>Choose Delete account.</strong><p>Complete recent identity verification when requested.</p></div></li><li><span>4</span><div><strong>Confirm the exact player tag.</strong><p>Read the permanent deletion confirmation before submitting.</p></div></li></ol>${button('Open account controls', '/game', 'primary', 'user')}`)}
    ${panel(`<h2>What deletion means</h2><p>Deletion removes sign-in methods, profile, cloud practice save, social connections and active account data. Minimum historical records may be retained in pseudonymized form for purchase integrity, security, moderation or legal obligations under the applicable policy and retention schedule.</p><p class="mx-muted">A later sign-in does not restore the deleted profile. Read the full maintained instructions and the current policy status before proceeding.</p>${actions(button('Full deletion instructions', '/legal/delete-account', 'secondary', 'arrow-right'), button('Privacy Policy', '/privacy', 'secondary', 'shield'))}`, 'pg-copy-panel')}
    ${note('If you cannot reach the deletion control after signing in, contact contact@antimatterinnovations.com. Do not send your password or verification code.', 'mail')}
  </div>`;
}

function privacyChoicesPage() {
  return `<div class="pg-page">${heading('YOUR PROFILE. YOUR CHOICES.', 'Stay in control.', 'Find account privacy controls, data access and the permanent deletion process in one place.')}
    <div class="pg-grid pg-grid-two">${feature('user', 'Profile visibility', 'Choose stats visibility and online-presence visibility from your signed-in profile.', button('Open profile controls', '/profile', 'secondary', 'user'))}${feature('download', 'Download your data', 'Request a copy of your account data after signing in and verifying your identity again.', button('Open privacy controls', '/game', 'secondary', 'download'))}${feature('shield', 'Advertising privacy', 'Advertising and consent options vary by app version and platform. Open your app’s privacy controls to see the choices available.', `<a class="pg-text-link" href="/legal/privacy-choices">Read the full privacy choices ${icon('arrow-right')}</a>`)}${feature('user', 'Permanent deletion', 'Review the process and confirm your exact player tag in your verified account.', button('Deletion instructions', '/delete-account', 'secondary', 'arrow-right'))}</div>
    <div data-metrics-host></div>
    ${panel(`<div class="pg-about-footer"><div><h2>Need help with a privacy request?</h2><p class="mx-muted">Contact Antimatter Innovations if your request cannot be completed through the available controls.</p></div>${button('Contact support', '/support', 'primary', 'mail')}</div>`)}
  </div>`;
}

function statusPage() {
  return `<div class="pg-page">${heading('CONNECTION & SERVICE INFORMATION', 'Keep your next move in sight.', 'Find connection details in your game, try local practice, or get help with a persistent problem.')}
    ${panel(`<div class="pg-status-summary">${icon('globe')}<div><span class="mx-eyebrow">ONLINE CONNECTION</span><h2>Stay connected to the board.</h2><p class="mx-muted">Open Mega XOXO to see the game’s current connection state and any service message.</p></div>${button('Open Mega XOXO', '/game', 'primary', 'arrow-right')}</div>`)}
    <div class="pg-grid pg-grid-three">${feature('user', 'Asked to sign in?', '“Sign in to play online” means your profile needs to be linked. Continue through the account flow.')}${feature('refresh', 'Connection interrupted?', 'Check your connection, then return to the game. The game handles supported reconnection and resume flows.')}${feature('monitor', 'Offline right now?', 'Local practice is available while online features need a connection.', `<a class="pg-text-link" href="/game?mode=bot">Start practice ${icon('arrow-right')}</a>`)}</div>
    ${note('For a persistent error, include the MX- support code, platform and action attempted. Do not send authenticated network traces or session cookies.')}
    ${actions(button('Get support', '/support', 'secondary', 'mail'))}
  </div>`;
}

function newsPage() {
  return `<div class="pg-page">${heading('FROM THE DEVELOPER', 'Your next chapter starts here.', 'Release information and product notes from Mega XOXO by Antimatter Innovations.')}
    <div class="pg-grid pg-grid-sidebar"><aside>${panel(`<div class="pg-feature-icon">${icon('refresh')}</div><h2>Product notes</h2><p class="mx-muted">A place for game updates, appearance notes and information from the developer.</p>${button('Back to play', '/play', 'secondary', 'arrow-right')}`)}</aside><div class="pg-stack">${panel(`<span class="mx-chip">Current game release</span><h2>Mega XOXO v4.1.2</h2><p>Sign in to play online and keep your friends, rank and rewards with your permanent profile.</p><p class="mx-muted">Guests can practice locally. When you are ready for online play, continue with email, Google or Apple inside the game.</p>${button('Open Mega XOXO', '/game', 'primary', 'globe')}`, 'pg-news-article')}${panel(`<span class="mx-eyebrow">THE GAME YOU KNOW</span><h2>Five browser appearances. One set of rules.</h2><p>Mega XOXO Neon joins Vector Light, Midnight Club, Paper Club and After Hours on the web. Every appearance keeps the same legal moves and competitive balance.</p><a class="pg-text-link" href="/themes">Explore the appearances ${icon('arrow-right')}</a>`, 'pg-news-article')}</div></div>
  </div>`;
}

function offlinePage() {
  return `<div class="pg-page pg-error-page">${panel(empty('cloud', 'Take the next move offline.', 'Online matches, friends and account updates need a connection. If you saved offline practice, your board and the rule guide are ready here.', actions(button('Start local practice', '/game', 'primary', 'arrow-right'), button('Read the rules', '/how-to-play', 'secondary', 'help')), '', 'h1'), 'pg-error-card')}${note('Local practice does not change your online rank, mint rewards or save to your cloud profile.')}</div>`;
}

export const faqEntries = [
  {question:'What is Mega XOXO?', answer:'Mega XOXO is an Ultimate Tic-tac-toe strategy game by Antimatter Innovations. Nine small 3 × 3 boards form one bigger board.'},
  {question:'How do you win?', answer:'Place three Xs or Os in a row to claim a small board. Claim three small boards in a row on the bigger board to win the game.'},
  {question:'How does a move decide where the opponent plays?', answer:'The cell you choose sends the next player to the corresponding small board. If that board is complete, they can choose any open board.'},
  {question:'Can I play in a browser without an account?', answer:'Yes. Play against Bot or share a screen with a friend without linking an account. Online play requires signing in to your permanent Mega XOXO profile.'},
  {question:'Do themes change the rules or give an advantage?', answer:'No. Themes change the appearance, while legal moves and competitive balance stay the same. The browser offers Mega XOXO Neon plus Vector Light, Midnight Club, Paper Club and After Hours.'},
  {question:'Where can I download the mobile apps?', answer:'The Download page will link to the official Google Play and App Store listings when they are available. Until then, you can play Mega XOXO in your browser.'},
  {question:'What is the official game website?', answer:'The official Mega XOXO website is megaxo.online. Mega XOXO is made by Antimatter Innovations.'},
];

function faqPage() {
  return `<div class="pg-page">${heading('A CLEARER NEXT MOVE.', 'Your questions. Answered.', 'Learn the rules, choose a play mode, and find the official place to start.')}<div class="pg-stack">${faqEntries.map(({question,answer})=>panel(`<h2>${e(question)}</h2><p class="mx-muted">${e(answer)}</p>`)).join('')}</div>${actions(button('Learn to play','/how-to-play','primary','arrow-right'),button('Download options','/download','secondary','download'),button('Get support','/support','secondary','help'))}</div>`;
}

function notFoundPage() {
  return `<div class="pg-page pg-error-page">${panel(`<span class="pg-error-code" aria-hidden="true">404</span><h1>This move leads off the board.</h1><p class="mx-muted">The page could not be found. Your next game is still just a move away.</p>${actions(button('Back to home', '/', 'primary', 'arrow-left'), button('Choose a play mode', '/play', 'secondary', 'swords'))}`, 'pg-error-card')}</div>`;
}

export function renderPage(path, context = {}) {
  const documentPath = path.startsWith('/legal/') ? `/${path.slice('/legal/'.length).replace(/\.html$/, '')}` : path;
  if (['/privacy', '/terms', '/support', '/privacy-choices', '/delete-account'].includes(documentPath)) {
    // The build pipeline supplies sanitized, trusted source-document bodies.
    // Never use provider/profile HTML in this map.
    const document = context.legalDocuments?.[documentPath];
    if (typeof document === 'string' && document.trim()) return `<div class="pg-page pg-reading-page"><article class="mx-panel pg-panel pg-legal-document">${document}</article></div>`;
    if (path.startsWith('/legal/')) return renderPage(documentPath, context);
  }
  const renderers = {
    '/download': renderDownloadPage, '/faq': faqPage,
    '/play': playPage, '/casual': casualPage, '/ranked': rankedPage, '/tournaments': tournamentsPage,
    '/season': seasonPage, '/friends': friendsPage, '/challenge': challengePage,
    '/leaderboard': leaderboardPage, '/rewards': rewardsPage, '/store': storePage, '/sponsors': sponsorsPage, '/ads': sponsorsPage, '/themes': themesPage,
    '/profile': profilePage, '/account': accountPage,
    '/how-to-play': howToPlayPage, '/support': supportPage, '/help': supportPage, '/accessibility': accessibilityPage, '/about': aboutPage,
    '/privacy': () => legalPage('privacy'), '/terms': () => legalPage('terms'),
    '/delete-account': deletionPage, '/privacy-choices': privacyChoicesPage,
    '/status': statusPage, '/news': newsPage, '/offline': offlinePage, '/404': notFoundPage,
  };
  return Object.prototype.hasOwnProperty.call(renderers, path) ? renderers[path](context) : null;
}
