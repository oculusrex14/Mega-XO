'use strict';
// Reviewed one-time source patch, only for the isolated feature branch.
const fs=require('node:fs'),crypto=require('node:crypto'),files=new Map();
function read(p){if(!files.has(p))files.set(p,fs.readFileSync(p,'utf8'));return files.get(p);}
function patch(p,a,b){const s=read(p);if(!s.includes(a)||s.indexOf(a)!==s.lastIndexOf(a))throw Error('PATCH_CONTEXT_MISMATCH '+p+' '+a.slice(0,50));files.set(p,s.replace(a,b));}
if(read('src/app.js').includes('/* V5.1 worker bot hooks */')){console.log('Worker hooks already integrated.');process.exit(0);}
const expected={'src/app.js':'3db009034cab1a60f60f8fc75c212031aeee18f6bb2d1ed163e11c1270b34b46','index.html':'131d5aa405b1a2f83824af6395d8f54b65352bc662c374d29d750a286287e31d','native/client/bundle.config.json':'bdf6fd13e12eb2706bb4e0272a880a1f111b04ba11abdf00362853811f4cb66e','scripts/p21/build-web.js':'ae08404167894df66b69706c0ceb27d134cd2fb193b51255f7022cf047e22f36','src/tutorial/client.js':'be34bb8d634fe6b3a1e797d4aef80ccf1682e5af33b5a2471d2fb42c01db1a6b'};
for(const [p,hash] of Object.entries(expected))if(crypto.createHash('sha256').update(read(p)).digest('hex')!==hash)throw Error('SOURCE_CHANGED_REVIEW_REQUIRED '+p);
patch('src/app.js','const T=window.MegaTutorial;','const T=window.MegaTutorial;\n/* V5.1 worker bot hooks */\nconst BR=window.MegaBotRuntime,BC=window.MegaBotContract,A=BR?new BR.Client():null;');
patch('src/app.js','tutorial:T?.snapshot(match)||null,moves:match.state.moves','tutorial:T?.snapshot(match)||null,bot:match.bot||null,moves:match.state.moves');
if(read('src/app.js').split('T?.stop();').length!==5)throw Error('LIFECYCLE_CONTEXT_CHANGED');files.set('src/app.js',read('src/app.js').replaceAll('T?.stop();','T?.stop();A?.cancel();'));
patch('src/app.js','function open(title,html,kind=\'info\'){','function open(title,html,kind=\'info\'){\n A?.cancel();');
patch('src/app.js','if(document.hidden){clearTimeout(botTimer);','if(document.hidden){A?.cancel();clearTimeout(botTimer);');
patch('src/app.js','if(practice)T?.start(match);','if(BR)match.bot=BR.startInfo(null,practice);if(practice)T?.start(match);');
patch('src/app.js','match.id=old.id;match.state=state;','match.id=old.id;match.state=state;match.bot=BR?.startInfo(old.bot,old.practice===true)||null;');
patch('src/app.js',"T?.bind({getMatch:()=>match,notify,save,paint,scheduleBot,", "T?.bind({getMatch:()=>match,notify,save,paint,scheduleBot,cancelBot:()=>A?.cancel(),");
patch('src/tutorial/client.js',"if(action==='restart'){confirmRestart=true;", "if(action==='restart'){host.cancelBot?.();confirmRestart=true;");
patch('src/app.js','getTutorial:()=>T?.snapshot(match)||null','getTutorial:()=>T?.snapshot(match)||null,getBotInfo:()=>match?.bot?({...match.bot}):null,getBotDiagnostics:()=>match?.botDiagnostics?structuredClone(match.botDiagnostics):null');
patch('src/app.js',`function scheduleBot(){clearTimeout(botTimer);botTimer=null;if(!match||match.state.winner||match.mode!=='bot'||match.state.turn!=='O'||sheetOpen()||document.hidden||T?.blocked(match))return;const current=match,revision=match.state.moves.length;
 botTimer=setTimeout(()=>{botTimer=null;if(match!==current||match.state.moves.length!==revision||sheetOpen()||document.hidden)return;const m=G.choose(match.state,match.difficulty);if(m)move(m,'bot');},850+Math.random()*220);
}`,`function scheduleBot(){clearTimeout(botTimer);botTimer=null;A?.cancel();if(!match||match.state.winner||match.mode!=='bot'||match.state.turn!=='O'||sheetOpen()||document.hidden||T?.blocked(match))return;const current=match,revision=match.state.moves.length;
 const valid=()=>match===current&&match.state.moves.length===revision&&!match.state.winner&&!sheetOpen()&&!document.hidden&&!T?.blocked(match);
 botTimer=setTimeout(async()=>{botTimer=null;if(!valid())return;const seed=((current.bot?.seed||0)^Math.imul(revision+1,0x9e3779b9))>>>0;let m=null;
  try{if(!A)throw Error('BOT_WORKER_UNAVAILABLE');const result=await A.choose({state:current.state,gameId:current.id,revision,difficulty:current.difficulty,engine:current.bot?.engine||'legacy',seed});if(!valid())return;current.botDiagnostics=result.diagnostics;m=result.move;}
  catch(e){if(e?.name==='AbortError'||!valid())return;const started=performance.now();m=G.choose(current.state,current.difficulty,BC?BC.seeded(seed):Math.random);current.botDiagnostics={engineVersion:'canonical-main-thread-recovery',rngSeed:seed,recoveryCode:e?.code||'BOT_WORKER_UNAVAILABLE',elapsedMs:performance.now()-started};if(!current.warnedBotFallback){notify('Background thinking is unavailable. Using the standard bot.');current.warnedBotFallback=true;}}
  if(valid()&&m)move(m,'bot');
 },850+Math.random()*220);
}`);
patch('index.html','<script src="src/app.js"></script>','<script src="src/bot/contracts.js"></script><script src="src/bot/runtime.js"></script><script src="src/app.js"></script>');
const p='native/client/bundle.config.json',config=JSON.parse(read(p));config.client_scripts.splice(config.client_scripts.indexOf('src/app.js'),0,'src/bot/contracts.js','src/bot/runtime.js','src/bot/worker.js','src/bot/board.js','src/bot/search.js');files.set(p,JSON.stringify(config,null,2)+'\n');
patch('scripts/p21/build-web.js','const GAME_FILES = [',"const GAME_FILES = ['bot/contracts.js', 'bot/runtime.js', 'bot/worker.js', 'bot/board.js', 'bot/search.js', ");
for(const [p,s] of files)fs.writeFileSync(p,s);console.log('Integrated worker hooks: '+[...files.keys()].join(', '));
