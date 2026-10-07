'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

test('static shell uses an inline favicon', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(html.includes('rel="icon"'));
  assert.ok(html.includes('data:image/svg+xml'));
  assert.ok(!html.includes('/favicon.ico'));
});

test('private lobby check happens before online readiness', () => {
  const app = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
  const start = app.indexOf('async function onlineInfo()');
  const end = app.indexOf('async function startQueue()');
  const body = app.slice(start, end);
  assert.ok(body.indexOf("mode==='private'") >= 0);
  assert.ok(body.indexOf("mode==='private'") < body.indexOf('!online.ready'));
  assert.ok(app.includes("removeAttribute('data-kind')"));
});

test('Lucide refresh ignores already-rendered svg icons', () => {
  const icons = fs.readFileSync(path.join(ROOT, 'src', 'icons.js'), 'utf8');
  assert.ok(icons.includes("querySelector('i[data-lucide]')"));
});


test('tournament mode selects before opening', () => {
  const app = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
  const party = fs.readFileSync(path.join(ROOT, 'src', 'party-ui.js'), 'utf8');
  assert.ok(app.includes("['tournament','trophy','Tournaments','Ten players. One table. Bigger prizes.']"));
  assert.ok(app.includes("mode==='tournament'?'Browse Tournaments'"));
  assert.ok(app.includes("mode==='tournament'?(window.MegaParties?.tables"));
  assert.ok(!party.includes("dataset.party='tables'"));
});

test('identity loader plays a themed XO win', () => {
  const community = fs.readFileSync(path.join(ROOT, 'src', 'community.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'community.css'), 'utf8');
  assert.ok(community.includes('xo-loader-strike'));
  assert.ok(community.includes('mark-layer x xo-loader-mark'));
  assert.ok(community.includes('mark-layer o xo-loader-mark'));
  assert.ok(css.includes('@keyframes xo-loader-strike'));
  assert.ok(css.includes("[data-theme='paperclub'] .xo-loader-board"));
  assert.ok(css.includes("[data-theme='afterhours'] .xo-loader-board"));
});

test('Midnight selected mode restores icon tile contrast', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  assert.ok(css.includes(':root[data-theme="midnight"] .mode.active .mode-symbol{'));
  assert.ok(css.includes('background:var(--accent)!important'));
  assert.ok(css.includes('color:var(--on-accent)!important'));
});


test('After Hours XO loader has no stale arcade-route override', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'community.css'), 'utf8');
  assert.ok(!css.includes("[data-theme='afterhours'] .theme-loader span"));
  assert.ok(!css.includes('@keyframes arcade-route'));
  assert.ok(css.includes('.xo-step-1 .xo-loader-mark{animation:xo-mark-1'));
  assert.ok(css.includes('.xo-loader-strike path'));
});

test('each theme owns a separate typography contract', () => {
  const styles = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  const community = fs.readFileSync(path.join(ROOT, 'src', 'community.css'), 'utf8');
  const party = fs.readFileSync(path.join(ROOT, 'src', 'party.css'), 'utf8');
  for (const theme of ['vector','midnight','paperclub','afterhours']) {
    assert.ok(styles.includes(':root[data-theme="'+theme+'"] .setup'));
    assert.ok(community.includes(":root[data-theme='"+theme+"']"));
    assert.ok(party.includes(':root[data-theme="'+theme+'"] .party'));
  }
  assert.ok(styles.includes(':root[data-theme="afterhours"] .setup-chip{font-size:10.5px'));
  assert.ok(styles.includes(':root[data-theme="paperclub"] .setup-chip{border:1.5px solid var(--ink);font-size:12px'));
});


test('V4.1 home and rank polish exposes both currencies and concrete ranked entry cost',()=>{
  const html=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
  const app=fs.readFileSync(path.join(ROOT,'src','app.js'),'utf8');
  const styles=fs.readFileSync(path.join(ROOT,'src','styles.css'),'utf8');
  assert.ok(html.includes('id="walletAmount"'));
  assert.ok(html.includes('id="walletCrownAmount"'));
  assert.ok(app.includes('The Ultimate Tic-tac-toe.'));
  assert.ok(app.includes("Entry cost: '+rankFee+' Coins"));
  assert.ok(app.includes('rank-season-progress'));
  assert.ok(styles.includes('.content-scroll,.bottom-sheet{scrollbar-width:none'));
  assert.ok(styles.includes('.content-scroll::-webkit-scrollbar,.bottom-sheet::-webkit-scrollbar'));
});

test('Rewards & Themes is routed as page content instead of the bottom sheet',()=>{
  const app=fs.readFileSync(path.join(ROOT,'src','app.js'),'utf8');
  const monetization=fs.readFileSync(path.join(ROOT,'src','monetization-ui.js'),'utf8');
  assert.ok(app.includes('rewards:rewards'));
  assert.ok(app.includes("page='rewards'"));
  assert.ok(monetization.includes('function pageMarkup()'));
  assert.ok(monetization.includes('Cosmetic Credits can be used for future cosmetic releases.'));
  assert.ok(!monetization.includes("APP.open('Rewards & Themes'"));
});

test('Paper Club and After Hours home titles avoid awkward Tic-tac-toe wrapping',()=>{
  const app=fs.readFileSync(path.join(ROOT,'src','app.js'),'utf8');
  const styles=fs.readFileSync(path.join(ROOT,'src','styles.css'),'utf8');
  assert.ok(app.includes('class="home-title-main"'));
  assert.ok(app.includes('class="home-game-name"'));
  assert.ok(styles.includes(':root[data-theme="paperclub"] .home-hero h1{font-size:40px;max-width:none}'));
  assert.ok(styles.includes(':root[data-theme="paperclub"] .home-game-name{white-space:nowrap}'));
  assert.ok(styles.includes(':root[data-theme="afterhours"] .home-hero h1{max-width:none}'));
  assert.ok(styles.includes(':root[data-theme="afterhours"] .home-game-name{white-space:nowrap}'));
});

test('rank UI explains quarterly requalification and Elo continuity',()=>{const app=fs.readFileSync(path.join(ROOT,'src','app.js'),'utf8');assert.ok(app.includes('Season requalification'));assert.ok(app.includes('Quarterly seasons'));assert.ok(app.includes('Your Elo is never wiped'));assert.ok(app.includes('Direct ranked challenges count toward activity but are never mandatory'));});

test('stats exposes aggregate tournament record without internal replay-roadmap copy',()=>{const app=fs.readFileSync(path.join(ROOT,'src','app.js'),'utf8'),community=fs.readFileSync(path.join(ROOT,'src','community.js'),'utf8');assert.ok(app.includes("['tournament','Tournaments']"));assert.ok(app.includes('Only completed public tournaments count'));assert.ok(!app.includes('Match history and replays are reserved for a future update'));assert.ok(community.includes("['tournament','Tournaments']"));});


test('network resilience keeps write retries idempotent and exposes user-safe connection states',()=>{
  const account=fs.readFileSync(path.join(ROOT,'src','account-client.js'),'utf8');
  const app=fs.readFileSync(path.join(ROOT,'src','app.js'),'utf8');
  const html=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
  const styles=fs.readFileSync(path.join(ROOT,'src','styles.css'),'utf8');
  assert.ok(account.includes("const operationKey=body===undefined?null:(operation||id())"));
  assert.ok(account.includes("'Idempotency-Key':operationKey"));
  assert.ok(account.includes("attempts=body===undefined?3:2"));
  assert.ok(account.includes("publish('reconnecting'"));
  assert.ok(html.includes('id="contentScroll" class="content-scroll"'));
  assert.ok(html.indexOf('id="contentScroll"')<html.indexOf('id="networkStatus"'));
  assert.ok(html.indexOf('id="networkStatus"')<html.indexOf('id="page"'));
  assert.ok(styles.includes('.content-scroll{flex:1;min-height:0;overflow:auto'));
  assert.ok(styles.includes('#page{min-height:100%;padding:8px 18px 24px;overflow:visible}'));
  for(const theme of ['vector','midnight','paperclub','afterhours'])assert.ok(styles.includes(':root[data-theme="'+theme+'"] .network-status'));
  for(const state of ['offline','maintenance','auth','timeout','degraded','reconnecting'])assert.ok(app.includes(state+':'));
  assert.ok(app.includes("if(onlinePollBusy)return;onlinePollBusy=true"));
  assert.ok(app.includes("$('#contentScroll').scrollTop=0"));
  assert.ok(app.includes("retrynetwork:()=>retryNetwork()"));
});


test('Crown-entry disclosures preserve bought-Crown utility without promising cash value',()=>{
  const app=fs.readFileSync(path.join(ROOT,'src','app.js'),'utf8');
  const party=fs.readFileSync(path.join(ROOT,'src','party-ui.js'),'utf8');
  assert.ok(app.includes('Bought and earned Crowns are treated the same where ranked Crown challenges are available.'));
  assert.ok(app.includes('Crowns have no cash value or cash-out.'));
  assert.ok(party.includes('Bought and earned virtual currency are treated the same where this table is available.'));
  assert.ok(party.includes('Coins and Crowns have no cash value or cash-out.'));
  assert.ok(party.includes('cancelled or voided events refund automatically'));
});
