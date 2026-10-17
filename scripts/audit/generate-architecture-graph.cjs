#!/usr/bin/env node
'use strict';
/* Static launch-audit extraction. Never imports application modules, starts a server, runs tests,
 * reads environment values, or changes git. Output allowlist is intentionally closed. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const OUT = 'docs/v5.2/final-audit/';
const ALLOWED = new Set([
 'features/FEATURE-INVENTORY.csv','features/FEATURE-INVENTORY.md','features/FEATURE-PARITY-MATRIX.csv',
 'architecture/architecture-nodes.json','architecture/architecture-edges.json',
 'architecture/feature-dependencies.graphml','architecture/feature-dependencies.mmd','architecture/graph-viewer/index.html',
 'ui/WEB-PAGE-INVENTORY.csv','ui/MOBILE-SCREEN-INVENTORY.csv','ui/WEB-INTERACTION-INVENTORY.csv',
 'ui/ANDROID-INTERACTION-INVENTORY.csv','ui/IOS-INTERACTION-INVENTORY.csv',
]);
const NODE_TYPES = new Set(['Feature','Screen','UI Component','Button','State Store','Hook','Service','API Endpoint','Backend Handler','DB Table','Job','External Provider','Config-Flag','Test','Utility']);
const EDGE_TYPES = new Set(['CONTAINS','NAVIGATES_TO','TRIGGERS','CALLS','READS','WRITES','DEPENDS_ON','RENDERS','AUTHORIZES','TESTED_BY','CONFIGURED_BY','PUBLISHES','SUBSCRIBES_TO']);
const STATUSES = new Set(['VERIFIED_WORKING','IMPLEMENTED_UNVERIFIED','PARTIALLY_IMPLEMENTED','DISABLED','BLOCKED_EXTERNAL','BROKEN','NOT_IMPLEMENTED']);
const compare = (a,b) => a < b ? -1 : a > b ? 1 : 0;
const BASE = '7f582b749a1128b86e53ddcbcda57b569b0953cf';
const requestedRef = process.argv.find(a=>a.startsWith('--ref='))?.slice(6)||BASE;
const sourceCommit = execFileSync('git',['rev-parse','--verify',requestedRef+'^{commit}'],{cwd:ROOT,encoding:'utf8'}).trim();
const trackedPaths = new Set(execFileSync('git',['ls-tree','-r','--name-only',sourceCommit],{cwd:ROOT,encoding:'utf8'}).trim().split('\n'));
const snapshot = new Map();
const read = p => {
 if(!trackedPaths.has(p))throw Error('Source absent at pinned revision: '+p);
 if(!snapshot.has(p))snapshot.set(p,execFileSync('git',['show',sourceCommit+':'+p],{cwd:ROOT,encoding:'utf8',maxBuffer:16*1024*1024}));
 return snapshot.get(p);
};
const exists = p => trackedPaths.has(p);
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const idFor = (type,key) => type.replace(/[^A-Za-z]/g,'')+'_'+hash(key).slice(0,16);
const lineAt = (s,n) => s.slice(0,n).split('\n').length;
const locate = (p,needle) => { const s=read(p), n=s.indexOf(needle); return n<0?1:lineAt(s,n); };
const csv = rows => rows.map(row=>row.map(value=>'"'+String(value??'').replaceAll('"','""')+'"').join(',')).join('\n')+'\n';
function write(relative,content) {
 if(!ALLOWED.has(relative)) throw Error('Output not allowed: '+relative);
 const file=path.join(ROOT,OUT,relative);
 fs.mkdirSync(path.dirname(file),{recursive:true});
 fs.writeFileSync(file,content);
}
const sourceFiles = [...trackedPaths].filter(p=>p==='index.html'||/^(?:src|apps|packages|server|native|public|scripts\/p21|scripts\/v5|scripts\/v51|training\/bot|tests|\.github\/workflows)\//.test(p))
 .filter(p=>/\.(?:js|cjs|mjs|kt|kts|swift|sql|json|html|py|ya?ml|plist|entitlements|pbxproj)$/.test(p))
 .filter(p=>!p.includes('/Assets.xcassets/')&&!p.includes('/res/')&&!p.endsWith('package-lock.json')).sort(compare);
// Batch blob reads pin every byte even while other lanes edit and commit the shared checkout.
const blobs=execFileSync('git',['cat-file','--batch'],{cwd:ROOT,input:sourceFiles.map(p=>sourceCommit+':'+p+'\n').join(''),maxBuffer:64*1024*1024});
let blobOffset=0;
for(const p of sourceFiles){
 const end=blobs.indexOf(10,blobOffset),header=blobs.subarray(blobOffset,end).toString('utf8'),size=Number(header.split(' ')[2]);
 if(!header.includes(' blob ')||!Number.isSafeInteger(size))throw Error('Invalid source blob '+p);
 snapshot.set(p,blobs.subarray(end+1,end+1+size).toString('utf8'));blobOffset=end+1+size+1;
}
const text = new Map(sourceFiles.map(p=>[p,read(p)]));
const sourceDigest = hash(sourceFiles.map(p=>p+'\0'+hash(text.get(p))).join('\n'));
const nodes=new Map(), edges=new Map();
function node(type,label,p,line=1,symbol=label,extra={}) {
 if(!NODE_TYPES.has(type)||!exists(p)||!Number.isInteger(line)||line<1)throw Error('Invalid source node '+label+' '+p);
 const id=extra.id||idFor(type,p+':'+symbol);
 if(!nodes.has(id))nodes.set(id,{id,type,label,source:{path:p,line,symbol},status:'IMPLEMENTED_UNVERIFIED',...extra});
 return id;
}
function edge(source,target,type,p,line=1,basis='source-reference',confidence='static') {
 if(!EDGE_TYPES.has(type))throw Error('Invalid edge type '+type);
 if(source===target)return;
 const id=idFor('Edge',[source,target,type,p,line,basis].join(':'));
 edges.set(id,{id,source,target,type,evidence:{path:p,line,basis,confidence}});
}
function fileType(p) {
 if(p.startsWith('tests/'))return 'Test';
 if(/packages\/services\//.test(p))return 'Service';
 if(/apps\/api\/routes\//.test(p))return 'Backend Handler';
 if(/src\/(app|community|party-ui|monetization-ui|sponsors-ui)\.js$|apps\/web\/.*\.js$|native\/.+\.(kt|swift)$/.test(p))return 'UI Component';
 if(/\.github\/|config|manifest|\.json$/.test(p))return 'Config-Flag';
 return 'Utility';
}
const fileNodes=new Map(sourceFiles.map(p=>[p,node(fileType(p),p,p,1,'module')]));
const moduleOf=p=>fileNodes.get(p)||node(fileType(p),p,p,1,'module');
const CI={
 regression:'https://github.com/oculusrex14/Mega-XO/actions/runs/39006747072/job/117320656188',
 website:'https://github.com/oculusrex14/Mega-XO/actions/runs/39006747099/job/117320655996',
 realtime:'https://github.com/oculusrex14/Mega-XO/actions/runs/39006747099/job/117320707063',
 presentation:'https://github.com/oculusrex14/Mega-XO/actions/runs/39006747099/job/117320707075',
 android:'https://github.com/oculusrex14/Mega-XO/actions/runs/39006747061/job/117320920404',
 services:'https://github.com/oculusrex14/Mega-XO/actions/runs/39006747074/job/117320656168',
};
/* Curated product semantics supplement syntax extraction. W=CI-scoped verified (never live);
 * U=implemented/unverified; P=partial; D=disabled; E=external gate; B=broken; N=not implemented.
 * Column order: label | group | sources | tests | web/android/ios | limitation | anchor. */
const definitions = `
Canonical mini-board and Mega-board rules|Gameplay|src/game.js|tests/domain.test.js tests/bot/contracts.test.js|WWW|CI pure-rule scope; no physical-device acceptance|function apply
Forced destination and free choice on closed board|Gameplay|src/game.js|tests/bot/lesson.test.cjs tests/bot/contracts.test.js|WWW|Rule parity only|n.required=
Win draw and terminal move rejection|Gameplay|src/game.js|tests/bot/contracts.test.js tests/authority.test.js|WWW|No live match replay performed|function legal
Website interactive board and keyboard grid|Gameplay|apps/web/board.js|tests/v5-p21-board.test.js|WUU|Website unit coverage; current presentation CI fails; native uses different renderer|function boardMarkup
Bot match start and difficulty selection|Gameplay|src/app.js apps/web/board.js|tests/v51-p21-bot.test.js|UUU|Five classical levels; no claimed device verification|function renderHomeSetup
Pass & Play local two-player|Gameplay|src/app.js apps/web/board.js|tests/v5-p21-board.test.js|UUU|Website and app presentations differ|function createBoardSession
First-player selection|Gameplay|src/app.js apps/web/board.js|tests/v52-match-redesign.test.js|UUU|Native supports X/O; website exposes its own setup|First move
Optional turn timer|Gameplay|src/app.js src/domain.js|tests/authority.test.js|PUU|App exposes Off/30/60; website local board has no equivalent timer setup|Turn timer
Offline match save and resume|Gameplay|src/app.js apps/web/bot-compat.js|tests/v51-p21-bot.test.js|UUU|Different save namespaces; no crash/device rehearsal here|offlineSnapshot
Resign restart and rematch|Gameplay|src/app.js apps/web/board.js|tests/powers-game-ui.test.js tests/v5-p21-board.test.js|UUU|Android emulator move-confirm is unresolved|resignyes
Beginner bot|Bots|src/game.js src/bot/search.js src/bot/worker.js|tests/bot/search.test.cjs|UUU|Historical measured league only; not current device certification|const LEVELS
Easy bot|Bots|src/game.js src/bot/search.js src/bot/worker.js|tests/bot/search.test.cjs|UUU|Historical measured league only|const LEVELS
Medium bot|Bots|src/game.js src/bot/search.js src/bot/worker.js|tests/bot/search.test.cjs|UUU|Historical measured league only|const LEVELS
Hard bot|Bots|src/game.js src/bot/search.js src/bot/worker.js|tests/bot/search.test.cjs|UUU|Historical measured league only|const LEVELS
Expert bot|Bots|src/game.js src/bot/search.js src/bot/worker.js|tests/bot/search.test.cjs|UUU|Promotion evidence is pinned to older source hashes and Node budget|function choose
Worker cancellation and stale-reply fencing|Bots|src/bot/runtime.js src/bot/contracts.js apps/web/bot-compat.js|tests/bot/runtime.test.cjs tests/bot/contracts.test.js|WWW|CI harness scope only; physical process-death remains unverified|function accept
Local Impossible model pack|Bots|src/bot/pack.js src/bot/local-ai.js src/bot/local-session.js|tests/bot/research-gate.test.cjs tests/bot/impossible-session.test.cjs|DEE|Empty approved catalog; optional unverified unpaid; website has no Impossible selector|APPROVED_CATALOG
Impossible recovery explicitly relabels Expert|Bots|src/app.js src/bot/local-ai.js|tests/bot/local-ai.test.cjs|DUU|Recovery remains unverified-local-ai and unpaid; no approved public pack|openNeuralRecovery
Continuous offline learning operator|Bots|training/bot/champion_cycle.py|tests/bot/learning-operator.test.cjs|PPP|Operator source exists; continuous running service and current measured promotion NOT_RUN|def
Guided six-move tutorial|Tutorial|src/tutorial/lesson.js src/tutorial/client.js apps/web/bot-compat.js|tests/bot/lesson.test.cjs tests/v51-p21-bot.test.js|UUU|UNVERIFIED/UNPAID; CI script coverage does not establish novice comprehension|const SCRIPT
Tutorial narration captions and volume|Tutorial|src/tutorial/client.js apps/web/bot-compat.js|tests/v51-bot-tutorial.test.js|UUU|Voice availability and physical AT NOT_RUN|narration
Tutorial skip restart and Beginner handoff|Tutorial|src/tutorial/lesson.js src/app.js apps/web/board.js|tests/bot/lesson.test.cjs|UUU|Position is retained and practice remains unpaid|function advance
Tutorial and Impossible reward exclusion|Economy|src/domain.js src/bot/local-ai.js|tests/domain.test.js tests/bot/local-ai.test.cjs|WWW|CI pure-policy scope; neither result may mint official currency or Elo|function complete
Bot first-five payouts and daily cap|Economy|src/domain.js|tests/domain.test.js|UUU|App local wallet versus website practice; no server-earned parity claim|const BOT_PAY
Coins Crowns wallet display|Economy|src/app.js apps/web/data.js packages/services/core.js|tests/domain.test.js|UUU|Local and competitive ledgers must remain distinct|function walletData
Coins to Crowns exchange|Economy|src/domain.js src/app.js packages/services/core.js|tests/domain.test.js|PUU|Website has store routes but no equivalent full wallet sheet|function conversion
Daily quests|Economy|src/domain.js src/app.js|tests/domain.test.js|PUU|Website rewards copy does not imply quest-claim parity|QUESTS
Core-only competitive economic authority|Architecture|packages/services/core.js packages/services/core-gateway.js|tests/v5-pg-guards.test.js tests/v51-audit-ticket-boundary.test.js|WWW|CI role and gateway scope; no live infrastructure inspection|createCore
Undo|Powers|src/app.js src/powers-ui.js apps/web/powers.js|tests/powers-game-ui.test.js tests/v52-p21-powers.test.js|PUU|Website controller has no verified binding and stays closed; app bot-only|function renderPowerControls
Undo Block|Powers|src/app.js src/powers-ui.js apps/web/powers.js|tests/powers-game-ui.test.js|DDD|Explicitly unavailable; multiplayer counter protocol not shipped|card('undoBlock'
Tactical Hint|Powers|src/app.js src/powers-ui.js apps/web/powers.js|tests/powers-game-ui.test.js|PUU|App bot hint exists; website cannot enable hint writes|card('hint'
Hint Block|Powers|src/app.js src/powers-ui.js apps/web/powers.js|tests/powers-game-ui.test.js|DDD|Explicitly unavailable; name drift remains in website bank labels|card('tacticalBlock'
Power charges purchased with Crowns|Powers|src/powers-ui.js src/app.js src/monetization-ui.js|tests/powers-game-ui.test.js|DUU|App debits device wallet; linked wallet mismatch requires review|spend:async
Rewarded power ad confirmation and pacing|Powers|src/powers-ui.js src/gameplay-rewind.js|tests/powers-integration.test.js tests/powers-game-ui.test.js|DUU|Requires native SDK earned event; provider/device acceptance not inferred|function nativeBridge
Ranked matchmaking offer acceptance|Online|apps/web/app.js src/network.js packages/services/queue.js|tests/v5-p21-app.test.js tests/v5-p18-online-journey.test.js|UUU|Existing staging evidence is older; 15-second offer TTL retained|function updateOnlineControls
Free casual matchmaking|Online|apps/web/app.js src/app.js packages/services/queue.js|tests/v5-p21-app.test.js|UUU|Exact quote must be shown before accepting|function startQueue
Realtime subscribe reconnect and revision fence|Online|apps/web/realtime.js apps/game-core/realtime.js src/network.js|tests/v5-p21-realtime.test.js tests/v5-p21-realtime-qa.test.js|WUU|Website CI synthetic transport passes Chromium Firefox WebKit; not live/device proof|createRealtimeReader
Online resign and authoritative settlement|Online|packages/services/core.js apps/web/app.js src/app.js|tests/authority.test.js tests/v5-p18-online-journey.test.js|UUU|Settlement belongs to Core; live end-to-end not rerun|sendOnlineResign
Elo placements and league eligibility|Competitive|src/domain.js src/authority.js|tests/authority.test.js tests/domain.test.js|WWW|Pure-policy CI scope; publication and live season not certified|function elo
Rank and wealth leaderboards privacy|Competitive|packages/services/read-cache.js apps/api/routes/competitive.js|tests/v51-audit-leaderboard.test.js tests/v52-leaderboard-wiring.test.js|UUU|Source and historical CI evidence; no live privacy probe|leaderboard
Season qualification and weekly rewards|Competitive|src/domain.js src/authority.js|tests/authority.test.js tests/domain.test.js|UUU|No current season transition rehearsal|function season
Tournament browser create join start|Tournament|apps/web/tournaments.js apps/web/tournaments-view.js packages/services/tournaments.js|tests/v52-web-tournaments.test.js|UUU|Static/unit coverage; real rooms and provider state unverified|createTournamentsController
Tournament fixtures moves and payout|Tournament|packages/services/tournaments.js packages/services/tournament-timer.js src/tournament.js|tests/gameplay-tournament.test.js tests/v52-tournament-http.test.js|UUU|Core-coordinated payout; no new execution|createTournament
Tournament spectator read-only view|Tournament|apps/web/tournaments.js apps/web/board.js|tests/v52-web-tournaments.test.js|UPP|Website reader exists; native screen parity not established|tournamentSpectatorMatch
Private rooms and invites|Party|src/party-ui.js src/tournament.js|tests/community.test.js|PUU|Website navigation has no full native private-room editor parity|function
LAN host join discover and resume|LAN|src/lan/lan-room-store.js src/party-ui.js native/android/app/src/main/java/online/megaxo/prototype/MegaAndroidLanBridge.kt native/ios/MegaXO/MegaNativeLan.swift|tests/v51-lan-room-store.test.cjs|PUU|Browser/server and native transport differ; real same-Wi-Fi devices NOT_RUN|class
Email password and verification OTP|Account|packages/services/accounts.js src/community.js apps/web/app.js|tests/v5-p21-account-web.test.js tests/community-http.test.js|UUU|PostgreSQL authoritative path; mail delivery not exercised|async emailContinue
Password reset|Account|packages/services/accounts.js src/community.js apps/web/app.js|tests/v5-p21-account-web.test.js|UUU|Provider delivery and recovery acceptance NOT_RUN|async emailReset
Google provider sign-in|Account|server/identity-provider.js apps/api/routes/account.js native/android/MegaGoogleIdentity.kt|tests/v52-web-oauth.test.js|UUU|Verified subject lane exists; real provider evidence separate|async verify
Apple provider sign-in|Account|server/identity-provider.js native/ios/MegaAppleIdentity.swift native/android/app/src/main/java/online/megaxo/prototype/MegaAndroidIdentityBridge.kt|tests/v52-web-oauth.test.js|UNU|Android host compiles only Google; iOS has Apple; native Android Apple path NOT_IMPLEMENTED|async verify
Native provider capability reporting|Account|src/account-client.js src/community.js native/android/app/src/main/java/online/megaxo/prototype/MegaNativeApiBridge.kt|tests/v5-p11-native-session.test.js|UBB|Linked-profile providers replace compiled capabilities; unsupported Verify and missing Link controls; SAGAN-012|function nativeSessionFromProfile
Email collision choice and existing-profile proof|Account|src/community.js server/community-store.js packages/services/accounts.js|tests/v52-account-link.test.js|BBB|Choice implemented in SQLite store; PostgreSQL finishVerified has no decision path; SAGAN-002|decisionChoice
New profile with 30-day old-profile deletion|Account|server/community-store.js src/community.js packages/services/accounts.js|tests/v52-account-link.test.js|BBB|Legacy-only scheduling is not production PostgreSQL implementation; SAGAN-002|decisionConfirmNew
Scheduled-deletion cancellation|Account|src/community.js server/community-store.js|tests/v52-account-link.test.js|NNN|Confirmation promises Cancel deletion but no UI action or cancellation route/method exists; SAGAN-004|Cancel deletion
Linked accounts recovery export and deletion controls|Account|src/community.js apps/web/pages.js|tests/community.test.js tests/v5-p21-account-web.test.js|BUU|Website Linked accounts CTA goes to bot game and cannot open controls; SAGAN-003|Linked accounts & recovery
Profile username display name and visibility|Account|apps/web/data.js src/community.js packages/services/accounts.js|tests/v5-p21-profile-editor.test.js|UUU|Website excludes avatar selection; app editor differs|createProfileEditor
Avatar selection|Account|src/community.js apps/web/pages.js|tests/community.test.js|DUU|Website explicitly says avatar selection unavailable|Avatar selection is not available
Cloud practice save and conflict resolution|Account|src/community.js packages/services/accounts.js|tests/community.test.js|PUU|Native/retained full conflict UI; website main shell lacks that UI|function chooseSave
Session revocation refresh and secure vault|Account|packages/services/refresh.js native/android/app/src/main/java/online/megaxo/prototype/MegaSecureSessionVault.kt native/ios/MegaXO/MegaNativeSecretVault.swift|tests/v5-p11-native-session.test.js|UUU|Real logout/reinstall/process death not run|createRefresh
Coordinated permanent account deletion|Privacy|packages/services/accounts.js packages/services/worker-workflows.js src/community.js|tests/account-deletion.test.js|PUU|Backend immediate deletion exists; website control navigation broken; 30-day replacement is separate|async deleteAccount
Research consent and withdrawal|Privacy|packages/services/accounts.js apps/web/app.js src/community.js|tests/v52-research-consent-routes.test.js tests/v52-consent-ui.test.js|UUU|Consent source is durable; no live submission in audit|research
Friends search request accept block and report|Social|apps/web/friends.js src/community.js packages/services/accounts.js|tests/v5-p21-friends.test.js tests/v52-annotation-friends.test.js|UUU|Website report/profile actions and app full editor differ|createFriendsController
Friend direct challenge and stakes quote|Social|apps/web/friends.js src/community.js packages/services/core.js|tests/v52-annotation-friends.test.js|UUU|Consent exact-terms and account binding mandatory|challenge
Presence privacy and visibility|Social|packages/services/ephemera.js packages/services/accounts.js|tests/community.test.js|UUU|Redis hints never replace durable session authority|presence
Crown packs verified receipt settlement|Commerce|packages/services/commerce.js src/monetization-ui.js apps/web/store.js|tests/v52-commerce-ingress.test.js|UUU|Provider approval and exact product configuration external|createCommerce
Permanent ad removal|Commerce|src/monetization.js packages/services/commerce.js|tests/monetization-policy.test.js|UUU|Automatic ad removal separate from optional rewarded ads|remove_ads
Mega Pass subscription and benefits|Commerce|src/monetization.js packages/services/commerce.js apps/web/pages.js|tests/v52-pass-benefits.test.js|UUU|Current code says monthly; do not reuse historical one-time draft|mega_pass
Google Play Billing and restore|Commerce|native/android/app/src/main/java/online/megaxo/prototype/MegaPlayBilling.kt|tests/v5-native-foundations.test.js|DED|Android store review real transactions and signing external; other platforms use own providers|class
Apple StoreKit and restore|Commerce|native/ios/MegaXO/MegaStoreKit.swift|tests/v5-native-foundations.test.js|DDE|Apple store approval and production receipt acceptance external|class
Cashfree web checkout|Commerce|packages/services/cashfree.js apps/web/app.js|tests/v52-cashfree-v5.test.js|UDD|Actual merchant and payment acceptance outside static audit|cashfreeCheckout
Polar web checkout and status|Commerce|packages/services/polar.js apps/web/app.js|tests/v52-polar-commerce.test.js tests/v52-polar-provider.test.js|UDD|Actual merchant and live purchase not exercised|polarCheckout
Webhooks refunds revocations replay guard|Commerce|packages/services/commerce-ingress.js packages/services/commerce.js|tests/v52-commerce-ingress.test.js|UUU|No provider replay or live webhook executed|createCommerce
Rewarded cosmetic credits|Ads|src/monetization.js src/monetization-ui.js native/android/app/src/main/java/online/megaxo/prototype/MegaAndroidAds.kt native/ios/MegaXO/MegaIOSAds.swift|tests/monetization-policy.test.js|DUU|Native fill and earned-event device proof separate|reward
UMP advertising privacy controls|Ads|native/android/app/src/main/java/online/megaxo/prototype/MegaAndroidAds.kt native/ios/MegaXO/MegaIOSAds.swift|tests/v52-consent-ui.test.js|DUU|Physical consent workflows and store disclosures NOT_RUN|consent
Automatic interstitial cadence|Ads|src/monetization.js native/android/app/src/main/java/online/megaxo/prototype/MegaAndroidAds.kt native/ios/MegaXO/MegaIOSAds.swift|tests/monetization-policy.test.js|DUU|SDK show and no-fill behavior require device evidence|interstitial
Sponsor slots and optional interests|Ads|apps/web/pages.js src/sponsors-ui.js apps/api/routes/sponsors.js|tests/v52-public-annotations.test.js|UUU|No active sponsor is truthful empty state; no fabricated campaign|sponsorsPage
Browser default Mega XOXO Neon cinematic|Themes|apps/web/board.js apps/web/board.css|tests/v5-p21-board.test.js|WDD|Browser default only; future paid native Neon not activated|theme: GAME_THEMES
Vector Light retained theme|Themes|apps/web/board.js src/app.js src/styles.css|tests/v52-match-redesign.test.js|UBB|Native saved Vector gets overwritten to After Hours on reload; SAGAN-001|if(data.settings.theme==='vector'
Midnight Club retained theme|Themes|apps/web/board.js src/app.js src/styles.css|tests/v52-match-redesign.test.js|UUU|Five browser entries; four native entries|const themeNames
Paper Club retained theme|Themes|apps/web/board.js src/app.js src/styles.css|tests/v52-match-redesign.test.js|UUU|Physical contrast/AT acceptance NOT_RUN|const themeNames
After Hours retained and native default|Themes|src/app.js native/android/app/src/main/java/online/megaxo/prototype/MegaAndroidThemeBridge.kt native/ios/MegaXO/MegaNativeTheme.swift|tests/v52-match-redesign.test.js|UUU|Native first-run branch exists; saved Vector preservation is broken|if(data.settings.theme==='vector'
Reduced motion sound haptics and narration settings|Accessibility|src/app.js src/styles.css apps/web/board.js|tests/v51-bot-tutorial.test.js|PUU|Website system reduced motion; app settings richer; physical AT NOT_RUN|function settings
Native themed system bars and safe areas|Accessibility|native/android/app/src/main/java/online/megaxo/prototype/MegaAndroidThemeBridge.kt native/ios/MegaXO/MegaNativeTheme.swift|tests/v5-native-foundations.test.js|DUU|Source rejects unknown themes; actual bar contrast NOT_RUN|class
Website desktop tablet 390 and 320 layout|Accessibility|apps/web/styles.css apps/web/board.css scripts/p21/browser-qa.cjs|tests/v5-p21-pages.test.js|BUU|Current CI presentation fails 2 of 935 checks; accessibility step skipped|viewport
Website keyboard and automatic accessibility gate|Accessibility|apps/web/board.js scripts/p21/accessibility-qa.cjs|tests/v5-p21-board.test.js|PUU|Current automatic accessibility step skipped after presentation failure|keydown
Android offline first-launch gameplay acceptance|Delivery|native/android/app/src/main/java/online/megaxo/prototype/MegaXOActivity.kt|tests/native-smoke-gameplay.test.js|DED|CI boot initialized; move-confirm CDP timeout; not a proven game defect|class
iOS simulator and physical launch acceptance|Delivery|native/ios/MegaXO/MegaXOApplication.swift|tests/v5-native-foundations.test.js|DDE|Simulator CI success is not physical iPhone acceptance|class
Public download discovery and store redirects|Website|apps/web/downloads.js apps/web/download-config.cjs apps/web/store-links.json|tests/v5-p21-download.test.js|UEE|Final public store listing and installed-app associations external|downloadHref
SEO sitemap canonical and legal routes|Website|apps/web/seo.js scripts/p21/build-web.js|tests/v5-p21-seo.test.js tests/v5-p21-web-build.test.js|WDD|Static generation scope only; no new publication or crawl request|WEBSITE_ROUTES
Offline navigation and service worker|Website|apps/web/offline.js scripts/p21/offline-worker.cjs|tests/v5-p21-offline.test.js|UDD|Browser offline cache is separate from native signed bundle|createOfflineWorker
Privacy terms support and deletion guidance|Website|public/privacy.html public/terms.html public/support.html public/delete-account.html scripts/p21/build-web.js|tests/v5-p21-pages.test.js|UUU|Legal main markup overrides fallback pages; navigation audit must follow that precedence|LEGAL_NAMES
Optional telemetry opt-in and withdrawal|Privacy|apps/web/metrics.js packages/services/metrics.js|tests/v52-metrics.test.js|UDD|Website analytics remains distinct from research consent|createTelemetryLane
Native deep links and app associations|Delivery|apps/api/routes/well-known.js native/android/app/src/main/AndroidManifest.xml native/ios/MegaXO/MegaXO.entitlements|tests/v52-apple-team-association.test.js|UEE|Play app-signing certificate and Apple team config must be verified externally|DEFAULT_ASSET_LINKS
Backup recovery and post-write PG authority|Architecture|packages/services/worker-workflows.js scripts/v51/v5-production-server.cjs|tests/v5-p15-real-encrypted.test.js|UUU|Read-only source audit; no VPS or recovery operation performed|createAccountService
Same-origin API realtime and host-only cookie|Architecture|src/account-client.js apps/web/realtime.js scripts/v51/v5-production-server.cjs|tests/v52-compose-fence.test.js tests/v52-web-oauth.test.js|UUU|Canonical megaxo.online; production state not inferred from PR CI|__Host-mega_session
Feature kill switches and conservative fallback|Architecture|src/app.js src/powers-ui.js packages/services/core.js|tests/powers-game-ui.test.js|UUU|Default powers ON; explicit local/host off switches honored|const POWERS_ON
Website service-information page|Website|apps/web/pages.js|tests/v5-p21-pages.test.js|UDD|Informational page; not a live uptime monitor|function statusPage
Website news page|Website|apps/web/pages.js|tests/v5-p21-pages.test.js|UDD|Static editorial content; no publishing backend implied|function newsPage
`.trim().split('\n').map(row=>row.split('|'));
const decode={W:'VERIFIED_WORKING',U:'IMPLEMENTED_UNVERIFIED',P:'PARTIALLY_IMPLEMENTED',D:'DISABLED',E:'BLOCKED_EXTERNAL',B:'BROKEN',N:'NOT_IMPLEMENTED'};
const features=definitions.map((r,i)=>{
 const [label,category,paths,tests,codes,limitations,anchor]=r;
 const sources=paths.split(' '); for(const p of sources)if(!exists(p))throw Error('Missing feature source '+p);
 const checkedTests=tests.split(' ').filter(exists);
 const states=[...codes].map(c=>decode[c]);
 if(states.length!==3||states.some(s=>!STATUSES.has(s)))throw Error('Feature status '+label);
 const active=states.filter(s=>s!=='DISABLED');
 const status=states.every(s=>s==='NOT_IMPLEMENTED')?'NOT_IMPLEMENTED':states.includes('BROKEN')?'BROKEN':states.includes('PARTIALLY_IMPLEMENTED')||states.includes('NOT_IMPLEMENTED')?'PARTIALLY_IMPLEMENTED':
  active.length&&active.every(s=>s==='VERIFIED_WORKING')?'VERIFIED_WORKING':
  !active.length?'DISABLED':active.every(s=>s==='BLOCKED_EXTERNAL')?'BLOCKED_EXTERNAL':'IMPLEMENTED_UNVERIFIED';
 const p=sources.find(p=>read(p).includes(anchor))||sources[0],line=locate(p,anchor);
 const f={feature_id:'F'+String(i+1).padStart(3,'0'),feature:label,category,status,web:states[0],android:states[1],ios:states[2],
  sources,source:p,line,symbol:anchor,tests:checkedTests,execution_evidence:states.includes('VERIFIED_WORKING')?(category==='Website'||label.includes('interactive board')?CI.website:label.startsWith('Realtime')?CI.realtime:CI.regression):'NOT_RUN for current feature journey; test files are coverage references only',limitations,owner:category==='Architecture'?'Main agent':category==='Bots'?'Main agent / Human':'Codex app / Main agent'};
 const id=node('Feature',label,p,line,anchor,{id:f.feature_id,status,platforms:{web:f.web,android:f.android,ios:f.ios},limitations});
 for(const source of sources)edge(id,moduleOf(source),'DEPENDS_ON',source,1,'curated implementation slice');
 for(const test of checkedTests)edge(id,moduleOf(test),'TESTED_BY',test,1,'test definition; execution evidence is separately scoped');
 return f;
});

/* Static website route inventory. Parse the literal declaration without executing the builder. */
const builder=read('scripts/p21/build-web.js');
const routeDeclaration=builder.match(/const WEBSITE_ROUTES\s*=\s*(\[[\s\S]*?\]);/)[1];
const explicitRoutes=routeDeclaration.replace(/\.\.\.LEGAL_NAMES\.map\([^)]*\),?\s*/g,'');
const legalNames=[...builder.match(/const LEGAL_NAMES\s*=\s*\[([^\]]+)\]/)[1].matchAll(/'([^']+)'/g)].map(m=>m[1]);
const routes=[...new Set([...explicitRoutes.matchAll(/'([^']+)'/g)].map(m=>m[1]).concat(legalNames.map(n=>'/legal/'+n)))].sort(compare);
const pagesSource=read('apps/web/pages.js');
const rendererTable=pagesSource.slice(pagesSource.indexOf('const renderers ='));
const renderers=new Map([...rendererTable.matchAll(/'([^']+)'\s*:\s*([A-Za-z][\w]*)/g)].map(m=>[m[1],m[2]]));
const routeNodes=new Map();
const pageRows=routes.map((route,i)=>{
 const legal=route.startsWith('/legal/')?route.slice(7):route.slice(1);
 const legalSource=legalNames.includes(legal)?'public/'+legal+'.html':null;
 const renderer=route==='/'?'renderHome':route==='/game'?'renderGame':legalSource?'trusted legal main':renderers.get(route)||'renderPage /404 fallback';
 const source=route==='/'?'apps/web/site.js':route==='/game'?'apps/web/board.js':legalSource||'apps/web/pages.js';
 const line=legalSource?locate(source,'<main'):locate(source,renderer);
 const state=route==='/account'?'guest/loading/linked/verify/recover/reset/error':route==='/game'?'bot/local/ranked/casual/friend/tournament/spectator/terminal':
  ['/friends','/profile','/leaderboard','/store','/tournaments'].includes(route)?'guest/loading/linked/empty/error/busy':'static / responsive';
 const status=['/sponsors','/ads'].includes(route)?'BROKEN':route==='/account'?'PARTIALLY_IMPLEMENTED':'IMPLEMENTED_UNVERIFIED';
 const id=node('Screen',route,source,line,route,{route,renderer,status,platform:'web',state});routeNodes.set(route,id);
 edge(moduleOf('scripts/p21/build-web.js'),id,'PUBLISHES','scripts/p21/build-web.js',locate('scripts/p21/build-web.js','const WEBSITE_ROUTES'),'build allowlist; not deployment');
 edge(id,moduleOf(source),'RENDERS',source,line,'renderer or trusted legal document');
 return ['WEB-'+String(i+1).padStart(3,'0'),route,renderer,source,line,state,status,'NOT_RUN physical/visual on this checkout',
  legalSource?'Trusted public main overrides pages.js fallback':'Build-listed route; runtime reachability and visual acceptance separate'];
});

/* Screen states in the shared native WebView, not invented platform-native screens. */
const mobileDefinitions=[
 ['Home and match setup','src/app.js','function home','bot/local/online/private/tournament'],
 ['Live game board','src/app.js','function paint','playing/thinking/terminal/recovery'],
 ['Store','src/monetization-ui.js','pageMarkup','loading/available/unavailable'],
 ['Leaderboard','src/app.js','function rank','rating/wealth/league/scope'],
 ['Friends','src/community.js','friendsMarkup','guest/requests/friends/blocked'],
 ['Stats','src/app.js','function statsView','bot/ranked/casual/friend/tournament'],
 ['Settings','src/app.js','function settings','theme/sound/motion/haptics'],
 ['Wallet and exchange','src/app.js','function wallet','local/linked/quote/confirmation'],
 ['Rules','src/app.js','function rules','instructions'],
 ['Guided tutorial','src/app.js','function tutorial','prompt/move/continue/handoff'],
 ['Impossible pack and recovery','src/bot/pack-ui.js','function','unavailable/download/error/retry'],
 ['Match result and loss Undo offer','src/app.js','function finish','win/loss/draw/accept/undo'],
 ['Restart leave and resign confirmation','src/app.js','restartyes','confirm/cancel'],
 ['Queue and offer review','src/app.js','function onlineInfo','search/review/wait/expired'],
 ['Welcome and guest continuation','src/community.js','function landing','guest/link/login'],
 ['Email authentication','src/community.js','function emailForm','continue/link/reauth/change'],
 ['Email OTP','src/community.js','function otpForm','verify/resend/expired'],
 ['Forgot password','src/community.js','function forgotForm','request/reset-ready'],
 ['Reset password','src/community.js','function resetPasswordForm','password/confirmation'],
 ['Email-match choice','src/community.js','function decisionChoice','legacy-only; missing PG lane'],
 ['Existing-profile proof','src/community.js','function decisionProof','legacy-only; missing PG lane'],
 ['New-profile deletion confirmation','src/community.js','function decisionConfirmNew','legacy-only; missing PG lane'],
 ['Profile viewer','src/community.js','function showProfile','self/other/stats'],
 ['Profile editor','src/community.js','function editProfile','username/display/avatar/privacy'],
 ['Player report','src/community.js','function reportPlayerForm','reason/submit'],
 ['Linked identities and sessions','src/community.js','async function connections','reauth/link/unlink/revoke'],
 ['Privacy export','src/community.js','async function downloadMyData','reauth/download'],
 ['Permanent deletion','src/community.js','function deleteAccountForm','reauth/tag/confirm'],
 ['Cloud save conflict','src/community.js','function chooseSave','device/cloud/archived'],
 ['Research consent','src/community.js','research','not-recorded/opt-in/withdraw'],
 ['Private lobby and room','src/party-ui.js','function','host/join/invite/settings'],
 ['Tournament room and fixtures','src/tournament.js','function','join/start/fixtures/results'],
 ['LAN host join and discovery','src/party-ui.js','LAN','permissions/advertise/discover/join/leave'],
 ['Rewarded ad purchase fallback','src/app.js','function offerPowerPurchase','optional-ad/Crowns/no-fill'],
 ['Counter power disclosure','src/app.js','counterDisclosure','Undo Block / Hint Block unavailable'],
 ['Connection status and diagnostics','src/app.js','function renderConnectivity','offline/auth/timeout/maintenance'],
 ['Sponsor and ad interests','src/sponsors-ui.js','function','catalog/empty/preferences'],
];
const mobileRows=[];
for(const platform of ['android','ios'])for(const [label,p,symbol,state] of mobileDefinitions){
 const line=locate(p,symbol),status=label.includes('Email-match')||label.includes('Existing-profile proof')||label.includes('New-profile')||label==='Linked identities and sessions'?'BROKEN':'IMPLEMENTED_UNVERIFIED';
 const id=node('Screen',platform+': '+label,p,line,platform+':'+symbol+':'+label,{platform,status,state});
 edge(id,moduleOf(p),'RENDERS',p,line,'shared WebView screen state; device acceptance NOT_RUN');
 mobileRows.push([platform.toUpperCase()+'-S'+String(mobileRows.filter(r=>r[1]===platform).length+1).padStart(3,'0'),platform,label,'shared WebView',p,symbol,line,state,status,'NOT_RUN physical device at audit SHA']);
}

const interactions=[];
function interaction(platform,p,offset,selector,value,label,kind='button',handler='delegated event dispatcher',notes='Static binding only; runtime/visual acceptance NOT_RUN') {
 const line=lineAt(read(p),offset),key=[platform,p,offset,selector,value].join(':');
 if(interactions.some(r=>r.key===key))return;
 let status='IMPLEMENTED_UNVERIFIED';
 if(/powercounters|undoBlock|tacticalBlock/.test(value)&&kind==='disabled button')status='DISABLED';
 if(p==='apps/web/pages.js'&&label==='Linked accounts & recovery')status='BROKEN';
 const row={key,platform,source:p,line,selector,value,label:label||value,kind,handler,status,notes};
 interactions.push(row);
 const button=node('Button',row.label,p,line,key,{platform,status,selector,value,interaction_kind:kind});
 edge(moduleOf(p),button,'CONTAINS',p,line,'literal interaction declaration');
 const hp=p==='index.html'?'src/app.js':platform==='web'&&p.startsWith('apps/web/')?'apps/web/app.js':p;
 edge(button,moduleOf(hp),kind==='navigation'?'NAVIGATES_TO':'TRIGGERS',p,line,handler,'lexical; not execution proof');
 if(kind==='navigation'){
  const target=value.split('?')[0].split('#')[0];
  if(routeNodes.has(target))edge(button,routeNodes.get(target),'NAVIGATES_TO',p,line,'literal href / helper target');
 }
}
const uiFiles=sourceFiles.filter(p=>(p==='index.html'||/^(?:src\/|apps\/web\/|public\/)/.test(p))&&/\.(?:js|html)$/.test(p)&&!p.startsWith('src/lan/'));
for(const p of uiFiles){
 const s=read(p),platform=/^(?:apps\/web\/|public\/)/.test(p)?'web':'shared-app';
 const strip=v=>v.replace(/<[^>]*>/g,' ').replace(/\$\{[^}]*\}/g,'[dynamic]').replace(/\s+/g,' ').trim().slice(0,140);
 for(const m of s.matchAll(/data-((?:[\w-]*action)|c|party|monetization|sponsor|setting|gb-guided|gb-setting|gb-power|gb-cell|pb|pc|friend-request|[\w-]*form|power-request|power-apply)\s*=\s*(["'])(.*?)\2/g)){
  const start=s.lastIndexOf('<',m.index),end=s.indexOf('>',m.index),tag=s.slice(start,end+1);
  if(start<0||!/^<(?:button|a|input|select|textarea|form)\b/.test(tag)||s.indexOf('>',start)<m.index)continue;
  const labelEnd=s.indexOf('</',end),label=tag.match(/(?:aria-label|title)="([^"]+)"/)?.[1]||strip(s.slice(end+1,labelEnd>0&&labelEnd-end<800?labelEnd:end+160));
  const disabled=/\sdisabled(?:[\s=>]|$)/.test(tag);
  interaction(platform,p,m.index,'[data-'+m[1]+'="'+m[3]+'"]',m[3],label,disabled?'disabled button':'button','data-'+m[1]+' delegated dispatcher');
 }
 for(const m of s.matchAll(/\b(fullButton|btn|button)\(\s*(['"])([^'"\n]+)\2\s*,\s*(['"])([^'"\n]+)\4/g)){
  const target=m[5],kind=/^(?:\/|https?:|mailto:|#)/.test(target)?'navigation':'button';
  interaction(platform,p,m.index,m[1]+'('+target+')',target,m[3],kind,'helper '+m[1]+' / '+target);
 }
 for(const m of s.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/g)){
  if(m[1].includes('${')||m[1].includes("'+"))continue;
  interaction(platform,p,m.index,'a[href="'+m[1]+'"]',m[1],strip(m[2]),'navigation','anchor navigation');
 }
 for(const m of s.matchAll(/<(input|select|textarea|summary|button)\b([^>]*)>/g)){
  if(m[1]==='button'&&/data-(?:[\w-]*action|c|party|monetization|gb-guided|gb-power)/.test(m[2]))continue;
  const key=m[2].match(/\b(id|name)=["']([^"']+)["']/),label=strip(s.slice(m.index+m[0].length,m.index+m[0].length+130));
  interaction(platform,p,m.index,key?m[1]+'['+key[1]+'="'+key[2]+'"]':m[1]+':line:'+lineAt(s,m.index),key?.[2]||m[1],key?.[2]||label,m[1]==='summary'?'disclosure':m[1]==='button'?'button':'field/change',m[1]==='summary'?'native details toggle':'form/change handler; dynamic fields need runtime expansion','One source control family; loops/templates not expanded into runtime instances');
 }
 for(const m of s.matchAll(/addEventListener\(\s*['"]([^'"]+)['"]/g)){
  const h=node('Hook',p+': '+m[1],p,lineAt(s,m.index),'event:'+m.index,{platform,event:m[1]});
  edge(moduleOf(p),h,'SUBSCRIBES_TO',p,lineAt(s,m.index),'event listener registration');
 }
}
// Dynamic helper declarations are represented once per actual named control, not per board cell.
for(const [kind,label,action,disabled] of [['undo','Undo','botundo',false],['undoBlock','Undo Block','powercounters',true],['hint','Tactical Hint','bothint',false],['tacticalBlock','Hint Block','powercounters',true]]){
 const p='src/app.js',s=read(p),at=s.indexOf("card('"+kind+"'");
 interaction('shared-app',p,at,'power-card:'+kind,action,label,disabled?'disabled button':'button','actions.'+action,disabled?'Explicit unavailable state; counter protocol is not shipped':'Bot-only eligibility, revision fence, earned charge or Crown purchase');
}
const nativeActions=[
 ['android','native/android/app/src/main/java/online/megaxo/prototype/MegaAndroidIdentityBridge.kt','signIn','Google / Apple provider sheet','provider login/link/reauth'],
 ['android','native/android/app/src/main/java/online/megaxo/prototype/MegaPlayBilling.kt','purchase','Google Play purchase sheet','purchase/restore/cancel'],
 ['android','native/android/app/src/main/java/online/megaxo/prototype/MegaAndroidAds.kt','show','Rewarded / interstitial SDK UI','earned/dismissed/no-fill'],
 ['android','native/android/app/src/main/java/online/megaxo/prototype/MegaAndroidAds.kt','privacy','Advertising privacy form','consent/update/dismiss'],
 ['android','native/android/app/src/main/java/online/megaxo/prototype/MegaAndroidLanBridge.kt','permission','LAN permission dialog','grant/deny/retry'],
 ['android','native/android/app/src/main/java/online/megaxo/prototype/MegaAndroidLocalNotifications.kt','permission','Notification permission dialog','grant/deny/settings'],
 ['android','native/android/app/src/main/java/online/megaxo/prototype/MegaXOActivity.kt','onBack','Android Back navigation','game/dialog/back/leave'],
 ['ios','native/ios/MegaXO/MegaIOSIdentityBridge.swift','signIn','Apple / Google identity sheet','provider login/link/reauth'],
 ['ios','native/ios/MegaXO/MegaStoreKit.swift','purchase','StoreKit purchase sheet','purchase/restore/cancel'],
 ['ios','native/ios/MegaXO/MegaIOSAds.swift','show','Rewarded / interstitial SDK UI','earned/dismissed/no-fill'],
 ['ios','native/ios/MegaXO/MegaIOSAds.swift','privacy','Advertising privacy form','consent/update/dismiss'],
 ['ios','native/ios/MegaXO/MegaNativeLan.swift','permission','Local network permission','grant/deny/retry'],
 ['ios','native/ios/MegaXO/MegaLocalNotifications.swift','permission','Notification permission dialog','grant/deny/settings'],
];
for(const [platform,p,symbol,label,states] of nativeActions){
 const s=read(p),offset=Math.max(0,s.toLowerCase().indexOf(symbol.toLowerCase()));
 interaction(platform,p,offset,'native:'+symbol,states,label,'native system interaction',symbol,'Native adapter declaration; provider UI and physical device acceptance NOT_RUN');
 const id=node('Screen',platform+': '+label,p,lineAt(s,offset),label,{platform,status:'IMPLEMENTED_UNVERIFIED',state:states});
 edge(moduleOf(p),id,'RENDERS',p,lineAt(s,offset),'SDK/system prompt integration; no claim of execution');
 mobileRows.push([platform.toUpperCase()+'-N'+String(mobileRows.filter(r=>r[1]===platform&&r[3]==='native system').length+1).padStart(3,'0'),platform,label,'native system',p,symbol,lineAt(s,offset),states,'IMPLEMENTED_UNVERIFIED','NOT_RUN provider / physical device at audit SHA']);
}

/* HTTP routes: frozen manifest supplies method/auth/surface; lexical handlers remain traceable. */
const contractPath='packages/contracts/routes.js',contract=read(contractPath);
const endpoints=[];
for(const url of ['/api/account/decision','/api/account/decision/verify','/api/account/native/decision']){
 const p='server/community-http.js',line=locate(p,url),id=node('API Endpoint','POST '+url+' (legacy only)',p,line,'legacy:'+url,{url,method:'POST',surface:'LEGACY_SQLITE_ONLY',status:'BROKEN'});
 edge(id,moduleOf(p),'CALLS',p,line,'SQLite dispatcher only; no PostgreSQL production handler');
 edge(moduleOf('src/community.js'),id,'CALLS','src/community.js',locate('src/community.js',url),'UI references legacy-only decision endpoint');
}
for(const m of contract.matchAll(/\broute\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'([^\n]*)/g)){
 const [_,routeId,method,url,options]=m,line=lineAt(contract,m.index);
 const auth=options.match(/auth:\s*AUTH\.(\w+)/)?.[1]||'SESSION';
 const owner=options.match(/owner:\s*'([^']+)'/)?.[1]||'A';
 const endpoint=node('API Endpoint',method+' '+url,contractPath,line,routeId,{route_id:routeId,method,url,auth,owner,csrf:/csrf:\s*true/.test(options),surface:options.match(/surface:\s*SURFACE\.(\w+)/)?.[1]||'MOUNTED'});
 endpoints.push({id:endpoint,url,method});edge(moduleOf(contractPath),endpoint,'CONTAINS',contractPath,line,'frozen route manifest');
 const candidates=sourceFiles.filter(p=>/^apps\/api\/routes\/.*\.js$/.test(p)&&read(p).includes(url));
 for(const p of candidates){edge(endpoint,moduleOf(p),'CALLS',p,locate(p,url),'literal route dispatcher reference');edge(moduleOf(p),endpoint,'AUTHORIZES',contractPath,line,'route auth='+auth+'; enforcement lives in handler/middleware');}
}
const normalizeUrl=url=>url.replace(/[?].*$/,'').replace(/\$\{[^}]+\}/g,':dynamic');
for(const [p,s] of text){
 if(!/\.(?:js|cjs|mjs|kt|swift|py)$/.test(p))continue;
 for(const m of s.matchAll(/['"`]((?:\/api\/|\/auth\/|\/realtime\/)[^'"`\s<>)]*)['"`]/g)){
  const url=normalizeUrl(m[1]);
  for(const e of endpoints){
   const prefix=e.url.split('/:')[0];
   if(url===e.url||(e.url.includes('/:')&&url.startsWith(prefix+'/')))
    if(p.startsWith('tests/'))edge(e.id,moduleOf(p),'TESTED_BY',p,lineAt(s,m.index),'literal endpoint reference; not an executed coverage claim','lexical');
    else edge(moduleOf(p),e.id,'CALLS',p,lineAt(s,m.index),'literal endpoint reference; request method may be dynamic','lexical');
  }
 }
}
function resolveImport(p,spec){
 if(!spec.startsWith('.'))return null;
 const base=path.posix.normalize(path.posix.join(path.posix.dirname(p),spec));
 return [base,base+'.js',base+'.cjs',base+'.mjs',base+'/index.js'].find(candidate=>fileNodes.has(candidate));
}
for(const [p,s] of text){
 for(const m of s.matchAll(/(?:require\(\s*|\bfrom\s+|\bimport\s+)(['"])([^'"\n]+)\1/g)){
  const target=resolveImport(p,m[2]);if(!target)continue;
  if(p.startsWith('tests/'))edge(moduleOf(target),moduleOf(p),'TESTED_BY',p,lineAt(s,m.index),'direct test import; not an executed coverage claim');
  else edge(moduleOf(p),moduleOf(target),'DEPENDS_ON',p,lineAt(s,m.index),'literal relative import');
 }
 // Stable named functions are useful waypoints; do not invent whole-program call resolution.
 if(/^(?:src\/|apps\/api\/routes\/|packages\/services\/)/.test(p))for(const m of s.matchAll(/\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)){
  const type=p.startsWith('apps/api/')?'Backend Handler':'Utility';
  const n=node(type,m[1],p,lineAt(s,m.index),m[1]);edge(moduleOf(p),n,'CONTAINS',p,lineAt(s,m.index),'named function declaration; lexical scope not resolved');
 }
 for(const m of s.matchAll(/\bprocess\.env\.([A-Z][A-Z0-9_]+)/g)){
  const n=node('Config-Flag',m[1],p,lineAt(s,m.index),'env:'+m[1]);edge(moduleOf(p),n,'CONFIGURED_BY',p,lineAt(s,m.index),'environment key name only; values never read');
 }
 for(const m of s.matchAll(/(?:localStorage|sessionStorage)\.(?:getItem|setItem|removeItem)\(\s*['"]([^'"]+)['"]/g)){
  const n=node('State Store',m[1],p,lineAt(s,m.index),'storage:'+m[1]);
  edge(moduleOf(p),n,m[0].includes('getItem')?'READS':'WRITES',p,lineAt(s,m.index),'literal browser storage key');
 }
}
/* UMD globals tie separately packaged browser scripts to their actual provider files. */
const globals=new Map();
for(const [p,s] of text)if(!p.startsWith('tests/'))for(const m of s.matchAll(/\b(?:root|globalThis|window)\.(Mega\w+)\s*=/g)){
 if(!globals.has(m[1]))globals.set(m[1],[]);globals.get(m[1]).push(p);
}
for(const [p,s] of text)for(const m of s.matchAll(/\b(?:root|globalThis|window)\.(Mega\w+)\b/g))for(const target of globals.get(m[1])||[]){
 if(target!==p&&!p.startsWith('tests/'))edge(moduleOf(p),moduleOf(target),'DEPENDS_ON',p,lineAt(s,m.index),'UMD global reference '+m[1]+'; bundle loading must be checked separately','lexical');
}
/* SQL table declaration and operation references. No connection, introspection or credentials. */
const tables=new Map();
for(const [p,s] of text)if(p.endsWith('.sql'))for(const m of s.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][\w]*\.[a-z_][\w]*)/gi)){
 const name=m[1].toLowerCase();if(!tables.has(name))tables.set(name,node('DB Table',name,p,lineAt(s,m.index),name,{schema:name.split('.')[0]}));
}
for(const [p,s] of text)if(/\.(?:js|cjs|sql)$/.test(p))for(const m of s.matchAll(/\b(FROM|JOIN|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_][\w]*\.[a-z_][\w]*)/gi)){
 const table=tables.get(m[2].toLowerCase());if(table)edge(moduleOf(p),table,/^(?:FROM|JOIN)$/i.test(m[1])?'READS':'WRITES',p,lineAt(s,m.index),'literal SQL operation '+m[1]);
}
const providers=[
 ['Google identity','server/identity-provider.js','google'],['Apple identity','server/identity-provider.js','apple'],
 ['Google Play Billing','native/android/app/src/main/java/online/megaxo/prototype/MegaPlayBilling.kt','class'],
 ['Apple StoreKit','native/ios/MegaXO/MegaStoreKit.swift','class'],['Cashfree','packages/services/cashfree.js','Cashfree'],
 ['Polar','packages/services/polar.js','Polar'],['Resend email','packages/services/mail-resend.js','resend'],
 ['Android AdMob / UMP','native/android/app/src/main/java/online/megaxo/prototype/MegaAndroidAds.kt','class'],
 ['iOS ads / consent','native/ios/MegaXO/MegaIOSAds.swift','class'],
 ['Managed Redis / Valkey','packages/services/managed-ephemera.js','function'],
];
for(const [label,p,symbol] of providers){const line=locate(p,symbol),n=node('External Provider',label,p,line,label,{status:'IMPLEMENTED_UNVERIFIED'});edge(moduleOf(p),n,'CALLS',p,line,'provider adapter source; configuration / approval not inferred');}
for(const [p,s] of text)if(/(?:packages\/services\/|apps\/worker\/)/.test(p))for(const m of s.matchAll(/(?:const\s+[A-Z_]*(?:KIND|JOB)[A-Z_]*\s*=\s*|kind:\s*)['"]([a-z][\w.-]+)['"]/g)){
 const n=node('Job',m[1],p,lineAt(s,m.index),'job:'+m[1]);edge(moduleOf(p),n,'PUBLISHES',p,lineAt(s,m.index),'durable job kind reference');
 if(exists('packages/services/worker-workflows.js'))edge(n,moduleOf('packages/services/worker-workflows.js'),'DEPENDS_ON',p,lineAt(s,m.index),'worker ownership candidate; dispatcher must confirm exact kind','curated');
}
for(const [p,key] of [['src/app.js','mega_v32_state'],['src/app.js','mega_v52_powers'],['src/community.js','mega_v333_archive:'],['apps/web/bot-compat.js','mega'],['src/account-client.js','__Host-mega_session']]){
 const n=node('State Store',key,p,locate(p,key),key);edge(moduleOf(p),n,'READS',p,locate(p,key),'curated persistence / session boundary');
}

const nodeList=[...nodes.values()].sort((a,b)=>compare(a.id,b.id));
const edgeList=[...edges.values()].sort((a,b)=>compare(a.id,b.id));
for(const e of edgeList)if(!nodes.has(e.source)||!nodes.has(e.target)||!exists(e.evidence.path))throw Error('Dangling graph edge '+e.id);
const metadata={schema:'mega-xoxo-final-audit-graph/v1',generator:'scripts/audit/generate-architecture-graph.cjs',source_commit:sourceCommit,source_digest:sourceDigest,
 method:'deterministic literal/regex extraction plus explicit curated feature/screen/provider mappings; not a complete AST/call graph',
 source_file_count:sourceFiles.length,node_count:nodeList.length,edge_count:edgeList.length,feature_count:features.length,website_route_count:routes.length,
 node_types:[...NODE_TYPES],edge_types:[...EDGE_TYPES]};
write('architecture/architecture-nodes.json',JSON.stringify({metadata,nodes:nodeList},null,2)+'\n');
write('architecture/architecture-edges.json',JSON.stringify({metadata,edges:edgeList},null,2)+'\n');
const xml=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
write('architecture/feature-dependencies.graphml','<?xml version="1.0" encoding="UTF-8"?>\n<graphml xmlns="http://graphml.graphdrawing.org/xmlns">\n'+
 [['label','node'],['type','all'],['path','all'],['line','all'],['symbol','node'],['status','node'],['basis','edge']].map(([k,on])=>`<key id="${k}" for="${on}" attr.name="${k}" attr.type="string"/>`).join('\n')+
 '\n<graph id="mega-xoxo" edgedefault="directed">\n'+nodeList.map(n=>`<node id="${n.id}"><data key="label">${xml(n.label)}</data><data key="type">${xml(n.type)}</data><data key="path">${xml(n.source.path)}</data><data key="line">${n.source.line}</data><data key="symbol">${xml(n.source.symbol)}</data><data key="status">${xml(n.status)}</data></node>`).join('\n')+'\n'+
 edgeList.map(e=>`<edge id="${e.id}" source="${e.source}" target="${e.target}"><data key="type">${e.type}</data><data key="path">${xml(e.evidence.path)}</data><data key="line">${e.evidence.line}</data><data key="basis">${xml(e.evidence.basis)}</data></edge>`).join('\n')+'\n</graph>\n</graphml>\n');
const mermaidLabel=s=>s.replaceAll('"',"'").replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('[','(').replaceAll(']',')').replace(/[\r\n]/g,' ');
write('architecture/feature-dependencies.mmd','%% Generated full graph; use graph-viewer for large interactive exploration.\n%% Source '+sourceCommit+'\nflowchart LR\n'+
 nodeList.map(n=>`  ${n.id}["${mermaidLabel(n.type+': '+n.label)}"]`).join('\n')+'\n'+edgeList.map(e=>`  ${e.source} -->|${e.type}| ${e.target}`).join('\n')+'\n');
const featureHeaders=['feature_id','feature','category','status','web_status','android_status','ios_status','source_paths','file','symbol','line','test_evidence','execution_evidence','limitations','owner'];
write('features/FEATURE-INVENTORY.csv',csv([featureHeaders,...features.map(f=>[f.feature_id,f.feature,f.category,f.status,f.web,f.android,f.ios,f.sources.join('; '),f.source,f.symbol,f.line,f.tests.join('; '),f.execution_evidence,f.limitations,f.owner])]));
write('features/FEATURE-PARITY-MATRIX.csv',csv([['feature_id','feature','web_status','android_status','ios_status','parity','evidence','gap'],...features.map(f=>[f.feature_id,f.feature,f.web,f.android,f.ios,new Set([f.web,f.android,f.ios]).size===1?'same classification; execution scope still differs':'DIFFERENT',f.sources.join('; ')+'; '+f.tests.join('; '),f.limitations])]));
const counts=Object.fromEntries([...STATUSES].map(s=>[s,features.filter(f=>f.status===s).length]));
write('features/FEATURE-INVENTORY.md',`# V5.2 feature inventory\n\nSource: \`${sourceCommit}\`. Static audit, no local test execution, live writes, provider calls or device acceptance.\n\n`+
 `Generated by \`node scripts/audit/generate-architecture-graph.cjs\`. ${features.length} semantic feature rows; ${routes.length} website routes; ${mobileRows.length} platform-specific screen/state rows. These are inventory counts, not readiness percentages.\n\n`+
 `## Classification\n\n${Object.entries(counts).map(([s,n])=>'- '+s+': '+n).join('\n')}\n\n`+
 'VERIFIED_WORKING is restricted to the stated automated CI scope; a browser harness or pure policy test is not provider/device/live proof. IMPLEMENTED_UNVERIFIED means a source path exists but this audit has not established the complete current journey. PARTIALLY_IMPLEMENTED records a missing platform or authority leg. DISABLED is deliberate closure, not a dead-button allegation. BLOCKED_EXTERNAL identifies a missing model/store/device gate. BROKEN records a concrete static or CI failure. NOT_IMPLEMENTED is reserved for absent contracted behavior.\n\n'+
 'CI input head is `7f582b749a1128b86e53ddcbcda57b569b0953cf`; PR checks built synthetic merge `b645f404cdd512a87e00ef0f31318b6bc8de6894` where reported. CI must not be represented as direct physical acceptance of HEAD. Test paths are coverage references unless the execution_evidence column explicitly supplies an observed passing job.\n\n'+
 '## Required distinctions\n\n- Browser theme inventory is exactly cinematic (Mega XOXO Neon default), vector, midnight, paperclub, afterhours.\n- Native ships the four retained originals, with After Hours first-run intent. Saved Vector is overwritten by the current native default condition (SAGAN-001). Browser Neon does not activate paid native Neon.\n- Controls are exactly Undo, Undo Block, Tactical Hint, Hint Block. Counter powers are intentionally unavailable; website bank copy still drifts (SAGAN-005).\n- Guided tutorial and optional local Impossible are UNVERIFIED and UNPAID. Current source has an empty approved neural catalog. Historical Expert and neural league results belong to their measured hashes and budgets.\n- SQLite-only account decision work is not a production PostgreSQL implementation (SAGAN-002).\n\n'+
 '## Inventory\n\n| ID | Feature | Status | Source | Limitation |\n| --- | --- | --- | --- | --- |\n'+features.map(f=>`| ${f.feature_id} | ${f.feature} | ${f.status} | [${f.source}:${f.line}](../../../../${f.source}#L${f.line}) | ${f.limitations.replaceAll('|','/')} |`).join('\n')+'\n');
write('ui/WEB-PAGE-INVENTORY.csv',csv([['page_id','route','renderer','file','line','states','status','execution_evidence','notes'],...pageRows]));
write('ui/MOBILE-SCREEN-INVENTORY.csv',csv([['screen_id','platform','screen','surface','file','symbol','line','states','status','evidence'],...mobileRows]));
const interactionHeaders=['interaction_id','platform','file','line','selector','value','label','kind','handler','status','evidence'];
function interactionRows(platform){
 const rows=interactions.filter(r=>r.platform===platform||(platform!=='web'&&r.platform==='shared-app')||(platform==='web'&&r.platform==='shared-app'))
  .sort((a,b)=>compare(a.source,b.source)||a.line-b.line||compare(a.selector,b.selector));
 return rows.map((r,i)=>[platform.toUpperCase()+'-I'+String(i+1).padStart(4,'0'),platform,r.source,r.line,r.selector,r.value,r.label,r.kind,r.handler,r.status,
  r.platform==='shared-app'?(platform==='web'?'Retained /legacy-game UI, not main website shell. ':'Shared signed WebView UI; not a platform-native widget. ')+r.notes:r.notes]);
}
for(const platform of ['web','android','ios'])write('ui/'+platform.toUpperCase()+'-INTERACTION-INVENTORY.csv',csv([interactionHeaders,...interactionRows(platform)]));

/* One-file, offline, vanilla-JS neighborhood viewer. No fetch/import/CDN/remote fonts. */
const payload=JSON.stringify({metadata,nodes:nodeList,edges:edgeList}).replaceAll('<','\\u003c');
const viewer=String.raw`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mega XOXO V5.2 dependency audit</title>
<style>:root{color-scheme:dark;font:15px system-ui;background:#0d1320;color:#e6edf8}*{box-sizing:border-box}body{margin:0}header{padding:18px 24px;border-bottom:1px solid #33415a}h1{font-size:22px;margin:0 0 8px}p{margin:7px 0;color:#bdcce5}label{display:inline-flex;gap:7px;align-items:center;margin:6px 12px 6px 0}input,select,button{font:inherit;border:1px solid #61718a;background:#162237;color:inherit;border-radius:6px;padding:8px}button,a{cursor:pointer}a{color:#80c8ff}input:focus,button:focus,select:focus,a:focus{outline:3px solid #ffdd66;outline-offset:3px}main{display:grid;grid-template-columns:minmax(240px,320px) 1fr;min-height:70vh}aside{padding:14px;border-right:1px solid #33415a;overflow:auto;max-height:76vh}#list button{display:block;text-align:left;width:100%;margin:5px 0;font-size:13px}#workspace{padding:16px;min-width:0}#canvas{height:520px;overflow:auto;border:1px solid #42516b;border-radius:8px;background:#0a111d}svg{display:block}svg text{fill:#edf3ff;font:12px system-ui}svg line{stroke:#657998;stroke-width:1.1}svg rect{stroke:#94accd;fill:#243956}svg .selected rect{fill:#654016;stroke:#ffd369;stroke-width:2}#details{white-space:pre-wrap;overflow-wrap:anywhere;margin-top:12px}#neighbors{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:9px}#neighbors button{text-align:left;font-size:13px}summary{padding:12px;cursor:pointer}small{color:#adbbd3}#status{min-height:22px}@media(max-width:760px){main{grid-template-columns:1fr}aside{max-height:270px;border-right:0;border-bottom:1px solid #33415a}#canvas{height:420px}}</style>
<header><h1>Mega XOXO V5.2 · feature dependency audit</h1><p id="provenance"></p><p>Static dependencies and declarations. Edges are evidence links, not runtime coverage. Select a node to inspect callers and dependencies.</p><label>Search <input id="search" type="search" placeholder="Feature, endpoint, source, table…"></label><label>Type <select id="type"><option value="">All types</option></select></label><label>Direction <select id="direction"><option value="both">Both</option><option value="upstream">Dependents / incoming</option><option value="downstream">Dependencies / outgoing</option></select></label><label>Edge <select id="edge"><option value="">All relationships</option></select></label><button id="reset">Reset</button><button id="download">Download graph JSON</button><p id="status" role="status" aria-live="polite"></p></header>
<main><aside aria-label="Search results"><div id="list"></div></aside><section id="workspace" aria-label="Dependency neighborhood"><h2 id="heading">Choose a feature or source</h2><div id="canvas"><svg id="svg" role="img" aria-label="Selected dependency neighborhood"></svg></div><div id="details"></div><details open><summary>Accessible relationship list</summary><div id="neighbors"></div></details></section></main>
<script id="graph-data" type="application/json">__PAYLOAD__</script><script>
'use strict';
const graph=JSON.parse(document.getElementById('graph-data').textContent),byId=new Map(graph.nodes.map(n=>[n.id,n]));
const $=id=>document.getElementById(id),ns='http://www.w3.org/2000/svg';let selected=null;
const incoming=new Map(),outgoing=new Map();for(const e of graph.edges){if(!incoming.has(e.target))incoming.set(e.target,[]);if(!outgoing.has(e.source))outgoing.set(e.source,[]);incoming.get(e.target).push(e);outgoing.get(e.source).push(e);}
$('provenance').textContent=graph.metadata.node_count+' nodes · '+graph.metadata.edge_count+' edges · source '+graph.metadata.source_commit;
for(const [name,id] of [['node_types','type'],['edge_types','edge']])for(const value of graph.metadata[name]){const o=document.createElement('option');o.value=value;o.textContent=value;$(id).append(o);}
function el(tag,attrs={}){const n=document.createElementNS(ns,tag);for(const [k,v]of Object.entries(attrs))n.setAttribute(k,String(v));return n;}
function choose(id){selected=id;draw();}
function results(){const q=$('search').value.toLowerCase(),type=$('type').value;const all=graph.nodes.filter(n=>(!type||n.type===type)&&(!q||(n.label+' '+n.source.path+' '+n.source.symbol).toLowerCase().includes(q)));const shown=all.slice(0,180);$('list').replaceChildren();for(const n of shown){const b=document.createElement('button');b.textContent=n.type+' · '+n.label;b.onclick=()=>choose(n.id);$('list').append(b);}$('status').textContent=all.length+' matches; '+shown.length+' listed. Narrow search for more. Graph is a one-hop neighborhood, capped at 60 visible nodes.';if(!selected&&shown.length)choose(shown.find(n=>n.type==='Feature')?.id||shown[0].id);}
function draw(){if(!selected)return;const center=byId.get(selected),dir=$('direction').value,kind=$('edge').value;const es=[...(dir!=='downstream'?(incoming.get(selected)||[]):[]),...(dir!=='upstream'?(outgoing.get(selected)||[]):[])].filter(e=>!kind||e.type===kind);const ids=[...new Set(es.map(e=>e.source===selected?e.target:e.source))].slice(0,59);const visible=new Set([selected,...ids]);const svg=$('svg');svg.replaceChildren();const height=Math.max(520,Math.ceil(ids.length/2)*52+60);svg.setAttribute('viewBox','0 0 1150 '+height);svg.setAttribute('width','1150');svg.setAttribute('height',String(height));const positions=new Map([[selected,[455,height/2]]]);ids.forEach((id,i)=>positions.set(id,[i%2?815:35,35+Math.floor(i/2)*52]));
for(const e of es){if(!visible.has(e.source)||!visible.has(e.target))continue;const a=positions.get(e.source),b=positions.get(e.target);const l=el('line',{x1:a[0]+135,y1:a[1]+15,x2:b[0]+135,y2:b[1]+15});const title=el('title');title.textContent=e.type+' · '+e.evidence.path+':'+e.evidence.line;l.append(title);svg.append(l);}
for(const id of visible){const n=byId.get(id),p=positions.get(id),g=el('g',{transform:'translate('+p[0]+','+p[1]+')',class:id===selected?'selected':'',tabindex:0,role:'button','aria-label':n.type+': '+n.label});g.append(el('rect',{width:285,height:34,rx:6}));const t=el('text',{x:8,y:22});t.textContent=(n.type+': '+n.label).slice(0,43);g.append(t);const title=el('title');title.textContent=n.label+'\n'+n.source.path+':'+n.source.line;g.append(title);g.onclick=()=>choose(id);g.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();choose(id);}};svg.append(g);}
$('heading').textContent=center.type+' · '+center.label;const source=center.source;const details=$('details');details.replaceChildren();const p=document.createElement('p');p.textContent='Status: '+center.status+'\nSymbol: '+source.symbol+'\n'+(center.limitations||'Source declaration only; see evidence basis on each relationship.');details.append(p);const a=document.createElement('a');a.textContent=source.path+':'+source.line;a.href='../../../../../'+source.path+'#L'+source.line;details.append(a);const count=document.createElement('p');count.textContent=es.length+' relationships; '+ids.length+' neighbor nodes shown. Filter relationship or choose a neighbor for the next hop.';details.append(count);$('neighbors').replaceChildren();for(const e of es.slice(0,200)){const other=byId.get(e.source===selected?e.target:e.source);const b=document.createElement('button');b.textContent=(e.target===selected?'← ':'→ ')+e.type+' · '+other.label+'\n'+e.evidence.path+':'+e.evidence.line+' · '+e.evidence.basis;b.onclick=()=>choose(other.id);$('neighbors').append(b);}}
$('search').oninput=results;$('type').onchange=results;$('direction').onchange=draw;$('edge').onchange=draw;$('reset').onclick=()=>{$('search').value='';$('type').value='';$('edge').value='';$('direction').value='both';selected=null;results();};$('download').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(graph,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='mega-xoxo-architecture.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};results();
</script></html>`;
write('architecture/graph-viewer/index.html',viewer.replace('__PAYLOAD__',payload));
console.log(JSON.stringify({...metadata,mobile_screen_count:mobileRows.length,interactions:Object.fromEntries(['web','android','ios'].map(p=>[p,interactionRows(p).length])),feature_status_counts:counts,outputs:ALLOWED.size},null,2));
