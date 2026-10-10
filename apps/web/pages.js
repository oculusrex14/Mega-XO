import { icon, escapeHtml, button, pageHeading } from './ui.js';

/** Public page copy is product documentation. Player state is never fabricated. */
export const routes = [
  { path: '/play', title: 'Play', description: 'Choose local practice, Ranked, Casual or a game with friends.' },
  { path: '/casual', title: 'Casual', description: 'All the Mega XOXO strategy with no Elo at stake.' },
  { path: '/ranked', title: 'Ranked', description: 'Climb the Mega XOXO leagues through skill and seasonal competition.' },
  { path: '/tournaments', title: 'Tournaments', description: 'Explore the approved ten-player Mega XOXO tournament tables.' },
  { path: '/season', title: 'Season', description: 'Quarterly Ranked seasons, qualification and weekly rewards.' },
  { path: '/friends', title: 'Friends', description: 'Your friends, invitations and permanent Mega XOXO player tag.', private: true },
  { path: '/challenge', title: 'Direct challenge', description: 'Challenge a friend or a qualified leaderboard player.', private: true },
  { path: '/leaderboard', title: 'Leaderboard', description: 'Understand the seasonal skill and wealth leaderboards.' },
  { path: '/rewards', title: 'Rewards', description: 'Coins, Crowns, daily rewards and account-bound Cosmetic Credits.' },
  { path: '/themes', title: 'Themes', description: 'Preview Vector Light, Midnight Club, Paper Club and After Hours.' },
  { path: '/profile', title: 'Your profile', description: 'Manage your permanent player identity and profile preferences.', private: true },
  { path: '/settings', title: 'Settings', description: 'Website appearance, gameplay preferences and privacy controls.', private: true },
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
  { id: 'vector', name: 'Vector Light', tagline: 'Clear board. Clear thinking.', canvas: '#E9ECEF', x: '#246BFD', o: '#F45669', surface: '#F8F9FB', ink: '#15181C', accent: '#C6FF42', copy: 'Bright neutral surfaces, crisp blue Xs and coral Os. The clean original.' },
  { id: 'midnight', name: 'Midnight Club', tagline: 'Find focus after dark.', canvas: '#080B10', x: '#6F9DFF', o: '#FF7A98', surface: '#101720', ink: '#D4DCE5', accent: '#B9F03C', copy: 'Deep charcoal, soft blue and pink marks, with a lime active-board accent.' },
  { id: 'paperclub', name: 'Paper Club', tagline: 'A little ink. A bigger idea.', canvas: '#B9AB8F', x: '#2A4F9B', o: '#C23A2E', surface: '#F6EFDC', ink: '#27221B', accent: '#FFD23F', copy: 'Warm notebook paper, ruled details and hand-drawn blue and red marks.' },
  { id: 'afterhours', name: 'After Hours', tagline: 'Stay for one more move.', canvas: '#07030F', x: '#2CF2FF', o: '#FF4FB6', surface: '#0F0722', ink: '#F1EAFF', accent: '#FFD83D', copy: 'Retro arcade purple, cyan and pink glow, and a yellow active-board accent.' },
];

const e = escapeHtml;
const heading = (eyebrow, title, copy) => pageHeading(eyebrow, title, copy);
const panel = (content, className = '') => `<section class="mx-panel pg-panel ${className}">${content}</section>`;
const sectionTitle = (title, copy = '', suffix = '') => `<div class="pg-section-title"><div><h2>${title}</h2>${copy ? `<p class="mx-muted">${copy}</p>` : ''}</div>${suffix}</div>`;
const actions = (...links) => `<div class="pg-actions">${links.join('')}</div>`;
const feature = (symbol, title, copy, footer = '') => panel(`<div class="pg-feature-icon">${icon(symbol)}</div><h2>${title}</h2><p class="mx-muted">${copy}</p>${footer}`, 'pg-feature');
const pill = (text, extra = '') => `<span class="mx-chip ${extra}">${text}</span>`;
const linkRow = (symbol, title, copy, href) => `<a class="pg-link-row" href="${href}"><span class="pg-row-icon">${icon(symbol)}</span><span><strong>${title}</strong><small>${copy}</small></span>${icon('chevron-right')}</a>`;
const note = (text, symbol = 'info') => `<div class="pg-note">${icon(symbol)}<p>${text}</p></div>`;
const empty = (symbol, title, copy, links = '', className = '', headingTag = 'h2') => `<div class="pg-empty ${className}"><div class="pg-empty-art" aria-hidden="true">${icon(symbol)}<span></span><span></span></div><${headingTag}>${title}</${headingTag}><p>${copy}</p>${links}</div>`;
const signin = (copy = 'Your rank, friends and rewards belong to one permanent profile.') => `<div class="pg-signin"><span class="pg-row-icon">${icon('user')}</span><div><strong>Sign in to play online</strong><p>${copy}</p></div>${button('Open account', '/game', 'primary', 'arrow-right')}</div>`;
const shortList = (items) => `<ul class="pg-check-list">${items.map((item) => `<li>${icon('check')}<span>${item}</span></li>`).join('')}</ul>`;
const mini = (marks = ['X', '', 'O', '', 'X', '', '', '', 'O'], className = '') => `<div class="pg-mini ${className}" aria-hidden="true">${marks.map((mark) => `<span class="${mark === 'X' ? 'pg-x' : mark === 'O' ? 'pg-o' : ''}">${mark}</span>`).join('')}</div>`;
const rankGem = () => `<div class="pg-rank-gem" aria-hidden="true"><img src="/assets/art/crystal.webp" width="448" height="344" alt=""></div>`;

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
  const practice = context.practice || context.query?.get?.('mode') === 'practice';
  if (practice) return `<div class="pg-page pg-practice-page">${heading('LOCAL PRACTICE', 'Make your next move.', 'Learn the routes, test an idea, and play at your own pace. Local practice does not change your online rating.')}
    <div id="practice-mount" class="pg-practice-mount"></div>
    ${note('This practice session uses the shared Mega XOXO game rules. Online play, account rewards and cloud saves open in the game.')}
    ${actions(button('All play modes', '/play', 'secondary', 'arrow-left'), button('Open online game', '/game', 'secondary', 'globe'))}</div>`;
  return `<div class="pg-page">${heading('THE NEXT MOVE IS YOURS', 'Choose your arena.', 'Nine small boards. A world of possibility. Start with practice, or bring your strategy online.')}
    <div class="pg-grid pg-grid-three pg-mode-grid">
      ${panel(`<div class="pg-mode-art pg-mode-ranked">${rankGem()}</div>${pill('RATED', 'pg-chip-blue')}<h2>Ranked</h2><p>Every move counts. Compete with matched opponents and climb through the leagues.</p>${button('Play Ranked', '/game', 'primary', 'swords')}<small>Requires a linked account · Coin entry</small>`, 'pg-mode')}
      ${panel(`<div class="pg-mode-art pg-mode-casual">${mini()}${mini(['', 'X', '', 'O', '', '', 'X', '', 'O'])}</div>${pill('NO ELO CHANGE')}<h2>Casual</h2><p>Find an online opponent and try a new strategy without changing your rating.</p>${button('Play Casual', '/game', 'secondary', 'globe')}<small>Requires a linked account</small>`, 'pg-mode')}
      ${panel(`<div class="pg-mode-art pg-mode-friends">${icon('people')}<span class="pg-mode-cross">×</span></div>${pill('YOUR PEOPLE')}<h2>With friends</h2><p>Find your friends by player tag, send an invite, and make the next move together.</p>${button('Find your friends', '/friends', 'secondary', 'people')}<small>Free friend games do not change Elo</small>`, 'pg-mode')}
    </div>
    ${panel(`<div class="pg-practice-art" aria-hidden="true">${mini(['X', '', '', '', 'O', '', '', '', 'X'])}</div><div><span class="mx-eyebrow">NO ACCOUNT NEEDED</span><h2>Think bigger. Start smaller.</h2><p class="mx-muted">Get comfortable with the board in local practice. Learn how one small move can shape the whole game.</p></div>${button('Start practice', '/play?mode=practice', 'primary', 'arrow-right')}`, 'pg-practice-banner')}
    ${actions(button('Learn the rules', '/how-to-play', 'secondary', 'help'), button('Explore tournaments', '/tournaments', 'secondary', 'trophy'))}
  </div>`;
}

function rankedPage(context) {
  const season = utcSeason(context.now);
  return `<div class="pg-page">${heading('SKILL HAS THE LAST WORD', 'Earn your place.', 'From your first placement to the highest leagues, your rating is decided by how you play.')}
    <div class="pg-grid pg-grid-sidebar">
      ${panel(`<div class="pg-rank-orbit">${rankGem()}</div><span class="mx-eyebrow">YOUR RANKED JOURNEY</span><h2>It starts with a move.</h2><p class="mx-muted">New profiles start at 600 rating. Complete ten lifetime rated placements before your normal public skill rank is published.</p>${button(context.profile ? 'Open Ranked' : 'Sign in to play online', '/game', 'primary', 'swords')}<div class="pg-divider"></div><div class="pg-inline-stat"><span>Current season</span><strong>${season.title}</strong></div><p class="pg-small mx-muted">${season.range} · UTC</p><a class="pg-text-link" href="/season">Season qualification ${icon('arrow-right')}</a>`, 'pg-rank-summary')}
      <div class="pg-stack">${panel(`${sectionTitle('One ladder. Pure skill.', 'Coins, Crowns and purchases never enter the Elo formula.')}<div class="pg-grid pg-grid-three pg-compact-grid">${feature('swords', 'Play', 'Enter the Ranked queue and compete with matched opponents.')}${feature('shield', 'Qualify', 'Complete your placements and qualify again each quarter.')}${feature('trophy', 'Climb', 'Build your rating through rated games. Elo is retained at rollover.')}</div>`, 'pg-rank-explainer')}
        ${panel(`${sectionTitle('The leagues', 'Rating floors, queue entry and full weekly rewards. Actual weekly payouts require qualification and are prorated.')}<div class="pg-table-wrap" role="region" aria-label="League rating floors, entry fees and rewards" tabindex="0"><table class="pg-table"><caption class="pg-sr-only">Mega XOXO league rating floors, queue fees and full weekly rewards</caption><thead><tr><th scope="col">League</th><th scope="col">Rating floor</th><th scope="col">Entry</th><th scope="col">Weekly</th></tr></thead><tbody>${tiers.map(([name, floor, fee, reward], i) => `<tr><th scope="row"><span class="pg-tier-dot pg-tier-${i}"></span>${name}</th><td>${floor.toLocaleString('en-US')}</td><td>${fee} Coins</td><td>${reward} Coins</td></tr>`).join('')}</tbody></table></div>${note('Champion, Master and Grandmaster are limited weekly seats with additional eligibility requirements. Their rating floor alone does not guarantee a seat.')}`)}
      </div>
    </div>
    ${panel(`${sectionTitle('What a Ranked win means')}<div class="pg-grid pg-grid-three"><div><h3>Same entry for both players</h3><p>The pairing uses the lower configured league fee. Half the combined pot is retired and half goes to the winner.</p></div><div><h3>A separate win reward</h3><p>A qualifying queue win earns floor(60% of your pre-match league fee), capped at 50 Coins per UTC day.</p></div><div><h3>Your skill stays yours</h3><p>Rated queue and rated direct challenges use K=24 Elo. Casual, local and public tournament games do not change normal Ranked Elo.</p></div></div>`, 'pg-copy-panel')}
  </div>`;
}

function casualPage() {
  return `<div class="pg-page">${heading('ALL THE STRATEGY. NO ELO AT STAKE.', 'Play for the next good move.', 'Warm up, try a different route, or simply enjoy the game. Casual results do not change your Ranked rating.')}
    ${panel(`<div class="pg-about-symbol" aria-hidden="true"><span>×</span><span>○</span><span>×</span><span>○</span></div><div class="pg-about-copy"><span class="mx-eyebrow">ONLINE CASUAL</span><h2>A fresh board. A new rival.</h2><p>Sign in to your permanent Mega XOXO profile and choose Casual inside the game. Your account remains the same while your normal Ranked Elo stays unchanged.</p>${actions(button('Sign in to play online', '/game', 'primary', 'globe'), button('Start local practice', '/play?mode=practice', 'secondary', 'arrow-right'))}</div>`, 'pg-about-hero')}
    <div class="pg-grid pg-grid-three">${feature('globe', 'Find an opponent', 'Choose Casual in the online game to join the shared matchmaking pool.')}${feature('shield', 'Explore your strategy', 'Casual does not alter Elo. The same small-board routing and big-board win rules apply.')}${feature('people', 'Play with friends', 'Use a free friend game when you already have a rival in mind.', `<a class="pg-text-link" href="/friends">Find your friends ${icon('arrow-right')}</a>`)}</div>
    ${note('Local practice is available without linking an account. Online Casual uses your permanent profile.')}
  </div>`;
}

function tournamentsPage() {
  const tables = [['Low', 100, 'Coins', 1000, [360, 200, 130, 110, 100]], ['Medium', 400, 'Coins', 4000, [1440, 800, 520, 440, 400]], ['High', 1200, 'Coins', 12000, [4320, 2400, 1560, 1320, 1200]], ['Premium', 200, 'Crowns', 2000, [720, 400, 260, 220, 200]]];
  return `<div class="pg-page">${heading('TEN PLAYERS. ONE TOP SPOT.', 'Bring your best game.', 'A tournament is its own challenge. Compete for placement and prizes while your normal Ranked Elo stays unchanged.')}
    ${panel(`<div class="pg-tournament-intro"><div class="pg-trophy-art" aria-hidden="true"><img src="/assets/art/trophy.webp" width="552" height="552" alt=""></div><div><span class="mx-eyebrow">PUBLIC TABLES</span><h2>A fair field from the start.</h2><p>Every paid public tournament assembles exactly ten players within a maximum 200 Elo spread.</p></div><div class="pg-tournament-facts"><span><strong>10</strong>players per table</span><span><strong>200</strong>maximum Elo spread</span><span><strong>5</strong>prize places</span></div></div>`, 'pg-tournament-hero')}
    ${sectionTitle('Choose your table', 'Compare entry and prizes below. Open the game to see available tables and confirm an entry.')}
    <div class="pg-grid pg-grid-four">${tables.map(([name, entry, currency, pool, payouts]) => panel(`<span class="mx-eyebrow">${name.toUpperCase()} TABLE</span><div class="pg-price">${entry.toLocaleString('en-US')}<span>${currency} entry</span></div><div class="pg-divider"></div><p class="pg-small mx-muted">Total pool <strong>${pool.toLocaleString('en-US')} ${currency}</strong></p><ol class="pg-payouts">${payouts.map((value, i) => `<li><span>${i + 1}${['st', 'nd', 'rd', 'th', 'th'][i]} place</span><strong>${value.toLocaleString('en-US')}</strong></li>`).join('')}</ol><p class="pg-small mx-muted">10% of the original pool is retired. Places 6–10 receive no payout.</p>${button('View in game', '/game', name === 'Premium' ? 'primary' : 'secondary', 'arrow-right')}`, `pg-tournament-table ${name === 'Premium' ? 'pg-premium' : ''}`)).join('')}</div>
    ${panel(empty('trophy', 'Your next tournament awaits.', 'Sign in inside Mega XOXO to see available tables, reservations and your aggregate tournament record.', actions(button('Sign in to play online', '/game', 'primary', 'user'))))}
    ${note('Public tournament fixtures do not mint normal Ranked win bonuses. Coins and Crowns have no cash-out or real-world redemption.')}
  </div>`;
}

function seasonPage(context) {
  const season = utcSeason(context.now);
  return `<div class="pg-page">${heading('A NEW QUARTER. A NEW CHALLENGE.', 'The season is yours to shape.', 'Your Elo carries forward. Your seasonal qualification, record, peak and leaderboard participation begin again each quarter.')}
    ${panel(`<div class="pg-season-display"><div class="pg-season-symbol" aria-hidden="true">${icon('trophy')}</div><div><span class="mx-eyebrow">CURRENT UTC QUARTER</span><h2>${season.title}</h2><p>${season.range}</p><span class="mx-chip">Quarterly Ranked season</span></div><div class="pg-season-cutoff"><span class="mx-muted">Quarter ends</span><strong>${season.end}</strong><a class="pg-text-link" href="/ranked">Explore Ranked ${icon('arrow-right')}</a></div></div>`, 'pg-season-hero')}
    <div class="pg-grid pg-grid-two">${panel(`${sectionTitle('Get season-qualified', 'Requalify during each quarterly UTC season.')}<div class="pg-rule-number"><strong>5</strong><span>rated games</span></div><div class="pg-rule-number"><strong>3</strong><span>matchmade Ranked queue games</span></div><div class="pg-rule-number"><strong>3</strong><span>unique rated opponents</span></div>${button('Open Ranked', '/game', 'primary', 'swords')}`)}
      ${panel(`${sectionTitle('Make it a rewarding week', 'The week runs from Monday 00:00 UTC to the next Monday.')}<ul class="pg-bullet-list"><li>5 qualifying rated games</li><li>3 matchmade queue games and 3 unique opponents</li><li>Activity on 3 days</li><li>At least 3 valid daily tier snapshots</li></ul><p class="mx-muted">The reward uses the lower of your end-of-week tier and the lower median observed tier, prorated by valid snapshot days out of seven.</p><a class="pg-text-link" href="/rewards">Understand your rewards ${icon('arrow-right')}</a>`)}
    </div>
    ${panel(`${sectionTitle('A seat at the very top', 'Champion · Master · Grandmaster')}<div class="pg-grid pg-grid-three pg-seat-grid"><div><strong>1,000</strong><span>Champion seats</span></div><div><strong>200</strong><span>Master seats</span></div><div><strong>20</strong><span>Grandmaster seats</span></div></div><p>Elite allocation activates when the eligible population reaches 5,000. Candidates need 50 lifetime rated games, ten unique rated opponents, a 14-day-old account, season qualification and recent qualifying activity.</p><p class="mx-muted">Seats publish weekly. Inactivity releases a seat without removing Elo; eligible open-league status remains based on rating.</p>`, 'pg-copy-panel')}
    ${signin('Open the game for your real qualification progress and reward status.')}
  </div>`;
}

function friendsPage(context) {
  return `<div class="pg-page">${heading('GOOD RIVALS. BETTER FRIENDS.', 'Make it a friendly challenge.', 'Find your people, exchange a player tag, and take the board together.')}
    <div class="pg-grid pg-grid-sidebar"><aside class="pg-stack">${panel(`<div class="pg-profile-orb">${icon('user')}</div><h2>${context.profile ? e(context.profile.displayName || context.profile.username || 'Your profile') : 'Your player identity'}</h2><p class="mx-muted">${context.profile?.tag ? e(context.profile.tag) : 'One permanent tag follows you across devices.'}</p>${button(context.profile ? 'View / edit your profile' : 'Create or recover your profile', context.profile ? '/profile' : '/game', 'secondary', 'user')}`, 'pg-self-card')}${panel(`${linkRow('people', 'Friends', 'Find and manage your connections', '/game')}${linkRow('mail', 'Invitations', 'Review requests inside the game', '/game')}${linkRow('swords', 'Direct challenge', 'Choose a friendly or rated game', '/challenge')}`, 'pg-nav-panel')}</aside>
      ${panel(empty('people', context.profile ? 'Bring your friends to the board.' : 'A better game, together.', 'Open your signed-in Friends screen to search by player tag, view requests and invite a friend.', actions(button(context.profile ? 'Open Friends in game' : 'Sign in to play online', '/game', 'primary', 'people'), button('How challenges work', '/challenge', 'secondary', 'swords'))), 'pg-friends-main')}
    </div><div class="pg-grid pg-grid-three">${feature('user', 'Same tag. Everywhere.', 'Your permanent MEGA player tag stays the same even when you change your username.')}${feature('cloud', 'Keep your people close.', 'Your linked profile carries your relationships across supported web, Android and iOS clients.')}${feature('shield', 'Your presence, your choice.', 'Choose who sees your stats and online presence from your profile controls.')}</div>
  </div>`;
}

function challengePage() {
  return `<div class="pg-page">${heading('CALL YOUR NEXT MATCH', 'A worthy opponent awaits.', 'Play a free game with a friend, or make a rated challenge. Review the invitation and terms before you accept.')}
    <div class="pg-grid pg-grid-two">${panel(`<div class="pg-duel-symbols" aria-hidden="true"><span>×</span>${icon('swords')}<span>○</span></div>${pill('NO ELO CHANGE')}<h2>A friendly game</h2><p>Invite a friend to play for free. Try a route, settle a rivalry, or simply enjoy the board together.</p>${button('Open Friends', '/game', 'primary', 'people')}`, 'pg-challenge-card')}${panel(`<div class="pg-duel-symbols pg-duel-crowns" aria-hidden="true">${icon('crown')}</div>${pill('RATED')}<h2>A direct rated challenge</h2><p>The challenger funds the Crown contribution. The invited player contributes zero. Stakes never change the Elo formula.</p>${button('Open challenges', '/game', 'secondary', 'swords')}`, 'pg-challenge-card')}</div>
    ${panel(`${sectionTitle('Know the terms before you accept')}<div class="pg-grid pg-grid-three"><div><h3>Friend-stake games</h3><p>Require mutual server-recorded friendship. The challenger contributes between 2 and 20 Crowns.</p></div><div><h3>Leaderboard challenges</h3><p>The minimum contribution is calculated from the target league and tier gap. The game shows the server quote before confirmation.</p></div><div><h3>Clear settlement</h3><p>For a decisive rated result, 50% of the challenger-funded pot is retired and 50% is paid to the winner. A draw or trusted server void returns the contribution.</p></div></div>`, 'pg-copy-panel')}
    ${signin('Sign in to view invitations and eligibility. Rated challenges require your completed placements.')}
  </div>`;
}

function leaderboardPage() {
  return `<div class="pg-page">${heading('THE BOARD DOES THE TALKING', 'Play your way up.', 'Seasonal skill reflects your competitive rating. Wealth reflects current holdings. They are separate measures.')}
    <div class="pg-grid pg-grid-sidebar"><aside class="pg-stack">${panel(`<div class="pg-rank-orbit">${rankGem()}</div><h2>Skill stands alone.</h2><p class="mx-muted">Coins, Crowns, stake size and purchase history never affect Elo.</p>${button('Explore the leagues', '/ranked', 'secondary', 'shield')}`, 'pg-rank-summary')}${panel(`${sectionTitle('When your rank appears')}<ul class="pg-bullet-list"><li>Ten lifetime rated placements complete</li><li>Current-season qualification</li><li>Recent rated activity</li></ul><p class="pg-small mx-muted">Open-league players leave the public skill leaderboard after 28 days without rated activity and keep their Elo.</p>`)}</aside>
      ${panel(`<div class="pg-leaderboard-heading"><div><span class="mx-eyebrow">SEASONAL STANDINGS</span><h2>Every position is earned.</h2></div>${icon('trophy')}</div>${empty('trophy', 'Meet the competition.', 'Open the shared leaderboard in Mega XOXO for current published players, skill standings and wealth standings.', actions(button('Open live leaderboard', '/game', 'primary', 'arrow-right')))}<div class="pg-leaderboard-note"><span>${icon('shield')} Skill = rating</span><span>${icon('coin')} Wealth = current holdings</span></div>`, 'pg-leaderboard-main')}
    </div>${note('Wealth includes liquid and reserved holdings in Coin-equivalent. It is not a record of lifetime purchases.')}
  </div>`;
}

function rewardsPage() {
  return `<div class="pg-page">${heading('GOOD MOVES GO FURTHER', 'Make every game count.', 'Earn through play. Your skill and your wallet stay independent.')}
    <div class="pg-grid pg-grid-three pg-wallet-grid">${feature('coin', 'Coins', 'Your everyday gameplay currency for Ranked entries and Coin tournament tables.', '<p class="pg-wallet-foot">New profiles start with <strong>150 Coins</strong>.</p>')}${feature('crown', 'Crowns', 'The same utility whether bought or earned. Use Crowns for rated direct challenges and Premium tables.', '<p class="pg-wallet-foot"><strong>10 Coins = 1 Crown</strong> in both directions.</p>')}${feature('star', 'Cosmetic Credits', 'Account-bound credits saved for future themes. They do not affect wealth or rating.', '<p class="pg-wallet-foot">Cannot be purchased, converted, transferred or staked.</p>')}</div>
    <div class="pg-grid pg-grid-two">${panel(`${sectionTitle('Build a daily rhythm', 'Reward-bearing games must meet the normal qualification rules.')}<div class="pg-reward-line"><span>${icon('check')} Daily quests</span><strong>Up to 30 Coins/day</strong></div><div class="pg-reward-line"><span>${icon('swords')} Bot wins</span><strong>Up to 20 Coins/day</strong></div><div class="pg-reward-line"><span>${icon('shield')} Ranked queue wins</span><strong>Up to 50 Coins/day</strong></div><p class="mx-muted">Bot rewards are 1 / 1 / 2 / 4 / 6 Coins for Beginner through Expert, with at most three rewarded wins at each difficulty.</p>${button('View your rewards in game', '/game', 'primary', 'coin')}`)}${panel(`${sectionTitle('A week well played', 'Weekly rewards recognise qualified activity.')}<p>Play five qualifying rated games, including three matchmade queue games against three unique opponents. Be active on three days and record at least three valid daily tier snapshots.</p><p class="mx-muted">The paid tier uses the lower of the end-of-week tier and lower median observed tier. Valid snapshot days determine the prorated payout.</p>${button('Season & weekly rules', '/season', 'secondary', 'trophy')}<div class="pg-divider"></div><a class="pg-text-link" href="/themes">Explore all four themes ${icon('arrow-right')}</a>`)}</div>
    ${note('Coins and Crowns cannot be cashed out or redeemed for real-world money. Local practice on this website does not mint account rewards.')}
    ${signin('Your actual balances and claimable rewards are shown in your signed-in game.')}
  </div>`;
}

function themesPage() {
  return `<div class="pg-page">${heading('FOUR MOODS. ONE GAME.', 'Find your kind of focus.', 'Your board, your atmosphere. Every theme keeps the same rules, legal moves and competitive balance.')}
    <div class="pg-grid pg-grid-two pg-theme-grid">${themes.map((theme) => panel(`<div class="pg-theme-preview pg-theme-${theme.id}" style="--pg-preview-canvas:${theme.canvas};--pg-preview-surface:${theme.surface};--pg-preview-x:${theme.x};--pg-preview-o:${theme.o};--pg-preview-ink:${theme.ink};--pg-preview-accent:${theme.accent}"><span class="pg-theme-label">${theme.tagline}</span><div class="pg-theme-board">${Array.from({ length: 9 }, (_, i) => mini(i === 4 ? ['X', '', 'O', '', 'X', '', '', '', 'O'] : i === 0 ? ['X', 'O', '', '', '', '', '', '', ''] : Array(9).fill(''), i === 4 ? 'pg-theme-active' : '')).join('')}</div><div class="pg-theme-swatches"><span style="background:${theme.x}"></span><span style="background:${theme.o}"></span><span style="background:${theme.accent}"></span></div></div><div class="pg-theme-copy"><div><h2>${theme.name}</h2><p>${theme.copy}</p></div><a class="mx-button secondary" href="/game">Open in game ${icon('arrow-right')}</a></div>`, 'pg-theme-card')).join('')}</div>
    ${note('Choose your saved theme inside game settings. Changing the atmosphere does not reset your match or turn timer.')}
    ${panel(`<div class="pg-theme-future">${icon('star')}<div><h2>Credits for the future.</h2><p class="mx-muted">Your Cosmetic Credits are saved for future themes. The four current appearances keep the same game and rules.</p></div><a class="pg-text-link" href="/rewards">Rewards ${icon('arrow-right')}</a></div>`)}
  </div>`;
}

function profilePage(context) {
  const profile = context.profile;
  const name = profile?.displayName || profile?.username || 'Your next chapter';
  return `<div class="pg-page">${heading('ONE PLAYER. EVERY PLATFORM.', 'Your identity stays with you.', 'A permanent player tag. Your friends, progression and settings. One profile across supported clients.')}
    <div class="pg-grid pg-grid-sidebar">${panel(`<div class="pg-profile-orb">${profile ? `<span>${e(String(name).slice(0, 1).toUpperCase())}</span>` : icon('user')}</div><h2>${e(name)}</h2><p class="mx-muted">${profile?.tag ? e(profile.tag) : 'Sign in to reveal your permanent MEGA tag.'}</p>${button(profile ? 'View / edit your profile' : 'Sign in to your profile', '/game', 'primary', 'user')}<div class="pg-divider"></div><p class="pg-small mx-muted">A username can change. Your stable player tag does not.</p>`, 'pg-self-card')}
      <div class="pg-stack">${panel(`${sectionTitle('Make it yours')}<div class="pg-grid pg-grid-two pg-profile-options"><div>${icon('user')}<h3>Name & avatar</h3><p>Your username, display name and avatar are managed inside your signed-in profile.</p></div><div>${icon('shield')}<h3>Visibility</h3><p>Control stats visibility and whether your online presence is shown.</p></div><div>${icon('cloud')}<h3>Cloud practice</h3><p>A linked account keeps your cloud practice save with your permanent identity.</p></div><div>${icon('star')}<h3>Cosmetic Credits</h3><p>View your account-bound balance, reserved for future themes.</p></div></div>${button('Open profile controls', '/game', 'secondary', 'arrow-right')}`)}${panel(`${linkRow('people', 'Your friends', 'View friends and invitations', '/friends')}${linkRow('settings', 'Account & recovery', 'Linked sign-in methods and security', '/account')}${linkRow('shield', 'Privacy choices', 'Export, visibility and deletion', '/privacy-choices')}`, 'pg-nav-panel')}</div>
    </div>
  </div>`;
}

function settingsPage() {
  return `<div class="pg-page">${heading('SET UP YOUR SPACE', 'Focus on your game.', 'Appearance, account and privacy controls, with a clear path back to the board.')}
    <div class="pg-grid pg-grid-sidebar"><aside>${panel(`<span class="mx-eyebrow">QUICK ACCESS</span>${linkRow('palette', 'Appearance', 'Four distinct gameplay appearances', '/themes')}${linkRow('user', 'Profile', 'Name, avatar and visibility', '/profile')}${linkRow('shield', 'Privacy', 'Your account and data choices', '/privacy-choices')}${linkRow('help', 'Support', 'Help from Antimatter Innovations', '/support')}`, 'pg-nav-panel')}</aside><div class="pg-stack">${panel(`${sectionTitle('Gameplay preferences', 'Open the game to change your saved gameplay settings.')}<div class="pg-setting-row"><div><strong>Board appearance</strong><p>Vector Light, Midnight Club, Paper Club or After Hours.</p></div><a class="pg-text-link" href="/themes">Preview themes ${icon('chevron-right')}</a></div><div class="pg-setting-row"><div><strong>Sound & game controls</strong><p>Manage your preferences inside game settings.</p></div><a class="pg-text-link" href="/game">Open settings ${icon('chevron-right')}</a></div><div class="pg-setting-row"><div><strong>Motion on this website</strong><p>Your system’s reduced-motion preference is respected automatically.</p></div><span class="mx-chip">System preference</span></div>`)}${panel(`${sectionTitle('Account & privacy')}${linkRow('mail', 'Linked accounts & recovery', 'Keep access to your permanent profile', '/account')}${linkRow('shield', 'Download your data', 'Requires sign-in and recent verification', '/privacy-choices')}${linkRow('user', 'Delete account', 'Read the permanent deletion process', '/delete-account')}`, 'pg-nav-panel')}</div></div>
  </div>`;
}

function accountPage(context) {
  return `<div class="pg-page">${heading('YOUR GAME COMES WITH YOU', context.profile ? 'Keep your profile close.' : 'Welcome to your next move.', 'One identity for your friends, your rank and your progress across supported web, iOS and Android clients.')}
    <div class="pg-grid pg-grid-two pg-account-grid">${panel(`<div class="pg-account-emblem" aria-hidden="true">${icon('user')}</div><h2>${context.profile ? 'Account & recovery' : 'Continue to Mega XOXO'}</h2><p class="mx-muted">${context.profile ? 'Manage your linked methods from your verified account controls.' : 'Sign in or create your permanent profile inside the game. Continue with email, Google or Apple using the same account system.'}</p>${button(context.profile ? 'Open linked accounts & recovery' : 'Sign in to play online', '/game', 'primary', 'arrow-right')}<p class="pg-small mx-muted">Developed by Antimatter Innovations</p><div class="pg-divider"></div><a class="pg-text-link" href="/support">Need help with access? ${icon('arrow-right')}</a>`, 'pg-account-card')}
      ${panel(`${sectionTitle('One profile. A few ways in.')}<div class="pg-account-method">${icon('mail')}<div><h3>Continue with email</h3><p>Existing players sign in. New players verify mailbox ownership with a six-digit code before the profile is created.</p></div></div><div class="pg-account-method">${icon('shield')}<div><h3>Use a linked provider</h3><p>Continue with Google or Apple through the game’s existing identity flow. Link recovery methods to the same profile.</p></div></div><div class="pg-account-method">${icon('refresh')}<div><h3>Recover your account</h3><p>Use Forgot password in the email continuation flow. Support will never ask for your password or verification code.</p></div></div><a class="pg-text-link" href="/privacy-choices">Understand your data choices ${icon('arrow-right')}</a>`, 'pg-account-info')}</div>
    ${note('At least one login method must remain linked. Sensitive account changes and privacy requests require recent identity verification.', 'shield')}
  </div>`;
}

function howToPlayPage() {
  return `<div class="pg-page">${heading('BIGGER MOVES. BRIGHTER MINDS.', 'Small boards. Big decisions.', 'Win the small boards to win the big one. Every move also decides where your opponent plays next.')}
    <div class="pg-grid pg-grid-three pg-tutorial-grid">${panel(`<span class="pg-step">01</span>${mini(['X', 'X', 'X', '', 'O', '', 'O', '', ''])}<h2>Win a small board.</h2><p>Place three of your marks in a row, column or diagonal to claim a small board.</p>`, 'pg-tutorial-card')}${panel(`<span class="pg-step">02</span><div class="pg-routing-art" aria-hidden="true">${mini(['', '', '', '', '', '', '', '', 'X'], 'pg-route-from')}${icon('arrow-right')}${mini(Array(9).fill(''), 'pg-route-to')}</div><h2>Send the next move.</h2><p>The cell you choose sends your opponent to the corresponding small board. Bottom-right cell? They play the bottom-right board.</p>`, 'pg-tutorial-card')}${panel(`<span class="pg-step">03</span>${mini(['X', 'O', '', '', 'X', '', '', '', 'X'], 'pg-macro-demo')}<h2>Win the big board.</h2><p>Claim three small boards in a row, column or diagonal to win the match.</p>`, 'pg-tutorial-card')}</div>
    <div class="pg-grid pg-grid-two">${panel(`${sectionTitle('Every move has a destination.')}<p>The first player may choose any empty cell. After that, the highlighted board tells you where to play. Occupied cells are never legal moves.</p><p class="mx-muted">If the destination board is already won or drawn, the next player may choose any unfinished board. A full small board without a winning line is drawn.</p>${shortList(['A cell chooses both your mark and your opponent’s destination.', 'Won and drawn small boards are closed to further moves.', 'If all small boards finish without a big-board line, the match is drawn.'])}`)}${panel(`<span class="mx-eyebrow">LEARN BY PLAYING</span><h2>Your best lesson is a move.</h2><p class="mx-muted">Try a local practice game. You can take your time, explore the routes, and see what each decision opens up.</p>${button('Start local practice', '/play?mode=practice', 'primary', 'arrow-right')}<div class="pg-divider"></div><p class="pg-small mx-muted">Local practice does not alter Elo or grant account currency. Online Ranked rules, clocks and entry terms appear inside the game.</p>${button('Choose a play mode', '/play', 'secondary', 'swords')}`, 'pg-tutorial-cta')}</div>
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
    <div class="pg-grid pg-grid-three">${feature('swords', 'Competition through skill', 'Elo follows rated results. Currency, purchase history and stake size never create a skill advantage.')}${feature('cloud', 'A profile that stays with you', 'One permanent identity, designed to carry your progression and connections across supported clients.')}${feature('palette', 'Your game. Your atmosphere.', 'Four approved gameplay appearances, with the same board, legal moves and competitive rules.')}</div>
    ${panel(`<div class="pg-about-footer"><div><span class="mx-eyebrow">THE DEVELOPER</span><h2>Antimatter Innovations</h2><p class="mx-muted">Questions, account help or feedback: contact@antimatterinnovations.com</p></div>${button('Get in touch', '/support', 'secondary', 'mail')}</div>`)}
  </div>`;
}

function accessibilityPage() {
  return `<div class="pg-page pg-reading-page">${heading('A BOARD FOR YOUR NEXT MOVE', 'Play at your own pace.', 'Keyboard access, clear game states and motion preferences help keep the focus on the game.')}
    <div class="pg-grid pg-grid-two">${feature('monitor', 'Keyboard navigation', 'Use Tab and Shift + Tab to move between controls. Enter follows links. Space or Enter activates buttons. The website includes a skip link to main content.')}${feature('settings', 'Motion preferences', 'This website respects your system’s reduced-motion setting. Decorative movement and nonessential transitions are removed when reduced motion is requested.')}${feature('help', 'Clear controls', 'Interactive controls use text labels or accessible names. X and O keep distinct shapes, and local-practice cells expose their board, position and move state.')}${feature('palette', 'Presentation choices', 'Preview all four approved palettes, then select your saved gameplay appearance in the game. A theme changes presentation while the rules stay the same.')}</div>
    ${panel(`${sectionTitle('Local practice controls')}<p>Use Tab to enter the board. Arrow keys move across the visual nine-by-nine grid and wrap at its edges. Home and End move to the first or last cell in the current visual row. Press Enter or Space to place a legal move.</p><p class="mx-muted">The nine small boards and each cell have accessible names. A polite live status reports turns, wins and draws. Difficulty, restart, local two-player and theme controls use labeled native controls.</p>${button('Try local practice', '/play?mode=practice', 'primary', 'arrow-right')}`)}
    ${panel(`${sectionTitle('Tell us what gets in your way')}<p>If a control, device or assistive technology makes the website difficult to use, contact Antimatter Innovations. Include the page, browser or device, the action attempted and the accessibility tool used.</p><p class="mx-muted">This page documents available controls. It does not claim independent accessibility certification.</p>${button('Contact support', '/support', 'secondary', 'mail')}`)}
  </div>`;
}

function legalPage(type) {
  const privacy = type === 'privacy';
  const title = privacy ? 'Your privacy matters.' : 'Know the rules of the platform.';
  return `<div class="pg-page pg-reading-page">${heading(privacy ? 'PRIVACY & TRANSPARENCY' : 'TERMS & RESPONSIBILITIES', title, privacy ? 'Understand account information, gameplay records and the choices available to you.' : 'Read the terms covering your account, competitive play, virtual currency and supported services.')}
    ${panel(`<span class="mx-chip pg-chip-amber">Draft for legal review</span><h2>${privacy ? 'Privacy Policy' : 'Terms of Service'}</h2><p>The current document is a draft awaiting Antimatter Innovations’ legal approval. It is not an effective, approved production policy.</p><p class="mx-muted">Read the full document and its current approval notice below.</p>${button(`Read the full ${privacy ? 'Privacy Policy' : 'Terms'}`, `/legal/${type}`, 'primary', 'arrow-right')}`, 'pg-legal-card')}
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
    <div class="pg-grid pg-grid-two">${feature('user', 'Profile visibility', 'Choose stats visibility and online-presence visibility from your signed-in profile.', button('Open profile controls', '/game', 'secondary', 'user'))}${feature('download', 'Download your data', 'Request an allowlisted account export after sign-in and recent identity verification.', button('Open privacy controls', '/game', 'secondary', 'download'))}${feature('shield', 'Advertising privacy', 'Advertising and consent controls depend on the approved release and platform. Use the privacy-options surface in your supported app when available.', `<a class="pg-text-link" href="/legal/privacy-choices">Read the full privacy choices ${icon('arrow-right')}</a>`)}${feature('user', 'Permanent deletion', 'Review the process and confirm your exact player tag in your verified account.', button('Deletion instructions', '/delete-account', 'secondary', 'arrow-right'))}</div>
    ${panel(`<div class="pg-about-footer"><div><h2>Need help with a privacy request?</h2><p class="mx-muted">Contact Antimatter Innovations if your request cannot be completed through the available controls.</p></div>${button('Contact support', '/support', 'primary', 'mail')}</div>`)}
    ${note('The maintained Privacy Policy and Terms remain drafts until legal approval is recorded. Read their current notices at the full document links.')}
  </div>`;
}

function statusPage() {
  return `<div class="pg-page">${heading('CONNECTION & SERVICE INFORMATION', 'Keep your next move in sight.', 'Find connection details in your game, try local practice, or get help with a persistent problem.')}
    ${panel(`<div class="pg-status-summary">${icon('globe')}<div><span class="mx-eyebrow">ONLINE CONNECTION</span><h2>Stay connected to the board.</h2><p class="mx-muted">Open Mega XOXO to see the game’s current connection state and any service message.</p></div>${button('Open Mega XOXO', '/game', 'primary', 'arrow-right')}</div>`)}
    <div class="pg-grid pg-grid-three">${feature('user', 'Asked to sign in?', '“Sign in to play online” means your profile needs to be linked. Continue through the account flow.')}${feature('refresh', 'Connection interrupted?', 'Check your connection, then return to the game. The game handles supported reconnection and resume flows.')}${feature('monitor', 'Offline right now?', 'Local practice is available while online features need a connection.', `<a class="pg-text-link" href="/play?mode=practice">Start practice ${icon('arrow-right')}</a>`)}</div>
    ${note('For a persistent error, include the MX- support code, platform and action attempted. Do not send authenticated network traces or session cookies.')}
    ${actions(button('Get support', '/support', 'secondary', 'mail'))}
  </div>`;
}

function newsPage() {
  return `<div class="pg-page">${heading('FROM THE DEVELOPER', 'Your next chapter starts here.', 'Release information and product notes from Mega XOXO by Antimatter Innovations.')}
    <div class="pg-grid pg-grid-sidebar"><aside>${panel(`<div class="pg-feature-icon">${icon('refresh')}</div><h2>Product notes</h2><p class="mx-muted">A place for game updates, appearance notes and information from the developer.</p>${button('Back to play', '/play', 'secondary', 'arrow-right')}`)}</aside><div class="pg-stack">${panel(`<span class="mx-chip">Current game release</span><h2>Mega XOXO v4.1.2</h2><p>Sign in to play online and keep your friends, rank and rewards with your permanent profile.</p><p class="mx-muted">Guests can practice locally. When you are ready for online play, continue with email, Google or Apple inside the game.</p>${button('Open Mega XOXO', '/game', 'primary', 'globe')}`, 'pg-news-article')}${panel(`<span class="mx-eyebrow">THE GAME YOU KNOW</span><h2>Four appearances. One set of rules.</h2><p>Vector Light, Midnight Club, Paper Club and After Hours keep the same legal moves and competitive balance.</p><a class="pg-text-link" href="/themes">Explore the appearances ${icon('arrow-right')}</a>`, 'pg-news-article')}</div></div>
  </div>`;
}

function offlinePage() {
  return `<div class="pg-page pg-error-page">${panel(empty('cloud', 'Take the next move offline.', 'Online matches, friends and account updates need a connection. You can still try local practice in this loaded website.', actions(button('Start local practice', '/play?mode=practice', 'primary', 'arrow-right'), button('Try the game again', '/game', 'secondary', 'refresh')), '', 'h1'), 'pg-error-card')}${note('Local practice does not change your online rank, mint rewards or save to your cloud profile.')}</div>`;
}

function notFoundPage() {
  return `<div class="pg-page pg-error-page">${panel(`<span class="pg-error-code" aria-hidden="true">404</span><h1>This move leads off the board.</h1><p class="mx-muted">The page could not be found. Your next game is still just a move away.</p>${actions(button('Back to home', '/', 'primary', 'arrow-left'), button('Choose a play mode', '/play', 'secondary', 'swords'))}`, 'pg-error-card')}</div>`;
}

export function renderPage(path, context = {}) {
  const renderers = {
    '/play': playPage, '/casual': casualPage, '/ranked': rankedPage, '/tournaments': tournamentsPage,
    '/season': seasonPage, '/friends': friendsPage, '/challenge': challengePage,
    '/leaderboard': leaderboardPage, '/rewards': rewardsPage, '/themes': themesPage,
    '/profile': profilePage, '/settings': settingsPage, '/account': accountPage,
    '/how-to-play': howToPlayPage, '/support': supportPage, '/help': supportPage, '/accessibility': accessibilityPage, '/about': aboutPage,
    '/privacy': () => legalPage('privacy'), '/terms': () => legalPage('terms'),
    '/delete-account': deletionPage, '/privacy-choices': privacyChoicesPage,
    '/status': statusPage, '/news': newsPage, '/offline': offlinePage, '/404': notFoundPage,
  };
  return Object.prototype.hasOwnProperty.call(renderers, path) ? renderers[path](context) : null;
}
