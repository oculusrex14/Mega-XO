'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const domain = require('../src/domain.js');
const tournament = require('../src/tournament.js');
const { WEBSITE_ROUTES, LEGAL_NAMES } = require('../scripts/p21/build-web.js');
const pages = import(pathToFileURL(path.join(__dirname, '../apps/web/pages.js')).href);
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const number = value => Number(value.replace(/[^0-9]/g, ''));

test('P21.07 every advertised website route renders a page and all rendered links resolve', async () => {
  const { routes, renderPage } = await pages;
  const supported = new Set([...WEBSITE_ROUTES, '/game', '/game/', ...LEGAL_NAMES.map(name => `/legal/${name}`)]);
  for (const route of WEBSITE_ROUTES.filter(route => route !== '/')) {
    const html = renderPage(route, { profile: null, connection: 'guest', now: '2026-10-11T12:00:00Z' });
    assert.ok(typeof html === 'string' && html.length > 150, `${route} has rendered content`);
    assert.ok(routes.some(item => item.path === route), `${route} has route metadata`);
    assert.doesNotMatch(html, /\$\{(?:icon|context|theme|profile|button)\(/, `${route} has no unexpanded template text`);
    for (const match of html.matchAll(/href="(\/[^"#]*)"/g)) {
      const destination = new URL(match[1], 'https://megaxo.online').pathname;
      assert.ok(supported.has(destination) || /^\/legal\/[a-z-]+\.html$/.test(destination), `${route} links to supported ${destination}`);
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
  assert.match(text(account), /At least one login method must remain linked/);
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
  const cards = [...html.matchAll(/<section\b[^>]*pg-tournament-table[^>]*>([\s\S]*?)<\/section>/g)].map(match => match[1]);
  assert.equal(cards.length, Object.keys(tournament.TABLES).length);
  for (const [index, id] of Object.keys(tournament.TABLES).entries()) {
    const quote = tournament.prize(id);
    const card = cards[index];
    const visible = text(card);
    assert.ok(visible.includes(quote.name.toUpperCase() + ' TABLE'));
    const entry = number(text(card.match(/class="pg-price">([\s\S]*?)<span/)?.[1] || ''));
    assert.equal(entry, quote.entry);
    assert.ok(visible.includes(quote.currency === 'crowns' ? 'Crowns entry' : 'Coins entry'));
    const payoutList = card.match(/<ol class="pg-payouts">([\s\S]*?)<\/ol>/)?.[1];
    assert.ok(payoutList);
    const paid = [...payoutList.matchAll(/<strong>([^<]*)<\/strong>/g)].map(item => number(item[1]));
    assert.deepEqual(paid, quote.payouts.slice(0, 5));
    assert.match(visible, /10% of the original pool is retired/);
  }
  assert.match(text(html), /exactly ten players within a maximum 200 Elo spread/);
  assert.match(text(html), /do not mint normal Ranked win bonuses/);
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

test('P21.07 legal and service pages preserve unapproved status and unknown routes fail safely', async () => {
  const { renderPage } = await pages;
  for (const route of ['/privacy', '/terms']) {
    const html = renderPage(route);
    assert.match(text(html), /Draft for legal review/);
    assert.match(text(html), /awaiting Antimatter Innovations’ legal approval/);
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
