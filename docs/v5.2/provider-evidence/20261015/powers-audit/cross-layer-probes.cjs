'use strict';
// Local synthetic probes of the checked-out modules. No provider, network, device or account use.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../../../../..');
const G = require(path.join(ROOT, 'src/game.js'));
const R = require(path.join(ROOT, 'src/gameplay-rewind.js'));
const P = require(path.join(ROOT, 'src/powers-ui.js'));
const WEB = { Date, Object, JSON, Number, String };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'apps/web/powers.js'), 'utf8'), WEB);
const now = Date.parse('2026-10-15T12:00:00Z');
const moves = [[5,7],[7,0],[0,0],[0,1],[1,7],[7,1],[1,8],[8,0]];
let board = G.create();
for (const [b,c] of moves) board = G.apply(board, {b,c});
function match() {
 return { id:'synthetic-match', state:board, mode:'bot', first:'X', practice:false,
  online:false, revision:8, charges:0, used:0, powers:R.freshMatchPowers(), botPending:false };
}
function ui(adapter) {
 return WEB.MegaWebPowers.createController({
  getAdapter:()=>adapter,
  getMatchSummary:()=>({ mode:'bot', difficulty:'Expert', revision:8, status:'PLAYING' }),
  getBinding:()=>({ actorId:'synthetic-actor', matchId:'synthetic-match', revision:8 }),
  getContext:()=>match(), verifyContext:()=>true, now:()=>now
 });
}
const observations = [];
function note(id, observed) { observations.push({id, observed}); }
(async()=>{
 const actual = P.createPowers({ enabled:()=>true, clock:()=>now, live:()=>match() });
 assert.equal(actual.inventory().undo.reserved, null);
 assert.equal(ui(actual).view().reason, 'invalid-inventory');
 note('WEB_ACTUAL_ADAPTER_CONTRACT', { reserved:actual.inventory().undo.reserved,
  websiteReason:ui(actual).view().reason });

 const earned = P.createPowers({ enabled:()=>true, clock:()=>now, live:()=>match(),
  bridge:{ ready:()=>true, consent:()=>true, present:async()=>({outcome:'earned'}) } });
 // Normalize only the incompatible reservation display shape to reach the next boundary.
 const normalized = {...earned, inventory:()=>Object.fromEntries(Object.entries(earned.inventory())
  .map(([k,v])=>[k,k==='version'?v:{...v,reserved:v.reserved?1:0}]))};
 const controller = ui(normalized);
 assert.equal(controller.view().canRequestUndo, true);
 const response = await controller.request();
 assert.equal(response.reason, 'INVALID_RESULT');
 assert.equal(earned.inventory().undo.available, 1);
 note('WEB_SUCCESS_REASON_CONTRACT', { websiteResult:response, actualBank:earned.inventory().undo.available });

 let unearnedLive = match(), grants=0;
 const unearned = P.createPowers({ enabled:()=>true, clock:()=>now, live:()=>unearnedLive,
  commit:cmd=>{ if(cmd.type==='grant')grants++; unearnedLive={...unearnedLive,
   powers:cmd.powers, ...(cmd.type==='rewind'?{state:cmd.state,revision:cmd.revision}:{} )}; return true; } });
 assert.equal(unearned.inventory().undo.available, 0);
 const freeApply = unearned.apply('undo', unearnedLive);
 assert.equal(freeApply.applied, true);
 note('UNEARNED_APPLY', { ...freeApply, grants, bank:unearned.inventory().undo.available,
  remainingCharges:unearnedLive.powers.botUndo.charges });

 let saved=null, live=match();
 const options = { enabled:()=>true, clock:()=>now, live:()=>live,
  storage:{read:()=>saved,write:s=>{saved=JSON.parse(JSON.stringify(s));}},
  bridge:{ready:()=>true,consent:()=>true,present:async()=>({outcome:'earned'})},
  commit:cmd=>{live={...live,powers:cmd.powers,...(cmd.type==='rewind'?{state:cmd.state,revision:cmd.revision}:{} )};return true;} };
 const banked = P.createPowers(options);
 const reward = await banked.request('undo', live);
 assert.equal(reward.earned, true);
 const applied = banked.apply('undo', live);
 assert.equal(applied.applied, true);
 assert.equal(banked.inventory().undo.available, 0);
 assert.equal(saved.inventory.available.undo, 1);
 const reloaded = P.createPowers(options);
 assert.equal(reloaded.inventory().undo.available, 1);
 assert.equal(reloaded.pacing().nextEligibleAt, 9999);
 note('BANK_CONSUMPTION_NOT_PERSISTED', { inMemory:banked.inventory().undo.available,
  persisted:saved.inventory.available.undo, afterReload:reloaded.inventory().undo.available });
 note('RELOAD_COOLDOWN_TRUNCATED', { before:banked.pacing().nextEligibleAt,
  after:reloaded.pacing().nextEligibleAt, now });

 const appSource=fs.readFileSync(path.join(ROOT,'src/app.js'),'utf8');
 const hookBody=appSource.match(/issueTicket:info=>\{([\s\S]*?)\n  \}\n \}\);/)[1];
 const fullTicket={ ticket:'synthetic-ticket', actor:'synthetic-actor', platform:'android',
  adUnit:'synthetic-unit', rewardItem:'solo_rewind', rewardAmount:1, expires:now+300000 };
 const appTicket=await new Function('window','info',hookBody)(
  {MegaAccount:{request:async()=>fullTicket}},{kind:'undo',platform:'android'});
 assert.equal(typeof appTicket,'string');
 note('APP_TICKET_ENVELOPE_DROPPED',{payloadType:typeof appTicket, nativeRequires:'full ticket object'});

 const requested=R.hintRequest(R.freshMatchPowers(),'X');
 const arbitrary=R.hintReveal(requested.powers,{square:{b:99,c:99}});
 assert.equal(arbitrary.ok,true);
 note('TACTICAL_MODULE_IS_COUNTERS_ONLY',{acceptsArbitrarySquare:arbitrary.ok,
  casualHintAllowed:R.powersAllowed({mode:'casual'},'hint')});

 console.log(JSON.stringify({ sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim(),
  environment:{node:process.version,platform:process.platform,arch:process.arch},
  target:'local synthetic module composition; no providers/devices; observations are gaps, not acceptance passes',
  observations},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
