'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
const domain = require('../src/domain.js');
globalThis.MegaGame = require('../src/game.js');
const {WEBSITE_ROUTES} = require('../scripts/p21/build-web.js');
const pages = import(pathToFileURL(path.join(__dirname, '../apps/web/pages.js')).href);
const site = import(pathToFileURL(path.join(__dirname, '../apps/web/site.js')).href);
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const profile = {id:'fixture-self', tag:'MEGA-FIXTURE', name:'Actual player', tier:'silver', rating:1420.25, games:21, wallet:{coins:17, crowns:3}};
const linked = {sessionStatus:'linked', profile};

test('P21 annotations: every play entry reaches the one mode-aware game workspace', async () => {
  const {renderPage} = await pages;
  const {renderHome, renderRankPanel} = await site;
  const home = renderHome();
  assert.match(home, /href="\/play"[^>]*>[\s\S]*?Play Now/);
  const choice = renderPage('/play');
  assert.match(choice, /href="\/game\?mode=ranked"/);
  assert.match(choice, /href="\/game\?mode=casual"/);
  assert.match(choice, /href="\/game\?mode=bot"/);
  assert.match(text(choice), /Start practicing with bots/);
  assert.doesNotMatch(choice, /practice-mount/);
  for (const tab of ['ranked', 'casual', 'friends']) {
    const html = renderRankPanel(linked, tab);
    assert.doesNotMatch(html, /\/play\?mode=practice|\/game\//);
    if (tab !== 'friends') assert.match(html, new RegExp('/game\\?mode=' + tab));
  }
});

test('P21 annotations: signed-in public pages remove signed-out prompts, and loading stays neutral', async () => {
  const {renderPage} = await pages;
  for (const route of ['/rewards','/challenge','/season','/casual','/store','/leaderboard']) {
    const html = renderPage(route, linked);
    assert.doesNotMatch(text(html), /Sign in to play online|Sign in to your profile|Link your permanent profile before|Sign in to view invitations/gi, route);
  }
  for (const route of ['/rewards','/challenge','/season','/store','/ranked']) {
    const html = renderPage(route, {sessionStatus:'loading', profile});
    assert.doesNotMatch(html, /pg-signin/, route);
    assert.match(html, /Checking your account/, route);
  }
  const stale = renderPage('/leaderboard', {...linked, leaderboard:{status:'error',code:'AUTH_REQUIRED'}});
  assert.doesNotMatch(stale, /Sign in to play online/);
  assert.match(stale, /Refresh standings/);
});

test('P21 annotations: player card uses real identity, published rank and canonical rating boundaries', async () => {
  const {renderPage} = await pages;
  const html = renderPage('/leaderboard', linked);
  assert.match(html, /pg-player-id-card/);
  assert.match(text(html), /Actual player/);
  assert.match(text(html), /Player ID MEGA-FIXTURE/);
  assert.match(html, /ranks\/silver\.webp/);
  const current = domain.TIERS.find(tier => tier.id === 'silver');
  const next = domain.TIERS[domain.TIERS.indexOf(current) + 1];
  assert.match(text(html), new RegExp(next.name));
  assert.match(text(html), /120\.25 rating above the Silver floor/);
  assert.match(text(html), /79\.75 to the next rating floor/);
  const value = Number(html.match(/<progress[^>]*max="100" value="([^"]+)"/)?.[1]);
  assert.ok(Math.abs(value - ((profile.rating - current.min) / (next.min - current.min)) * 100) < .0001);
  const mismatched = renderPage('/leaderboard', {sessionStatus:'linked',profile:{...profile,tier:'wood',rating:2800}});
  assert.match(mismatched, /ranks\/wood\.webp/);
  assert.doesNotMatch(mismatched, /ranks\/grandmaster\.webp/);
  assert.match(text(mismatched), /published league remains the one shown/);
  const limited = renderPage('/leaderboard', {sessionStatus:'linked',profile:{...profile,tier:'emerald',rating:2195}});
  assert.match(text(limited), /limited weekly seats/);
  assert.match(text(limited), /does not guarantee promotion/);
});

test('P21 annotations: placement progress, missing data and adversarial identity never fabricate rank', async () => {
  const {renderPage} = await pages;
  const html = renderPage('/leaderboard', {sessionStatus:'linked',profile:{...profile,name:'<script>unsafe()</script>',tag:'MEGA-<unsafe>',tier:null,games:3}});
  assert.match(html, /max="10" value="3"/);
  assert.match(html, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/);
  assert.match(html, /MEGA-&lt;unsafe&gt;/);
  assert.doesNotMatch(html, /<script>|Rating toward|ranks\/silver/);
  const missing = renderPage('/leaderboard', {sessionStatus:'linked',profile:{id:'self',tier:null}});
  assert.doesNotMatch(missing, /<progress|NaN|Infinity/);
  const guest = renderPage('/leaderboard', {sessionStatus:'guest',profile});
  assert.doesNotMatch(guest, /MEGA-FIXTURE|Actual player|pg-player-id-card/);
});

test('P21 annotations: redundant public account/download/settings panels are removed', async () => {
  const {renderPage, routes} = await pages;
  const {renderFooter,renderHeader} = await site;
  assert.equal(renderPage('/settings'),null);
  assert.ok(!WEBSITE_ROUTES.includes('/settings'));
  assert.ok(!routes.some(route=>route.path==='/settings'));
  for (const html of [renderFooter(), renderHeader('/'), renderPage('/offline')]) assert.doesNotMatch(html, /href="\/settings"/);
  const account = renderPage('/account',linked);
  assert.doesNotMatch(account, /At least one login method must remain linked/);
  assert.match(account, /data-account-action="logout"/);
  const download = renderPage('/download');
  assert.doesNotMatch(download, /One profile across supported clients|A clear route to the app|links will appear here/);
  assert.match(text(download), /Play instantly in your browser/);
  assert.match(download, /href="\/api\/download\?platform=ios"/);
});

test('P21 annotations: compact sponsor choices keep explicit consent and truthful empty placements', async () => {
  const {renderPage} = await pages;
  const html = renderPage('/sponsors',{sponsorPreferences:{consent:false,interests:[]}});
  assert.doesNotMatch(html, /Sponsor placements are currently inactive|tracking scripts|reserved space/i);
  assert.match(html, /pg-sponsor-preferences-grid/);
  assert.match(html, /name="consent" required/);
  assert.match(html, /No active sponsor/);
  assert.match(html, /enable no third-party tracking/);
  assert.doesNotMatch(html, /<iframe|<script|click to earn/i);
});

test('P21 annotations: the guide launches the existing six-move tutorial rather than a separate lesson', async () => {
  const {renderPage} = await pages;
  const html = renderPage('/how-to-play');
  assert.match(html, /href="\/game\?tutorial=guided"/);
  assert.match(text(html), /Still finding your way/);
  assert.match(text(html), /Six guided moves/);
  assert.doesNotMatch(html, /Choose a play mode|\/play\?mode=practice/);
});
