'use strict';

// Browser acceptance for protected Friends flows. This runner never builds or
// guesses an artifact: it verifies the requested manifest, snapshots its exact
// payload, then uses fresh unauthenticated browser state and synthetic APIs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { ROOT, MANIFEST } = require('./build-web.js');
const { createPreviewServer } = require('./serve-web.js');

const EXPECTED_POST_FIELDS = ['action', 'key', 'target'];
const ENGINES = new Set(['chromium', 'firefox', 'webkit']);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const shellQuote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
function refuse(message) { throw new Error('P21_FRIENDS_QA_REFUSED: ' + message); }

function parseArgs(argv) {
  const values = {};
  const names = new Set(['--bundle', '--expect-source', '--expect-bundle', '--browser', '--output-root']);
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (!names.has(name) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      refuse('usage: node scripts/p21/friends-qa.cjs --bundle STATIC-ARTIFACT --expect-source COMMIT --expect-bundle SHA256 [--browser chromium|firefox|webkit] [--output-root PATH]');
    }
    values[name.slice(2)] = argv[++i];
  }
  for (const name of ['bundle', 'expect-source', 'expect-bundle']) if (!values[name]) refuse('--' + name + ' is required; the runner never builds or guesses an artifact');
  values.browser ||= 'chromium';
  if (!ENGINES.has(values.browser)) refuse('--browser must be chromium, firefox, or webkit');
  if (!/^[a-f\d]{40}$/i.test(values['expect-source'])) refuse('--expect-source must be a full 40-character commit SHA');
  if (!/^[a-f\d]{64}$/i.test(values['expect-bundle'])) refuse('--expect-bundle must be a full SHA-256 digest');
  return values;
}

function safePayloadPath(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\')) refuse('manifest contains an unsafe payload path');
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep)) refuse('manifest path escapes the artifact');
  return target;
}

function verifyArtifact(bundleArgument, sourceCommit, bundleDigest) {
  const bundle = path.resolve(bundleArgument);
  if (!fs.existsSync(bundle) || fs.realpathSync(bundle) !== bundle || !fs.lstatSync(bundle).isDirectory()) refuse('--bundle must be an existing, unlinked artifact directory');
  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, MANIFEST), 'utf8'));
  if (manifest.generator !== 'scripts/p21/build-web.js' || !Array.isArray(manifest.files)) refuse('unrecognized P21 build manifest');
  if (manifest.source_commit !== sourceCommit || manifest.bundle_sha256 !== bundleDigest) refuse('artifact identity does not match the explicit expected commit and digest');
  if (manifest.api?.configured !== false || manifest.api?.preview_read_seam !== 'explicit P21_READ_API_ORIGIN only; GET /api/v1/leaderboard; no credential forwarding') refuse('artifact must have the public read seam disabled');
  const seen = new Set(), rows = [];
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || !/^[a-f\d]{64}$/i.test(file.sha256) || !Number.isSafeInteger(file.bytes)) refuse('artifact inventory is malformed');
    if (seen.has(file.path)) refuse('artifact inventory contains a duplicate path');
    seen.add(file.path);
    const target = safePayloadPath(bundle, file.path);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(target) !== target) refuse('artifact payload is missing or linked');
    const bytes = fs.readFileSync(target);
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) refuse('artifact payload checksum mismatch: ' + file.path);
    rows.push(file.path + '\0' + file.bytes + '\0' + file.sha256);
  }
  if (sha256(Buffer.from(rows.join('\0'))) !== bundleDigest) refuse('recomputed build digest does not match');
  return { bundle, manifest };
}

function copySnapshot(artifact, destination) {
  for (const file of artifact.manifest.files) {
    const source = safePayloadPath(artifact.bundle, file.path);
    const target = safePayloadPath(destination, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  }
  fs.writeFileSync(path.join(destination, MANIFEST), JSON.stringify(artifact.manifest, null, 2) + '\n', { flag: 'wx' });
}

function makePlayer(id, relation, extra = {}) {
  const username = extra.username || 'player_' + id.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 18);
  const name = extra.name || 'Fixture ' + id.replaceAll('-', ' ');
  return {
    id, username, name, displayName:name, tag:'MEGA-' + id.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(-10),
    avatar:'rook', relation, presence:{state:'hidden', online:false}, rating:2700.25, games:42, tier:'grandmaster',
    stats:{private:true, marker:'PRIVATE_STATS_FIXTURE'}, wallet:{coins:99123, crowns:88}, email:'private@example.invalid',
    match:{id:'PRIVATE_MATCH_FIXTURE'}, season:{secret:'PRIVATE_SEASON_FIXTURE'}, ...extra,
  };
}

function createFixture() {
  const people = new Map();
  const add = row => { people.set(row.id, row); return row; };
  const actorProfiles = {
    'fixture-actor-one': {id:'fixture-actor-one', username:'fixture_one', displayName:'Fixture Actor One', name:'Fixture Actor One', tag:'MEGA-ACTORONE', tier:'wood', rating:900.5, games:3, region:'IN', statsVisibility:'private', presenceVisibility:'hidden', wallet:{coins:777, crowns:9}, season:{secret:'SELF_PRIVATE_FIXTURE'}},
    'fixture-actor-two': {id:'fixture-actor-two', username:'fixture_two', displayName:'Fixture Actor Two', name:'Fixture Actor Two', tag:'MEGA-ACTORTWO', tier:'silver', rating:1400.25, games:20, region:'IN', statsVisibility:'private', presenceVisibility:'hidden', wallet:{coins:888, crowns:10}},
  };
  const firstLists = {
    friends:[add(makePlayer('friend-remove','friend',{name:'Rival & Remove',username:'rival_remove'})), add(makePlayer('friend-block','friend',{name:'Rival & Block',username:'rival_block'}))],
    incoming:[add(makePlayer('incoming-accept','incoming',{name:'Incoming Accept',username:'incoming_accept'})), add(makePlayer('incoming-decline','incoming',{name:'Incoming Decline',username:'incoming_decline'}))],
    outgoing:[add(makePlayer('outgoing-cancel','outgoing',{name:'Outgoing Cancel',username:'outgoing_cancel'}))],
    blocked:[{id:'blocked-unblock',username:'blocked_fixture'}], truncated:true,
  };
  const secondLists = {
    friends:[add(makePlayer('actor-two-friend','friend',{name:'Actor Two Friend',username:'actor_two_friend'}))],
    incoming:[], outgoing:[], blocked:[], truncated:false,
  };
  const listsByActor = {'fixture-actor-one':firstLists, 'fixture-actor-two':secondLists};
  const fixture = {
    csrf:'synthetic-csrf-fixture', actors:actorProfiles, currentActor:'fixture-actor-one', listsByActor,
    people, wireEvents:[], apiResponseHeaders:[], blockedExternal:new Set(), pendingGate:null,
    failNextFriendsRead:null, transientTargets:new Set(), transientFailuresUsed:new Set(),
    holdNext(method, pathname, predicate = () => true) {
      if (fixture.pendingGate) throw new Error('A synthetic Friends API gate is already pending.');
      let observedResolve, replyResolve;
      const observed = new Promise(resolve => { observedResolve = resolve; });
      const reply = new Promise(resolve => { replyResolve = resolve; });
      const gate = {method, pathname, predicate, observed, reply, release:outcome => replyResolve(outcome), announce:event => observedResolve(event)};
      fixture.pendingGate = gate;
      return gate;
    },
    searchRows(q) {
      if (q === 'evil') return [makePlayer('evil-result','none',{name:'Rival & Safe',username:'<svg/onload="window.__p21Xss=1">'})];
      if (q === 'limit') return Array.from({length:20},(_,i)=>makePlayer('limit-'+i,'none',{name:'Limited Player '+i,username:'limited_'+i}));
      if (q === 'overflow') return Array.from({length:21},(_,i)=>makePlayer('overflow-'+i,'none',{name:'Overflow Player '+i,username:'overflow_'+i}));
      if (q === 'alpha') return [makePlayer('alpha-result','none',{name:'Alpha Result',username:'alpha_result'})];
      if (q === 'beta') return [makePlayer('beta-result','none',{name:'Beta Result',username:'beta_result'})];
      const id = ({
        'actor-race':'actor-race-player', 'route-race':'route-race-player', 'logout-race':'logout-race-player',
        retry:'retry-player', 'final-check':'final-check-player',
      })[q] || 'search-' + q.replace(/[^a-z0-9]/gi,'').toLowerCase().slice(0,32);
      const player = people.get(id) || makePlayer(id,'none',{name:'Search '+q,username:'search_'+q.replace(/[^a-z0-9_]/gi,'').slice(0,24)});
      people.set(player.id, player);
      return [player];
    },
    applyAction(body) {
      const actor = fixture.currentActor;
      const lists = fixture.listsByActor[actor];
      const {action, target} = body;
      const all = ['friends','incoming','outgoing','blocked'];
      const prior = people.get(target) || makePlayer(target, 'none');
      if (action === 'request') {
        all.forEach(kind => { lists[kind] = lists[kind].filter(row => row.id !== target); });
        lists.outgoing.push({...prior, relation:'outgoing'});
      } else if (action === 'accept') {
        const row = lists.incoming.find(item => item.id === target) || prior;
        lists.incoming = lists.incoming.filter(item => item.id !== target);
        lists.outgoing = lists.outgoing.filter(item => item.id !== target);
        lists.friends.push({...row, relation:'friend'});
      } else if (action === 'decline') lists.incoming = lists.incoming.filter(item => item.id !== target);
      else if (action === 'cancel') lists.outgoing = lists.outgoing.filter(item => item.id !== target);
      else if (action === 'remove') lists.friends = lists.friends.filter(item => item.id !== target);
      else if (action === 'block') {
        all.forEach(kind => { lists[kind] = lists[kind].filter(row => row.id !== target); });
        lists.blocked.push({id:target,username:prior.username});
      } else if (action === 'unblock') lists.blocked = lists.blocked.filter(item => item.id !== target);
    },
    async handle(route) {
      const request = route.request(), url = new URL(request.url()), method = request.method(), pathname = url.pathname, headers = request.headers();
      let body;
      try { if (request.postData()) body = JSON.parse(request.postData()); } catch {}
      const event = {
        method, path:pathname,
        query_present:url.searchParams.has('q'), query_length:(url.searchParams.get('q') || '').length,
        action:typeof body?.action === 'string' ? body.action : null,
        target:typeof body?.target === 'string' ? body.target : null,
        field_names:body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).sort() : [],
        body_key_present:typeof body?.key === 'string' && body.key.length > 0,
        csrf_header_present:Boolean(headers['x-csrf-token']), csrf_matches_fixture:headers['x-csrf-token'] === fixture.csrf,
        idempotency_header_present:Boolean(headers['idempotency-key']),
        idempotency_header_matches_body:typeof body?.key === 'string' && headers['idempotency-key'] === body.key,
        cookie_header_present:Boolean(headers.cookie),
      };
      fixture.wireEvents.push(event);

      const gate = fixture.pendingGate;
      if (gate && gate.method === method && gate.pathname === pathname && gate.predicate({url, body, event, headers})) {
        fixture.pendingGate = null;
        gate.announce({...event});
        const held = await gate.reply;
        event.reply_status = held.status;
        if (method === 'POST' && pathname === '/api/community/friend' && held.status >= 500 && body?.target) fixture.transientFailuresUsed.add(body.target);
        if (method === 'POST' && pathname === '/api/community/friend' && held.status === 200 && held.body?.ok === true) fixture.applyAction(body);
        return route.fulfill({status:held.status,contentType:'application/json',headers:{'cache-control':'private, no-store','x-content-type-options':'nosniff'},body:JSON.stringify(held.body)});
      }

      let status = 200, result = {error:'WEB_API_NOT_CONFIGURED'};
      if (method === 'GET' && pathname === '/api/v1/profile') result = {...fixture.actors[fixture.currentActor]};
      else if (method === 'GET' && pathname === '/api/account/session') result = {csrf:fixture.csrf,linked:true,providers:{}};
      else if (method === 'GET' && pathname === '/api/community/friends') {
        if (fixture.failNextFriendsRead) {
          const failed = fixture.failNextFriendsRead;fixture.failNextFriendsRead = null;status = failed.status;result = {error:failed.error};
        } else result = JSON.parse(JSON.stringify(fixture.listsByActor[fixture.currentActor]));
      } else if (method === 'GET' && pathname === '/api/community/search') result = fixture.searchRows(url.searchParams.get('q') || '');
      else if (method === 'POST' && pathname === '/api/community/friend') {
        const fields = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).sort() : [];
        if (JSON.stringify(fields) !== JSON.stringify(EXPECTED_POST_FIELDS) || !event.body_key_present || !event.idempotency_header_matches_body || !event.csrf_matches_fixture || event.cookie_header_present) {
          status = 400;result = {error:'INVALID_FRIEND_FIXTURE'};
        } else if (fixture.transientTargets.has(body.target) && !fixture.transientFailuresUsed.has(body.target)) {
          fixture.transientFailuresUsed.add(body.target);status = 503;result = {error:'SERVICE_UNAVAILABLE'};
        } else {
          fixture.applyAction(body);result = {ok:true};
        }
      } else if (method === 'POST' && pathname === '/api/account/logout') result = {ok:true};
      else { status = 503; result = {error:'WEB_API_NOT_CONFIGURED'}; }
      event.reply_status = status;
      return route.fulfill({status,contentType:'application/json',headers:{'cache-control':'private, no-store','x-content-type-options':'nosniff'},body:JSON.stringify(result)});
    },
  };
  return fixture;
}

function check(report, id, passed, evidence = {}) {
  const row = {id, result:passed ? 'PASS' : 'FAIL', ...evidence};
  report.checks.push(row);
  if (!passed) report.failures.push(row);
  return passed;
}

async function navigateByHistory(page, href) {
  await page.evaluate(pathname => { history.pushState({}, '', pathname);window.dispatchEvent(new PopStateEvent('popstate',{state:{}})); }, href);
}
async function statusText(page, selector = '[data-friends-status]') {
  return page.locator(selector).textContent().then(value => (value || '').trim());
}
async function waitForCanonicalReady(page) {
  await page.waitForFunction(() => {
    const controls=document.querySelector('#friends-controls');
    const status=(document.querySelector('[data-friends-status]')?.textContent||'').trim();
    return controls?.getAttribute('aria-busy')==='false' && [
      'Your Friends lists are up to date.',
      'Your change was accepted. These lists are partial; more players are available on the service.',
      'These lists are partial. The service has more players than it can show here.',
    ].includes(status);
  },null,{timeout:10000});
}
function fixtureSummary(fixture, blockedExternal, shortQueryCalls = null) {
  if (!fixture) return null;
  const posts=fixture.wireEvents.filter(row=>row.method==='POST'&&row.path==='/api/community/friend');
  return {
    synthetic_api_requests:fixture.wireEvents.length,
    friends_gets:fixture.wireEvents.filter(row=>row.method==='GET'&&row.path==='/api/community/friends').length,
    search_gets:fixture.wireEvents.filter(row=>row.method==='GET'&&row.path==='/api/community/search').length,
    short_query_network_calls:shortQueryCalls,
    friend_post_attempts:posts.length,action_names:[...new Set(posts.map(row=>row.action).filter(Boolean))].sort(),
    all_friend_posts_whitelisted:posts.every(row=>JSON.stringify(row.field_names)===JSON.stringify(EXPECTED_POST_FIELDS)),
    all_friend_posts_have_matching_idempotency_key:posts.every(row=>row.body_key_present&&row.idempotency_header_present&&row.idempotency_header_matches_body),
    all_friend_posts_have_synthetic_csrf:posts.every(row=>row.csrf_matches_fixture),
    requests_with_cookie_headers:fixture.wireEvents.filter(row=>row.cookie_header_present).length,
    api_responses_private_no_store:fixture.apiResponseHeaders.filter(row=>row.cache_control==='private, no-store').length,
    other_origins_blocked:blockedExternal?.size||0,
    recent_api_events:fixture.wireEvents.slice(-8).map(row=>({method:row.method,path:row.path,action:row.action,target:row.target,field_names:row.field_names,reply_status:row.reply_status,body_key_present:row.body_key_present,idempotency_header_matches_body:row.idempotency_header_matches_body,csrf_matches_fixture:row.csrf_matches_fixture})),
  };
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  let playwright, axe;
  try { playwright = require('playwright'); } catch { refuse('Playwright is unavailable; set NODE_PATH to the installed runtime node_modules directory'); }
  try { axe = require('axe-core'); } catch { refuse('axe-core is unavailable in the selected browser runtime'); }
  let playwrightVersion = 'unknown';
  try { playwrightVersion = require('playwright/package.json').version || 'unknown'; } catch {}

  const artifact = verifyArtifact(args.bundle,args['expect-source'],args['expect-bundle']);
  const outputBase = path.resolve(args['output-root'] || path.join(ROOT,'tests-output/p21-web'));
  const stamp = new Date().toISOString().replace(/[^0-9]/g,'') + '-' + process.pid;
  const output = path.join(outputBase,artifact.manifest.bundle_sha256.slice(0,12),'friends-'+args.browser,stamp);
  fs.mkdirSync(output,{recursive:true});
  const snapshot = fs.mkdtempSync(path.join(ROOT,'.artifacts/.p21-friends-qa-'));
  let browser, server, fixture, page, shortQueryCalls=null;
  const report = {
    schema_version:1, checked_at:new Date().toISOString(), source_commit:artifact.manifest.source_commit,
    bundle_sha256:artifact.manifest.bundle_sha256, bundle_files:artifact.manifest.files.length,
    bundle_bytes:artifact.manifest.files.reduce((sum,row)=>sum+row.bytes,0), browser_engine:args.browser,
    runtime_version:process.version, playwright_version:playwrightVersion, axe_version:axe.version,
    command:'env -u NODE_OPTIONS NODE_PATH='+shellQuote(process.env.NODE_PATH || '')+' '+shellQuote(process.execPath)+' scripts/p21/friends-qa.cjs --bundle '+shellQuote(args.bundle)+' --expect-source '+args['expect-source']+' --expect-bundle '+args['expect-bundle']+' --browser '+args.browser,
    qa_script_sha256:sha256(fs.readFileSync(__filename)),
    environment:'Local loopback only; checksum-verified immutable artifact snapshot; fresh unauthenticated browser context; synthetic linked actors and friend fixtures; all other origins blocked.',
    fixture_boundary:'All account identity, Friends reads/search/mutations, CSRF, refreshes and logout are synthetic browser route fixtures. No authenticated user browser, real account, provider, production API or external origin was used.',
    isolated_payload_snapshot:true, checks:[], failures:[], screenshots:[], api_fixture_summary:null,
    limitations:['Synthetic browser software acceptance only; no live API, authenticated user account, physical device or production acceptance.','Automated axe checks do not replace physical VoiceOver or TalkBack acceptance.'],
  };
  const screenshot = async (page,name) => {
    const target=path.join(output,name+'.png');await page.screenshot({path:target,fullPage:true,animations:'disabled'});
    report.screenshots.push(path.relative(ROOT,target));
  };
  try {
    copySnapshot(artifact,snapshot);
    server=createPreviewServer({directory:snapshot,readApiOrigin:null});server.listen(0,'127.0.0.1');await once(server,'listening');
    const origin='http://127.0.0.1:'+server.address().port;
    browser=await playwright[args.browser].launch({headless:true});report.browser_version=browser.version();
    const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce',serviceWorkers:'block'});
    const blockedExternal=new Set();
    await context.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.origin===origin||['data:','blob:'].includes(url.protocol))return route.continue();
      blockedExternal.add(url.origin);return route.abort('blockedbyclient');
    });
    fixture=createFixture();
    await context.route(origin+'/api/**',route=>fixture.handle(route));
    page=await context.newPage();
    const javascriptErrors=[];
    page.on('pageerror',error=>javascriptErrors.push(String(error.message).slice(0,240)));
    page.on('response',async response=>{
      const url=new URL(response.url());
      if(url.origin===origin&&url.pathname.startsWith('/api/')){
        const headers=await response.allHeaders();fixture.apiResponseHeaders.push({path:url.pathname,cache_control:headers['cache-control']||''});
      }
    });
    await page.addInitScript(()=>{
      const audit={reads:[],writes:[],removals:[]};Object.defineProperty(window,'__p21StorageAudit',{value:audit,configurable:false});
      const originals={getItem:Storage.prototype.getItem,setItem:Storage.prototype.setItem,removeItem:Storage.prototype.removeItem};
      Storage.prototype.getItem=function(key){if(this===window.localStorage)audit.reads.push(String(key));return originals.getItem.call(this,key);};
      Storage.prototype.setItem=function(key,value){if(this===window.localStorage)audit.writes.push(String(key));return originals.setItem.call(this,key,value);};
      Storage.prototype.removeItem=function(key){if(this===window.localStorage)audit.removals.push(String(key));return originals.removeItem.call(this,key);};
    });

    await page.goto(origin+'/friends',{waitUntil:'networkidle'});
    await page.getByRole('heading',{name:'Your people. Your next move.'}).waitFor();
    await page.getByText('Rival & Remove',{exact:true}).waitFor();
    const initial=await page.evaluate(()=>({
      url:location.pathname,actorName:document.querySelector('.pg-self-card h2')?.textContent?.trim(),
      groupCounts:Object.fromEntries(['friend-requests','friend-outgoing','friend-list','friend-blocked'].map(id=>[id,document.querySelectorAll('#'+id+' .pg-friend-row').length])),
      hiddenPresence:[...document.querySelectorAll('.pg-friend-identity small')].map(el=>el.textContent.trim()),
      searchLabel:document.querySelector('label[for="friend-query"]')?.textContent.trim(),
      searchHelp:document.querySelector('#friend-query')?.getAttribute('aria-describedby'),
      status:{role:document.querySelector('[data-friends-status]')?.getAttribute('role'),tabIndex:document.querySelector('[data-friends-status]')?.tabIndex},
      truncation:document.querySelector('#friends-controls')?.textContent.includes('This is a limited list.'),
      rows:[...document.querySelectorAll('#friends-controls .pg-friend-row')].map(row=>row.querySelector('.pg-friend-identity strong')?.textContent.trim()),
      privateMarkers:/PRIVATE_STATS_FIXTURE|PRIVATE_MATCH_FIXTURE|PRIVATE_SEASON_FIXTURE|SELF_PRIVATE_FIXTURE|99123|777/.test(document.querySelector('#main')?.textContent||''),
    }));
    check(report,'P21-FRIENDS-SYNTHETIC-PROTECTED-LOAD',initial.url==='/friends'&&initial.groupCounts['friend-list']===2&&initial.groupCounts['friend-requests']===2&&initial.groupCounts['friend-outgoing']===1&&initial.groupCounts['friend-blocked']===1&&fixture.wireEvents.some(row=>row.method==='GET'&&row.path==='/api/community/friends'),{
      route:initial.url,group_counts:initial.groupCounts,protected_friends_get:fixture.wireEvents.filter(row=>row.method==='GET'&&row.path==='/api/community/friends').length,
    });
    check(report,'P21-FRIENDS-PRIVACY-AND-PRESENCE-PROJECTION',initial.hiddenPresence.every(value=>value==='Presence hidden')&&initial.privateMarkers===false,{
      hidden_presence_rows:initial.hiddenPresence.length,all_presence_hidden:initial.hiddenPresence.length>0&&initial.hiddenPresence.every(value=>value==='Presence hidden'),private_fixture_markers_visible:initial.privateMarkers,
    });
    check(report,'P21-FRIENDS-ACCESSIBLE-SEARCH-AND-STATUS',initial.searchLabel==='Find a player'&&initial.searchHelp==='friend-search-help'&&initial.status.role==='status'&&initial.status.tabIndex===-1,{
      search_label_present:initial.searchLabel==='Find a player',help_reference:initial.searchHelp,status_role:initial.status.role,status_tab_index:initial.status.tabIndex,
    });
      check(report,'P21-FRIENDS-SOURCE-ARRAYS-AND-RENDER-LIMITS',initial.truncation&&initial.rows.length===6&&JSON.stringify(initial.rows.sort())===JSON.stringify(['Incoming Accept','Incoming Decline','Outgoing Cancel','Rival & Block','Rival & Remove','blocked_fixture'].sort()),{
      rendered_list_rows:initial.rows.length,source_groups:initial.groupCounts,partial_list_notice:initial.truncation,
    });
    check(report,'P21-FRIENDS-INITIAL-REFLOW-390',await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1),{
      viewport_width:390,scroll_width:await page.evaluate(()=>document.documentElement.scrollWidth),
    });
    await screenshot(page,'friends-initial-linked-390');

    const searchCalls=()=>fixture.wireEvents.filter(row=>row.method==='GET'&&row.path==='/api/community/search').length;
    const beforeShort=searchCalls();
    const searchInput=page.getByLabel('Find a player');
    await searchInput.fill('@ab');
    await page.getByRole('button',{name:'Search',exact:true}).click();
    await page.getByText('Enter at least 3 username characters or an exact player tag.',{exact:true}).waitFor();
    const shortSearch={calls:searchCalls()-beforeShort,searchStatusFocused:await page.locator('[data-friends-search-status]').evaluate(el=>el===document.activeElement),friendsStatusFocused:await page.locator('[data-friends-status]').evaluate(el=>el===document.activeElement),inputFocused:await searchInput.evaluate(el=>el===document.activeElement),active:await page.evaluate(()=>({tag:document.activeElement?.tagName,id:document.activeElement?.id,role:document.activeElement?.getAttribute('role')})),status:await statusText(page,'[data-friends-search-status]')};
    shortQueryCalls=shortSearch.calls;
    check(report,'P21-FRIENDS-SEARCH-MINIMUM-NO-SHORT-CALL',shortSearch.calls===0&&(shortSearch.searchStatusFocused||shortSearch.friendsStatusFocused||shortSearch.inputFocused)&&/at least 3/.test(shortSearch.status),{
      network_search_calls:shortSearch.calls,search_status_focused:shortSearch.searchStatusFocused,friends_status_focused:shortSearch.friendsStatusFocused,input_focus_retained:shortSearch.inputFocused,active_element:shortSearch.active,status_role:await page.locator('[data-friends-search-status]').getAttribute('role'),
    });

    await searchInput.fill('evil');await page.getByRole('button',{name:'Search',exact:true}).click();
    await page.getByText('Rival & Safe',{exact:true}).waitFor();
    const xss=await page.evaluate(()=>{
      const row=document.querySelector('#friend-search-results .pg-friend-row'),identity=row?.querySelector('.pg-friend-identity');
      return {rowCount:document.querySelectorAll('#friend-search-results .pg-friend-row').length,name:identity?.querySelector('strong')?.textContent,
        username:identity?.querySelector('span')?.textContent,activePayloadNodes:identity?.querySelectorAll('svg,img,script,iframe').length||0,
        globalMarker:window.__p21Xss===1,addButtonLabel:row?.querySelector('[data-friend-action="request"]')?.getAttribute('aria-label')};
    });
    check(report,'P21-FRIENDS-SEARCH-ESCAPES-UNTRUSTED-LABELS',xss.rowCount===1&&xss.name==='Rival & Safe'&&xss.username==='@<svg/onload="window.__p21Xss=1">'&&xss.activePayloadNodes===0&&!xss.globalMarker&&xss.addButtonLabel==='Add friend Rival & Safe'&&!xss.addButtonLabel.includes('<svg'),{
      result_rows:xss.rowCount,escaped_name:xss.name,unsafe_username_rendered_as_text:xss.username,no_executable_payload_nodes:xss.activePayloadNodes===0,no_payload_execution:!xss.globalMarker,accessible_label_uses_valid_display_name:xss.addButtonLabel==='Add friend Rival & Safe',
    });

    await searchInput.fill('limit');await page.getByRole('button',{name:'Search',exact:true}).click();
    await page.locator('#friend-search-results .pg-friend-row').nth(19).waitFor();
    check(report,'P21-FRIENDS-SEARCH-20-ROW-CAP',await page.locator('#friend-search-results .pg-friend-row').count()===20,{
      rendered_search_rows:await page.locator('#friend-search-results .pg-friend-row').count(),server_fixture_rows:20,
    });
    await searchInput.fill('overflow');await page.getByRole('button',{name:'Search',exact:true}).click();
    await page.getByText('Friends are unavailable right now. Please try again.',{exact:true}).waitFor();
    check(report,'P21-FRIENDS-SEARCH-OVER-LIMIT-FAILS-CLOSED',await page.locator('#friend-search-results .pg-friend-row').count()===0&&await page.locator('#friend-list .pg-friend-row').count()===2,{
      invalid_search_rows_rendered:await page.locator('#friend-search-results .pg-friend-row').count(),protected_friend_rows_retained:await page.locator('#friend-list .pg-friend-row').count(),
    });

    // A newer typed query clears the loading state and remains submit-ready;
    // the late response from the older query must not replace it or retire auth.
    await searchInput.fill('alpha');
    const oldQuery=fixture.holdNext('GET','/api/community/search',({url})=>url.searchParams.get('q')==='alpha');
    await page.getByRole('button',{name:'Search',exact:true}).click();await oldQuery.observed;
    await searchInput.fill('beta');
    const supersededState=await page.evaluate(()=>({formBusy:document.querySelector('[data-friends-search]')?.getAttribute('aria-busy'),buttonDisabled:document.querySelector('[data-friends-search] [type=submit]')?.disabled,inputFocused:document.activeElement?.id==='friend-query',status:document.querySelector('[data-friends-search-status]')?.textContent.trim()}));
    check(report,'P21-FRIENDS-NEW-QUERY-CANCELS-LOADING',supersededState.formBusy==='false'&&!supersededState.buttonDisabled&&supersededState.inputFocused&&!supersededState.status,{
      form_aria_busy:supersededState.formBusy,search_button_enabled:!supersededState.buttonDisabled,new_query_focus_retained:supersededState.inputFocused,stale_loading_copy_cleared:!supersededState.status,
    });
    await page.getByRole('button',{name:'Search',exact:true}).click();await page.getByText('Beta Result',{exact:true}).waitFor();
    oldQuery.release({status:401,body:{error:'AUTH_REQUIRED'}});
    await page.waitForTimeout(100);
    check(report,'P21-FRIENDS-OLD-QUERY-AUTH-FENCED',await page.locator('#friend-search-results').textContent().then(text=>text.includes('Beta Result')&&!text.includes('Alpha Result'))&&await page.getByLabel('Find a player').count()===1,{
      newer_results_preserved:true,late_auth_did_not_sign_out:true,
    });

    // The first request is held so the actual DOM proves no optimistic update.
    // The synthetic service then returns a transient failure once; the shared
    // account client must retry with the same body key and header.
    await searchInput.fill('retry');await page.getByRole('button',{name:'Search',exact:true}).click();
    await page.getByRole('button',{name:/Add friend Search retry/}).waitFor();
    fixture.transientTargets.add('retry-player');
    const pendingPost=fixture.holdNext('POST','/api/community/friend',({body})=>body?.target==='retry-player');
    await page.getByRole('button',{name:/Add friend Search retry/}).click();const pendingEvent=await pendingPost.observed;
    const pendingDom=await page.evaluate(()=>({status:document.querySelector('[data-friends-status]')?.textContent.trim(),friends:document.querySelectorAll('#friend-list .pg-friend-row').length,incoming:document.querySelectorAll('#friend-requests .pg-friend-row').length,outgoing:document.querySelectorAll('#friend-outgoing .pg-friend-row').length,searchDisabled:document.querySelector('#friend-query')?.disabled,focusStatus:document.querySelector('[data-friends-status]')===document.activeElement}));
    check(report,'P21-FRIENDS-ACTION-NOT-OPTIMISTIC',pendingDom.friends===2&&pendingDom.incoming===2&&pendingDom.outgoing===1&&pendingDom.searchDisabled&&/Updating your Friends lists/.test(pendingDom.status),{
      protected_lists_unchanged_while_post_pending:pendingDom.friends===2&&pendingDom.incoming===2&&pendingDom.outgoing===1,search_locked:pendingDom.searchDisabled,pending_status_visible:/Updating your Friends lists/.test(pendingDom.status),status_focused:pendingDom.focusStatus,
    });
    pendingPost.release({status:503,body:{error:'SERVICE_UNAVAILABLE'}});
    let retryReachedReady=false;
    try { await waitForCanonicalReady(page);retryReachedReady=true; } catch {}
    const retryEvents=fixture.wireEvents.filter(row=>row.method==='POST'&&row.path==='/api/community/friend'&&row.target==='retry-player');
    const retryStatus=await page.locator('[data-friends-status]').textContent().then(value=>(value||'').trim());
    check(report,'P21-FRIENDS-WHITELIST-CSRF-IDEMPOTENT-RETRY',retryReachedReady&&retryEvents.length===2&&retryEvents.every(row=>JSON.stringify(row.field_names)===JSON.stringify(EXPECTED_POST_FIELDS)&&row.action==='request'&&row.body_key_present&&row.idempotency_header_present&&row.idempotency_header_matches_body&&row.csrf_header_present&&row.csrf_matches_fixture&&!row.cookie_header_present)&&pendingEvent.action==='request'&&pendingEvent.target==='retry-player',{
      post_attempts:retryEvents.length,body_field_sets:retryEvents.map(row=>row.field_names),single_stable_key_across_retry:retryEvents.length===2&&retryEvents[0].body_key_present&&retryEvents[0].idempotency_header_matches_body&&retryEvents[1].idempotency_header_matches_body&&retryEvents[0].field_names.join(',')===retryEvents[1].field_names.join(','),csrf_header_on_all_attempts:retryEvents.every(row=>row.csrf_matches_fixture),no_cookie_forwarded:retryEvents.every(row=>!row.cookie_header_present),canonical_success_copy_visible:retryReachedReady,status_after_retry:retryStatus,
    });
    if(!retryReachedReady)throw new Error('friend request retry did not reach canonical success; status='+retryStatus+'; recent_api='+JSON.stringify(fixtureSummary(fixture,blockedExternal,shortQueryCalls)?.recent_api_events));
    check(report,'P21-FRIENDS-REQUEST-RELOADS-CANONICAL-LISTS',await page.locator('#friend-outgoing .pg-friend-row').filter({hasText:'Search retry'}).count()===1&&await page.locator('#friend-search-results').count()===0,{
      accepted_request_appears_in_outgoing_list:true,search_results_cleared_after_mutation:true,
    });

    // All source-derived mutations are exercised from their protected list or
    // current search result. Remove/block use the page's in-site confirmation.
    const actionCountBeforeDecline=fixture.wireEvents.filter(row=>row.method==='POST'&&row.path==='/api/community/friend').length;
    fixture.failNextFriendsRead={status:503,error:'RATE_LIMITED'};
    await page.locator('[data-friend-action="decline"][data-friend-target="incoming-decline"]').click();
    await page.getByText('Your change was accepted, but the updated lists could not be loaded. Reload your Friends lists.',{exact:true}).waitFor();
    const acceptedFailurePosts=fixture.wireEvents.filter(row=>row.method==='POST'&&row.path==='/api/community/friend').length;
    const failedReloadCopy=await page.evaluate(()=>({status:document.querySelector('[data-friends-status]')?.textContent.trim(),retry:document.querySelector('[data-friend-action="refresh"]')?.textContent.trim()}));
    check(report,'P21-FRIENDS-ACCEPTED-CHANGE-RELOAD-FAILURE-COPY',acceptedFailurePosts===actionCountBeforeDecline+1&&/accepted.*updated lists could not be loaded/.test(failedReloadCopy.status)&&failedReloadCopy.retry==='Try again',{
      exactly_one_mutation_posted:acceptedFailurePosts===actionCountBeforeDecline+1,accepted_but_refresh_failed_copy:/accepted.*updated lists could not be loaded/.test(failedReloadCopy.status),explicit_retry_button:failedReloadCopy.retry,
    });
    await page.getByRole('button',{name:'Try again'}).click();
    await waitForCanonicalReady(page);
    check(report,'P21-FRIENDS-RELOAD-RECOVERS-WITHOUT-REPOST',fixture.wireEvents.filter(row=>row.method==='POST'&&row.path==='/api/community/friend').length===acceptedFailurePosts&&await page.locator('#friend-requests .pg-friend-row').filter({hasText:'Incoming Decline'}).count()===0,{
      mutation_post_count_unchanged:true,declined_request_absent_after_canonical_retry:true,
    });

    await page.locator('[data-friend-action="accept"][data-friend-target="incoming-accept"]').click();
    await waitForCanonicalReady(page);
    check(report,'P21-FRIENDS-ACCEPT-ACTION',fixture.wireEvents.some(row=>row.method==='POST'&&row.path==='/api/community/friend'&&row.action==='accept'&&row.target==='incoming-accept')&&await page.locator('#friend-list .pg-friend-row').filter({hasText:'Incoming Accept'}).count()===1,{
      accept_post_observed:true,canonical_friend_row_visible:true,
    });
    await page.locator('[data-friend-action="cancel"][data-friend-target="outgoing-cancel"]').click();
    await waitForCanonicalReady(page);
    check(report,'P21-FRIENDS-CANCEL-ACTION',fixture.wireEvents.some(row=>row.method==='POST'&&row.path==='/api/community/friend'&&row.action==='cancel'&&row.target==='outgoing-cancel')&&await page.locator('#friend-outgoing .pg-friend-row').filter({hasText:'Outgoing Cancel'}).count()===0,{
      cancel_post_observed:true,canonical_outgoing_row_removed:true,
    });

    const removeRow=page.locator('#friend-list .pg-friend-row').filter({hasText:'Rival & Remove'});
    await removeRow.locator('summary').click();
    await removeRow.locator('[data-friend-action="confirm-remove"]').click();
    await page.locator('[role="group"][aria-labelledby="friend-confirm-title"]').waitFor();
    const removeFocused=await page.locator('[data-friend-action="confirm"]').evaluate(el=>el===document.activeElement);
    const beforeDismiss=fixture.wireEvents.filter(row=>row.method==='POST'&&row.path==='/api/community/friend').length;
    await page.getByRole('button',{name:'Keep friendship'}).click();
    check(report,'P21-FRIENDS-REMOVE-IS-CONFIRMED-IN-SITE',removeFocused&&await page.locator('[role="group"][aria-labelledby="friend-confirm-title"]').count()===0&&fixture.wireEvents.filter(row=>row.method==='POST'&&row.path==='/api/community/friend').length===beforeDismiss,{
      confirmation_group_opened:true,confirm_control_focus_restored:removeFocused,cancel_kept_friendship_without_post:true,
    });
    const removeAgain=page.locator('#friend-list .pg-friend-row').filter({hasText:'Rival & Remove'});
    await removeAgain.locator('summary').click();
    await removeAgain.locator('[data-friend-action="confirm-remove"]').click();
    await page.getByRole('button',{name:'Remove friend',exact:true}).click();
    await waitForCanonicalReady(page);
    check(report,'P21-FRIENDS-REMOVE-ACTION',fixture.wireEvents.some(row=>row.method==='POST'&&row.path==='/api/community/friend'&&row.action==='remove'&&row.target==='friend-remove')&&await page.locator('#friend-list .pg-friend-row').filter({hasText:'Rival & Remove'}).count()===0,{
      remove_post_observed:true,canonical_friend_row_removed:true,
    });

    const blockRow=page.locator('#friend-list .pg-friend-row').filter({hasText:'Rival & Block'});
    await blockRow.locator('summary').click();
    await blockRow.locator('[data-friend-action="confirm-block"]').click();
    await page.getByRole('button',{name:'Block player',exact:true}).click();
    await waitForCanonicalReady(page);
    check(report,'P21-FRIENDS-BLOCK-ACTION',fixture.wireEvents.some(row=>row.method==='POST'&&row.path==='/api/community/friend'&&row.action==='block'&&row.target==='friend-block')&&await page.locator('#friend-blocked .pg-friend-row').filter({hasText:'rival_block'}).count()===1,{
      block_post_observed:true,canonical_blocked_row_visible:true,confirmation_used:true,
    });
    await page.locator('[data-friend-action="unblock"][data-friend-target="blocked-unblock"]').click();
    await waitForCanonicalReady(page);
    check(report,'P21-FRIENDS-UNBLOCK-ACTION',fixture.wireEvents.some(row=>row.method==='POST'&&row.path==='/api/community/friend'&&row.action==='unblock'&&row.target==='blocked-unblock')&&await page.locator('#friend-blocked [data-friend-target="blocked-unblock"]').count()===0&&await page.locator('#friend-blocked [data-friend-target="friend-block"]').count()===1,{
      unblock_post_observed:true,target_blocked_row_removed:true,other_blocked_row_preserved:true,
    });

    // Filled linked view responsive and accessibility checks at both target
    // phone widths; the 20-row state stresses wrapping and button geometry.
    await searchInput.fill('limit');await page.getByRole('button',{name:'Search',exact:true}).click();
    await page.locator('#friend-search-results .pg-friend-row').nth(19).waitFor();
    for(const width of [390,320]){
      await page.setViewportSize({width,height:844});
      const layout=await page.evaluate(()=>({width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,
        targets:[...document.querySelectorAll('#friends-controls button:not([hidden]),#friends-controls summary,#friends-controls input')].filter(el=>!el.disabled).map(el=>{const r=el.getBoundingClientRect();return {width:Math.round(r.width),height:Math.round(r.height),tag:el.tagName};}),
      }));
      check(report,'P21-FRIENDS-REFLOW-'+width,layout.scrollWidth<=layout.width+1,{
        viewport_width:layout.width,scroll_width:layout.scrollWidth,result_rows:20,
      });
      check(report,'P21-FRIENDS-TOUCH-TARGETS-'+width,layout.targets.length>0&&layout.targets.every(row=>row.width>=24&&row.height>=24),{
        measured_controls:layout.targets.length,minimum_width:Math.min(...layout.targets.map(row=>row.width)),minimum_height:Math.min(...layout.targets.map(row=>row.height)),
      });
      if(width===390)await screenshot(page,'friends-search-filled-390');
      if(width===320)await screenshot(page,'friends-search-filled-320');
      await page.evaluate(axe.source);
      const axeResult=await page.evaluate(async()=>{
        const data=await axe.run({runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa','best-practice']}});
        const compact=entry=>({id:entry.id,impact:entry.impact,nodes:entry.nodes.map(node=>({target:node.target,failure_summary:node.failureSummary}))});
        return {violations:data.violations.map(compact),incomplete:data.incomplete.map(compact)};
      });
      check(report,'P21-FRIENDS-AXE-FILLED-'+width,axeResult.violations.length===0,{viewport_width:width,violations:axeResult.violations});
      if(axeResult.incomplete.length)report.checks.push({id:'P21-FRIENDS-AXE-MANUAL-'+width,result:'INCOMPLETE_MANUAL_REVIEW',items:axeResult.incomplete});
    }
    await searchInput.focus();
    check(report,'P21-FRIENDS-KEYBOARD-FOCUS-VISIBLE',await page.evaluate(()=>document.activeElement?.id==='friend-query'&&getComputedStyle(document.activeElement).outlineStyle!=='none'),{
      search_input_focused:await page.evaluate(()=>document.activeElement?.id==='friend-query'),visible_focus_outline:await page.locator('#friend-query').evaluate(el=>getComputedStyle(el).outlineStyle),
    });

    // A short draft is kept when a same-actor focus refresh locks the page;
    // protected rows and search results are dropped until the actor is checked.
    await searchInput.fill('final-check');await page.getByRole('button',{name:'Search',exact:true}).click();
    await page.locator('#friend-list .pg-friend-row').first().waitFor();
    const profileRefresh=fixture.holdNext('GET','/api/v1/profile');
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await profileRefresh.observed;
    const refreshing=await page.evaluate(()=>({query:document.querySelector('#friend-query')?.value,queryVisible:Boolean(document.querySelector('#friend-query')),graphRows:document.querySelectorAll('#friends-controls .pg-friend-row').length,searchRows:document.querySelectorAll('#friend-search-results .pg-friend-row').length,status:[...document.querySelectorAll('#friends-controls [role="status"]')].map(el=>el.textContent.trim()).join(' '),controlsText:document.querySelector('#friends-controls')?.textContent.trim()}));
    check(report,'P21-FRIENDS-SAME-ACTOR-REFRESH-LOCKS-AND-CLEARS-GRAPH',!refreshing.queryVisible&&refreshing.graphRows===0&&refreshing.searchRows===0&&/Checking your account/.test(refreshing.status||refreshing.controlsText),{
      query_control_hidden_during_account_recheck:!refreshing.queryVisible,private_graph_cleared:refreshing.graphRows===0&&refreshing.searchRows===0,checking_status_visible:/Checking your account/.test(refreshing.status||refreshing.controlsText),draft_query_restored_after_same_actor_recheck:'verified in following check',
    });
    profileRefresh.release({status:200,body:{...fixture.actors['fixture-actor-one']}});
    await page.locator('#friend-list .pg-friend-row').first().waitFor();
    check(report,'P21-FRIENDS-SAME-ACTOR-REFRESH-RELOADS-AND-RETAINS-QUERY',await page.getByLabel('Find a player').inputValue()==='final-check'&&await page.locator('#friend-list .pg-friend-row').count()>=1&&await page.locator('#friend-search-results').count()===0,{
      same_actor_query_retained:true,canonical_graph_reloaded:true,old_search_results_cleared:true,
    });

    // Late AUTH from a prior actor, route and logout must be ignored by the
    // Friends controller fences. Each fixture gate is released only afterward.
    await searchInput.fill('actor-race');await page.getByRole('button',{name:'Search',exact:true}).click();
    await page.getByRole('button',{name:/Add friend Search actor-race/}).waitFor();
    const actorGate=fixture.holdNext('POST','/api/community/friend',({body})=>body?.target==='actor-race-player');
    await page.getByRole('button',{name:/Add friend Search actor-race/}).click();await actorGate.observed;
    fixture.currentActor='fixture-actor-two';
    const actorProfileGate=fixture.holdNext('GET','/api/v1/profile');
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await actorProfileGate.observed;
    actorProfileGate.release({status:200,body:{...fixture.actors['fixture-actor-two']}});
    await page.getByText('Actor Two Friend',{exact:true}).waitFor();
    actorGate.release({status:401,body:{error:'AUTH_REQUIRED'}});await page.waitForTimeout(100);
    check(report,'P21-FRIENDS-OLD-ACTOR-AUTH-FENCED',await page.locator('#friend-list').textContent().then(value=>value.includes('Actor Two Friend'))&&!/Sign in to view your Friends lists/.test(await page.locator('#main').textContent()),{
      new_actor_friend_list_preserved:true,late_auth_did_not_sign_out:true,
    });

    await searchInput.fill('route-race');await page.getByRole('button',{name:'Search',exact:true}).click();
    await page.getByRole('button',{name:/Add friend Search route-race/}).waitFor();
    const routeGate=fixture.holdNext('POST','/api/community/friend',({body})=>body?.target==='route-race-player');
    await page.getByRole('button',{name:/Add friend Search route-race/}).click();await routeGate.observed;
    await navigateByHistory(page,'/');await page.locator('#hero-title').waitFor();
    routeGate.release({status:401,body:{error:'AUTH_REQUIRED'}});await page.waitForTimeout(100);
    await navigateByHistory(page,'/friends');await page.getByText('Actor Two Friend',{exact:true}).waitFor();
    check(report,'P21-FRIENDS-ROUTE-STALE-AUTH-FENCED',await page.locator('#friend-list').textContent().then(value=>value.includes('Actor Two Friend'))&&!/Sign in to view your Friends lists/.test(await page.locator('#main').textContent()),{
      linked_actor_list_reloaded_after_return:true,late_route_auth_did_not_sign_out:true,
    });

    await searchInput.fill('logout-race');await page.getByRole('button',{name:'Search',exact:true}).click();
    await page.getByRole('button',{name:/Add friend Search logout-race/}).waitFor();
    const logoutGate=fixture.holdNext('POST','/api/community/friend',({body})=>body?.target==='logout-race-player');
    await page.getByRole('button',{name:/Add friend Search logout-race/}).click();await logoutGate.observed;
    await navigateByHistory(page,'/account');await page.getByRole('heading',{name:'Fixture Actor Two'}).waitFor();
    await page.locator('[data-account-action="logout"]').click();
    await page.getByRole('heading',{name:'Continue to Mega XOXO'}).waitFor();
    logoutGate.release({status:401,body:{error:'AUTH_REQUIRED'}});await page.waitForTimeout(100);
    await navigateByHistory(page,'/friends');
    const signedOut=await page.evaluate(()=>({signIn:document.querySelector('#main')?.textContent.includes('Sign in to find players and manage your friend requests here.'),privateNames:/Actor Two Friend|logout-race-player|fixture_two|MEGA-ACTORTWO/.test(document.querySelector('#main')?.textContent||''),form:Boolean(document.querySelector('#friend-query'))}));
    check(report,'P21-FRIENDS-LOGOUT-STALE-AUTH-FENCED',signedOut.signIn&&!signedOut.privateNames&&!signedOut.form,{
      signed_out_friends_surface:true,protected_friend_details_absent:!signedOut.privateNames,search_controls_hidden:signedOut.form===false,
    });

    await page.setViewportSize({width:390,height:844});
    await screenshot(page,'friends-signed-out-390');
    check(report,'P21-FRIENDS-JAVASCRIPT-ERRORS',javascriptErrors.length===0,{error_count:javascriptErrors.length,errors:javascriptErrors});
    const privacy=await page.evaluate(async()=>({
      storage:window.__p21StorageAudit,keys:Array.from({length:localStorage.length},(_,index)=>localStorage.key(index)),
      cacheNames:await caches.keys(),serviceWorkerControlled:Boolean(navigator.serviceWorker?.controller),
    }));
    const privateStorage=[...privacy.storage.reads,...privacy.storage.writes,...privacy.storage.removals,...privacy.keys].filter(key=>/friend|profile|actor|player|session|account|auth|csrf|token|wallet|coin|crown/i.test(key));
    const noStore=fixture.apiResponseHeaders.length>0&&fixture.apiResponseHeaders.every(row=>row.cache_control==='private, no-store');
    check(report,'P21-FRIENDS-NO-PRIVATE-LOCALSTORAGE',privacy.storage.writes.length===0&&privacy.storage.removals.length===0&&privateStorage.length===0,{
      local_storage_writes:privacy.storage.writes.length,local_storage_removals:privacy.storage.removals.length,friend_or_auth_keys:privateStorage.length,
    });
    check(report,'P21-FRIENDS-NO-PRIVATE-CACHE',noStore&&privacy.cacheNames.length===0&&!privacy.serviceWorkerControlled,{
      api_response_cache_control:noStore?'private, no-store':'unexpected',cache_storage_entries:privacy.cacheNames.length,service_worker_controls_page:privacy.serviceWorkerControlled,
    });
    check(report,'P21-FRIENDS-NO-COOKIES-OR-EXTERNAL-ORIGINS',fixture.wireEvents.every(row=>!row.cookie_header_present)&&blockedExternal.size===0,{
      api_requests_with_cookie_headers:fixture.wireEvents.filter(row=>row.cookie_header_present).length,blocked_external_origins:blockedExternal.size,
    });

    report.api_fixture_summary=fixtureSummary(fixture,blockedExternal,shortQueryCalls);
  } catch(error) {
    const message=String(error?.message||error).replace(/https?:\/\/[^\s)]+/g,'[local-url]').slice(0,800);
    check(report,'P21-FRIENDS-EXECUTION',false,{error:message});
    report.api_fixture_summary=fixtureSummary(fixture,typeof blockedExternal==='undefined'?null:blockedExternal,shortQueryCalls);
    if(page)try{report.execution_state=await page.evaluate(()=>({path:location.pathname,friends_status:document.querySelector('[data-friends-status]')?.textContent.trim()||'',search_status:document.querySelector('[data-friends-search-status]')?.textContent.trim()||'',list_rows:document.querySelectorAll('#friends-controls .pg-friend-row').length,friend_status:document.querySelector('#friends-controls')?.getAttribute('aria-busy')||''}));}catch{}
  } finally {
    try { await browser?.close(); } catch {}
    if(server?.listening){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
    fs.rmSync(snapshot,{recursive:true,force:true});
  }
  report.result=report.failures.length===0?'PASS_AUTOMATED_LOCAL_ONLY':'FAIL';
  const reportPath=path.join(output,'friends-qa.json');fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
  process.stdout.write(JSON.stringify({result:report.result,checks:report.checks.length,failures:report.failures.length,report:path.relative(ROOT,reportPath),screenshots:report.screenshots.length},null,2)+'\n');
  if(report.result!=='PASS_AUTOMATED_LOCAL_ONLY')process.exitCode=1;
}

main().catch(error=>{process.stderr.write(String(error?.message||error)+'\n');process.exitCode=1;});
