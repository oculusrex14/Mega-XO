'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const domain = require('../src/domain.js');
const tournament = require('../src/tournament.js');
const { WEBSITE_ROUTES, LEGAL_NAMES } = require('../scripts/p21/build-web.js');
const pages = import(pathToFileURL(path.join(__dirname, '../apps/web/pages.js')).href);
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const number = value => Number(value.replace(/[^0-9]/g, ''));

test('P21.07 every advertised website route renders a page and all rendered links resolve', async () => {
  const { routes, renderPage } = await pages;
  const supported = new Set([...WEBSITE_ROUTES, ...routes.map(route => route.path), '/game', '/game/', '/api/download', ...LEGAL_NAMES.map(name => `/legal/${name}`)]);
  const pressDownloads = new Map(['header', 'mark'].map(name => [`/assets/art/${name}.webp`, path.join(__dirname, `../assets/p21/art/${name}.webp`)]));
  for (const route of WEBSITE_ROUTES.filter(route => !['/', '/game'].includes(route))) {
    const html = renderPage(route, { profile: null, connection: 'guest', now: '2026-10-11T12:00:00Z' });
    assert.ok(typeof html === 'string' && html.length > 150, `${route} has rendered content`);
    assert.ok(routes.some(item => item.path === route), `${route} has route metadata`);
    assert.doesNotMatch(html, /\$\{(?:icon|context|theme|profile|button)\(/, `${route} has no unexpanded template text`);
    for (const match of html.matchAll(/href="(\/[^"#]*)"/g)) {
      const destination = new URL(match[1], 'https://megaxo.online').pathname;
      if (pressDownloads.has(destination)) {
        const source = pressDownloads.get(destination);
        const info = fs.lstatSync(source);
        assert.ok(info.isFile() && !info.isSymbolicLink(), `${route} downloads the regular optimized source for ${destination}`);
        const bytes = fs.readFileSync(source);
        assert.ok(bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP', `${destination} has a real WebP source`);
        continue;
      }
      assert.ok(supported.has(destination) || /^\/legal\/[a-z-]+\.html$/.test(destination), `${route} links to supported ${destination}`);
    }
  }
});

test('P21 leaderboard renders supplied standings inside the website and preserves server tier/order', async () => {
  const { renderPage } = await pages;
  const payload = '<script>bad()</script><img src=x onerror=bad()>';
  const html = renderPage('/leaderboard', {
    sessionStatus: 'linked', profile: { id: 'actor-2', name: 'Me', tier: 'wood', rating: 2700 },
    leaderboard: { status: 'ready', metric: 'rating', scope: 'region', league: 'wood', updatedAt: Date.parse('2026-10-12T01:00:00Z'), rows: [
      { id: 'actor-1', name: payload, tag: 'MEGA-AAA', rating: 2400.75, tier: 'wood', region: payload, position: 1 },
      { id: 'actor-2', name: 'Me', tag: 'MEGA-BBB', rating: 2700, tier: 'wood', region: 'India', position: 2 },
    ] },
  });
  assert.match(html, /class="pg-table pg-standings"/);
  assert.match(html, /data-leaderboard-filter="metric"/);
  assert.match(html, /data-leaderboard-filter="scope"/);
  assert.match(html, /data-leaderboard-filter="league"/);
  assert.match(html, /data-leaderboard-action="refresh"/);
  assert.match(html, /value="region" selected/);
  assert.match(html, /value="wood" selected/);
  assert.match(html, /2,400\.75/);
  assert.ok(html.indexOf('MEGA-AAA') < html.indexOf('MEGA-BBB'), 'the supplied published order is retained');
  assert.match(html, /pg-current-player/);
  assert.match(html, /\/assets\/art\/ranks\/wood\.webp/);
  assert.doesNotMatch(html, /ranks\/grandmaster|<script>|<img src=x|href="\/game/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  const wealth = renderPage('/leaderboard', { leaderboard: { status: 'ready', metric: 'wealth', rows: [{ name: 'Wealthy player', wealth: 3450, rating: 999, tier: 'gold' }] } });
  assert.match(text(wealth), /Coin-equivalent/);
  assert.match(text(wealth), /3,450/);
  assert.doesNotMatch(text(wealth), /999\.00/);
});

test('P21 leaderboard loading, empty and error states never fabricate player rows', async () => {
  const { renderPage } = await pages;
  for (const status of ['loading', 'ready', 'error']) {
    const html = renderPage('/leaderboard', { leaderboard: { status, rows: [], metric: 'rating', scope: 'global', league: 'all' } });
    assert.doesNotMatch(html, /<tbody>|RivalPlayer|Diamond II|href="\/game/);
    assert.match(html, /data-leaderboard-filter="league"/);
    if (status === 'loading') assert.match(html, /aria-busy="true"/);
    if (status === 'error') assert.match(html, /Try again/);
    if (status === 'ready') assert.match(html, /No published players match/);
  }
  assert.doesNotThrow(() => renderPage('/leaderboard', { leaderboard: { status: 'ready', rows: [null], updatedAt: Number.MAX_VALUE } }));
  for (const code of ['AUTH_REQUIRED', 'LINK_ACCOUNT_REQUIRED']) {
    const html = renderPage('/leaderboard', { leaderboard: { status: 'error', code } });
    assert.match(html, /Sign in to play online/);
    assert.match(html, /href="\/account"/);
    assert.doesNotMatch(html, /could not be loaded|Try again|href="\/game/);
  }
  assert.match(renderPage('/leaderboard', { leaderboard: { status: 'error', error: 'AUTH_REQUIRED' } }), /Sign in to play online/);
});

test('P21 personal rank uses the published profile tier, never rating-derived entitlement', async () => {
  const { renderPage } = await pages;
  const ranked = renderPage('/ranked', { sessionStatus: 'linked', profile: { name: 'Real player', tier: 'wood', rating: 2800.25 } });
  const badge = ranked.match(/<div class="pg-rank-gem"[^>]*>([\s\S]*?)<\/div>/)?.[0];
  assert.match(badge, /data-rank-tier="wood"/);
  assert.match(badge, /ranks\/wood\.webp/);
  assert.doesNotMatch(badge, /grandmaster/);
  assert.match(text(ranked), /2,800\.25 rating/);
  for (const tier of domain.TIERS) assert.match(ranked, new RegExp('ranks/' + tier.id + '\\.webp'));
  const guest = renderPage('/ranked', { sessionStatus: 'guest', profile: null }).match(/<div class="pg-rank-gem"[^>]*>([\s\S]*?)<\/div>/)?.[0];
  assert.match(guest, /ranks\/diamond\.webp/);
  const guestCopy = text(renderPage('/ranked', { sessionStatus: 'guest', profile: null }));
  assert.match(guestCopy, /It starts with a move/);
  assert.doesNotMatch(guestCopy, /Diamond ·|Your rank is Diamond/);
  const invalid = renderPage('/ranked', { sessionStatus: 'linked', profile: { tier: '../secrets', rating: 3000 } }).match(/<div class="pg-rank-gem"[^>]*>([\s\S]*?)<\/div>/)?.[0];
  assert.doesNotMatch(invalid, /<img|secrets/);
});

test('P21 profile and reward balances render only the linked supplied profile', async () => {
  const { renderPage } = await pages;
  const profile = { name: 'Actual account', tag: 'MEGA-REAL', tier: 'wood', rating: 2700.25, games: 17, wallet: { coins: 421, crowns: 31 }, cosmeticCredits: 8 };
  const linked = { sessionStatus: 'linked', profile };
  const rewardText = text(renderPage('/rewards', linked));
  assert.match(rewardText, /Coins 421/);
  assert.match(rewardText, /Crowns 31/);
  assert.match(rewardText, /Cosmetic Credits 8/);
  assert.doesNotMatch(rewardText, /Sign in to play online/);
  const accountText = text(renderPage('/profile', linked));
  assert.match(accountText, /Actual account/);
  assert.match(accountText, /Wood 2,700\.25 rating · 17 games/);
  for (const path of ['/profile', '/friends', '/rewards']) {
    const guest = renderPage(path, { sessionStatus: 'guest', profile });
    assert.doesNotMatch(guest, /Actual account|MEGA-REAL|<strong>421<|<strong>31<|<strong>8</);
  }
});

test('P21 account owns one unified continuation and verified recovery flow in the website', async () => {
  const { renderPage } = await pages;
  for (const view of ['email', 'verify', 'recover', 'reset']) {
    const html = renderPage('/account', { sessionStatus: 'guest', accountView: view, accountMessage: '<script>unsafe()</script>', accountEmail: 'test"@example.com' });
    assert.match(html, new RegExp('data-account-form="' + view + '"'));
    assert.doesNotMatch(html, /<script>|action="https:\/\//);
    assert.match(html, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/);
    if (view === 'email') { assert.match(html, /name="email"/); assert.match(html, /name="password"/); assert.match(html, /Continue with email/); }
    if (['verify', 'reset'].includes(view)) assert.match(html, /autocomplete="one-time-code"/);
  }
  assert.doesNotMatch(renderPage('/account', { sessionStatus: 'loading' }), /data-account-form/);
  assert.match(renderPage('/account', { sessionStatus: 'guest' }), /data-provider="google" disabled/);
  assert.doesNotMatch(renderPage('/account', { sessionStatus: 'guest', providers: { google: { web: true }, apple: { web: false } } }), /data-provider="google" disabled/);
  const linked = renderPage('/account', { sessionStatus: 'linked', profile: { id: 'real', name: 'Actual profile', tag: 'MEGA-REAL', tier: 'gold', rating: 1580.35 } });
  assert.match(linked, /Actual profile/);
  assert.match(linked, /data-account-action="logout"/);
  assert.doesNotMatch(linked, /data-account-form/);
});

test('P21 store only renders approved returned products and provider prices', async () => {
  const { renderPage } = await pages;
  const rows = [
    { id: 'crowns_100', enabled: true, localizedPrice: '₹89.00', suggestedUSD: 0.99 },
    { id: 'crowns_525', enabled: false, localizedPrice: '₹449.00' },
    { id: 'crowns_1100', enabled: true },
    { id: 'remove_ads', enabled: true, localizedPrice: '₹359.00', owned: true },
    { id: 'style_collection', enabled: true, title: 'Buy archived frames', localizedPrice: '$9.99' },
  ];
  const html = renderPage('/store', { sessionStatus: 'linked', profile: { wallet: { coins: 47, crowns: 6 } }, products: { status: 'ready', purchasesAvailable: true, rows } });
  assert.equal((html.match(/pg-store-card/g) || []).length, 4);
  assert.match(html, /₹89\.00/);
  assert.match(html, /data-product-id="crowns_100"/);
  assert.doesNotMatch(html, /data-product-id="crowns_100" disabled/);
  assert.match(html, /data-product-id="crowns_525" disabled/);
  assert.match(html, /Price unavailable/);
  assert.match(html, /Owned/);
  assert.doesNotMatch(html, /style_collection|Buy archived frames|\$9\.99|0\.99/);
  const unavailableProvider = renderPage('/store', { sessionStatus: 'linked', products: { status: 'ready', purchasesAvailable: false, rows } });
  assert.match(unavailableProvider, /data-product-id="crowns_100" disabled/);
  const errored = renderPage('/store', { products: { status: 'error', rows } });
  /* A2: a failed read keeps the known product shell visible with prices hidden and every
   * action off, plus one inline retry - it never wipes the page or invents a price. */
  assert.doesNotMatch(errored, /₹89.00|$0.99/);
  assert.equal((errored.match(/pg-store-card/g) || []).length, 4);
  assert.equal((errored.match(/Price unavailable/g) || []).length, 5, 'the pass panel plus the four cards stay honest');
  assert.doesNotMatch(errored, /data-store-action="purchase"/);
  assert.match(errored, /data-store-action="refresh"/);
  const loading = renderPage('/store', { products: { status: 'loading', rows } });
  assert.doesNotMatch(loading, /₹89.00|$0.99|data-store-action="purchase"|pg-store-card/);
  assert.match(loading, /Loading the store/);
});

test('P21 sponsor preferences require explicit local consent and no active advertising', async () => {
  const { renderPage } = await pages;
  const html = renderPage('/sponsors', { sponsorPreferences: { consent: false, interests: [] } });
  assert.match(html, /data-sponsor-preferences/);
  assert.match(html, /name="consent" required/);
  assert.match(html, /saved only in this browser/);
  /* Annotation 2: one wide banner plus six distinct cards of reserved inventory. */
  assert.equal((html.match(/class="pg-ad-label">Advertisement/g) || []).length, 7);
  assert.equal((html.match(/data-sponsor-slot="sponsors-/g) || []).length, 7);
  assert.match(html, /pg-sponsor-disclosure/);
  assert.doesNotMatch(html, /Your game. Your choice./);
  assert.doesNotMatch(html, /Sponsor placements are currently inactive/);
  assert.match(html, /No active sponsor/);
  assert.doesNotMatch(html, /<script|<iframe|https:\/\/.*(?:doubleclick|googlesyndication)|click to earn|reward for clicking/i);
  assert.equal(html, renderPage('/ads', { sponsorPreferences: { consent: false, interests: [] } }));
});

test('P21 full public legal bodies and all wording remain within shared website chrome', async () => {
  const { renderPage } = await pages;
  for (const name of LEGAL_NAMES) {
    const source = fs.readFileSync(path.join(__dirname, '../public', name + '.html'), 'utf8');
    const body = source.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1];
    assert.ok(body);
    const context = { legalDocuments: { ['/' + name]: body } };
    const clean = renderPage('/' + name, context), alias = renderPage('/legal/' + name, context);
    assert.match(clean, /pg-legal-document/);
    assert.ok(clean.includes(body), name + ': full source markup is preserved');
    assert.equal(clean, alias);
    assert.equal((clean.match(/<h1\b/g) || []).length, 1);
    if (['privacy', 'terms'].includes(name)) {
      assert.doesNotMatch(text(clean), /Draft for legal review|Not yet effective|Pending legal approval/);
      assert.match(text(clean), /India-based sole proprietorship/);
    }
  }
});

test('P21.07 profile and Friends render adversarial user names and tags as text', async () => {
  const { renderPage } = await pages;
  const payload = '<img src=x onerror="globalThis.__profileInjected=1"><script>globalThis.__profileInjected=1</script>&\'"';
  const tag = 'MEGA-<svg onload="globalThis.__tagInjected=1">&\'"';
  for (const identity of [{ displayName: payload, username: 'fallback', tag }, { displayName: '', username: payload, tag }]) {
    for (const route of ['/profile', '/friends']) {
      const html = renderPage(route, { profile: identity, connection: 'authenticated' });
      assert.doesNotMatch(html, /<img[^>]+onerror|<script>|<svg[^>]+onload/);
      assert.ok(html.includes('&lt;img src=x onerror=&quot;globalThis.__profileInjected=1&quot;&gt;'));
      assert.ok(html.includes('MEGA-&lt;svg onload=&quot;globalThis.__tagInjected=1&quot;&gt;&amp;&#39;&quot;'));
      assert.match(html, /View \/ edit your profile/);
    }
  }
});

test('P21.07 guest account routes retain account continuation and truthful identity state', async () => {
  const { renderPage } = await pages;
  const account = renderPage('/account', { profile: null, connection: 'guest' });
  assert.match(text(account), /Continue with email/);
  assert.match(text(account), /New players verify mailbox ownership with a six-digit code before the profile is created/);
  assert.match(text(account), /Sign in to play online/);
  assert.doesNotMatch(text(account), /At least one login method must remain linked/);
  const friends = renderPage('/friends', { profile: null });
  const profile = renderPage('/profile', { profile: null });
  assert.match(friends, /Sign in to play online/);
  assert.match(profile, /Sign in to reveal your permanent MEGA tag/);
  assert.doesNotMatch(friends + profile, /MEGA-[A-Z0-9]{4,}|Diamond II|2,450|RivalPlayer/);
});

test('P21.07 rendered league table matches approved domain floors, entry fees and weekly rewards', async () => {
  const { renderPage } = await pages;
  const html = renderPage('/ranked', { profile: null, now: '2026-10-11T12:00:00Z' });
  const body = html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1];
  assert.ok(body, 'league table has a semantic table body');
  const rows = [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(row => {
    const cells = [...row[1].matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/g)].map(cell => text(cell[1]));
    return { name: cells[0], floor: number(cells[1]), fee: number(cells[2]), weekly: number(cells[3]) };
  });
  assert.deepEqual(rows, domain.TIERS.map(tier => ({ name: tier.name, floor: tier.min, fee: tier.fee, weekly: tier.weekly })));
  assert.match(text(html), /New profiles start at 600 rating/);
  assert.match(text(html), /Complete ten lifetime rated placements/);
  assert.match(text(html), /rating floor alone does not guarantee a seat/);
});

test('P21.07 rendered tournament entries and payouts match approved tournament mathematics', async () => {
  const { renderPage } = await pages;
  const html = renderPage('/tournaments', { profile: null });
  /* Annotation 4: exactly ONE catalog mount, rendered client-side from the validated
   * /api/party/capabilities catalog — no static duplicated table set on the page. */
  assert.equal((html.match(/data-tournament-controls/g) || []).length, 1);
  assert.doesNotMatch(html, /pg-tournament-table/);
  const linked = renderPage('/tournaments', { profile: null });
  assert.match(text(linked), /Choose your table/);
  assert.match(text(html), /exactly ten players within a maximum 200 Elo spread/);
  assert.match(text(html), /do not mint normal Ranked win bonuses/);
});

test('P21.07 the live tournament catalog renders the canonical table mathematics', async () => {
  const view = await import(pathToFileURL(path.join(__dirname, '../apps/web/tournaments-view.js')).href);
  const renderTournamentControls = view.renderTournamentControls;
  const tables = Object.keys(tournament.TABLES).map(id => {
    const quote = tournament.prize(id);
    return { table: id, name: quote.name, currency: quote.currency, entry: quote.entry, pool: quote.pool, payouts: quote.payouts, seats: quote.seats };
  });
  const html = renderTournamentControls({ sessionStatus: 'linked', profile: { id: 'po_alice' }, tournaments: { status: 'ready', available: true, room: null, busy: false, tables, message: '', errorCode: '' } }, {});
  const cards = [...html.matchAll(/<article class="pg-panel pg-tournament-table pg-tournament-live-card([^"]*)">([\s\S]*?)<\/article>/g)].map(match => match[2]);
  assert.equal(cards.length, Object.keys(tournament.TABLES).length);
  for (const [index, id] of Object.keys(tournament.TABLES).entries()) {
    const quote = tournament.prize(id);
    const card = cards[index];
    const visible = text(card);
    assert.ok(visible.includes(quote.name + ' table'));
    const entry = number(text(card.match(/pg-tournament-entry"><strong>([\s\S]*?)<\/strong><span>/)?.[1] || ''));
    assert.equal(entry, quote.entry);
    assert.ok(visible.includes(quote.currency === 'crowns' ? 'Crowns entry' : 'Coins entry'));
    const payoutList = card.match(/<ol class="pg-payouts pg-tournament-payouts">([\s\S]*?)<\/ol>/)?.[1];
    assert.ok(payoutList);
    const paid = [...payoutList.matchAll(/<strong>([^<]*)<\/strong>/g)].map(item => number(item[1]));
    assert.deepEqual(paid, quote.payouts.slice(0, 5));
    assert.match(visible, /10% of the original pool is retired/);
    assert.match(card, /data-table="/);
    assert.match(card, /aria-label="Join the /);
  }
});

test('P21.07 reward and challenge copy retain approved currency limits and archived cosmetic direction', async () => {
  const { renderPage } = await pages;
  const rewards = text(renderPage('/rewards'));
  assert.ok(rewards.includes(`${domain.POLICY.startingCoins} Coins`));
  assert.ok(rewards.includes(`${domain.POLICY.coinsPerCrown} Coins = 1 Crown`));
  assert.ok(rewards.includes(`Up to ${domain.POLICY.botDailyCap} Coins/day`));
  assert.ok(rewards.includes(`Up to ${domain.POLICY.rankedBonusDailyCap} Coins/day`));
  assert.ok(rewards.includes(`Up to ${domain.QUESTS.reduce((sum, quest) => sum + quest.reward, 0)} Coins/day`));
  assert.match(rewards, /same utility whether bought or earned/i);
  assert.match(rewards, /Cannot be purchased, converted, transferred or staked/);
  assert.match(rewards, /Local practice on this website does not mint account rewards/);
  assert.doesNotMatch(rewards, /buy frames|unlock frames|Origin.frame|style.collection/i);
  const challenge = text(renderPage('/challenge'));
  assert.match(challenge, /invited player contributes zero/);
  assert.ok(challenge.includes(`between 2 and ${domain.POLICY.friendPotCap} Crowns`));
  assert.match(challenge, /50% of the challenger-funded pot is retired and 50% is paid to the winner/);
  assert.match(challenge, /draw or trusted server void returns the contribution/);
});

test('P21.07 quarter copy follows UTC domain boundaries rather than old screenshot dates', async () => {
  const { renderPage } = await pages;
  for (const timestamp of ['2026-03-31T23:59:59.999Z', '2026-04-01T00:00:00.000Z', '2026-12-31T23:59:59.999Z', '2027-01-01T00:00:00.000Z']) {
    const season = domain.season(Date.parse(timestamp));
    const visible = text(renderPage('/season', { now: timestamp }));
    assert.ok(visible.includes(`Q${season.quarter} ${season.year}`));
    assert.ok(visible.includes(new Date(season.end - 1).toISOString().slice(0, 10) + ' 23:59 UTC'));
    assert.doesNotMatch(visible, /Season 3|2024/);
  }
});

test('P21.07 legal and service pages reflect owner-approved wording and unknown routes fail safely', async () => {
  const { renderPage } = await pages;
  for (const route of ['/privacy', '/terms']) {
    const html = renderPage(route);
    assert.doesNotMatch(text(html), /Draft for legal review|awaiting Antimatter Innovations’ legal approval/);
    assert.ok(html.includes(`href="/legal${route}"`));
  }
  for (const connection of ['guest', 'connected', 'reconnecting', 'error']) {
    const html = renderPage('/status', { connection });
    const status = text(html);
    assert.match(status, /current connection state.*service message/);
    assert.ok([...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].some(anchor => /\bhref="\/game\/?"/.test(anchor[1]) && /Open Mega XOXO/.test(text(anchor[2]))), 'service information directs players to the actual game');
    assert.match(status, /Sign in to play online/);
    assert.doesNotMatch(status, /All systems operational|\d+(?:\.\d+)?% uptime|(?:service|servers?|systems?) (?:is |are )?(?:healthy|operational|down|unavailable)|(?:active|current|ongoing) (?:service )?outage/i, 'a static page must not invent current health, outage or uptime claims');
  }
  for (const route of ['/missing-page', '__proto__', 'constructor', 'toString', '/<script>alert(1)</script>']) assert.equal(renderPage(route), null);
  assert.match(renderPage('/404'), /This move leads off the board/);
});


test('P21 Friends renders only the current actor projection and escapes names without exposing private stats', async () => {
 const {renderPage}=await pages;
 const actor={id:'self',name:'Me',tag:'MEGA-SELF'};
 const player={id:'friend-1',username:'rival',name:'<img src=x onerror=bad()>',tag:'MEGA-RIVAL',relation:'friend',presence:{state:'hidden',online:false},wallet:{crowns:999999},stats:{private:'secret'}};
 const state={actorId:'self',status:'ready',friends:[player],incoming:[],outgoing:[],blocked:[],results:[],query:'',searchStatus:'idle',busy:false,truncated:true};
 const html=renderPage('/friends',{sessionStatus:'linked',profile:actor,friends:state});
 assert.match(html,/data-friends-search/);assert.match(html,/data-friend-action="confirm-remove"/);assert.match(html,/Presence hidden/);
 assert.match(html,/&lt;img src=x onerror=bad\(\)&gt;/);assert.doesNotMatch(html,/<img src=x|999999|secret|Open Friends in game/);
 assert.match(html,/partial list/);
 const switched=renderPage('/friends',{sessionStatus:'linked',profile:{...actor,id:'another'},friends:state});
 assert.doesNotMatch(switched,/MEGA-RIVAL|data-friend-target="friend-1"/);
 const guest=renderPage('/friends',{sessionStatus:'guest',friends:state});assert.doesNotMatch(guest,/MEGA-RIVAL|data-friends-search/);
 const failed=renderPage('/friends',{sessionStatus:'linked',profile:actor,friends:{...state,status:'refresh-error',message:'Your change was accepted, but the updated lists could not be loaded.'}});
 assert.match(failed,/Your change was accepted/);assert.match(failed,/Try again/);assert.doesNotMatch(failed,/MEGA-RIVAL|data-friends-search/);
});
