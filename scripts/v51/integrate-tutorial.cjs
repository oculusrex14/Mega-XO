'use strict';
// One-time reviewed source integration, not a runtime/build dependency.
// Refuses any ambiguous patch; re-running after integration is a no-op.
const fs=require('node:fs'),crypto=require('node:crypto');
const files=new Map();
function read(p){if(!files.has(p))files.set(p,fs.readFileSync(p,'utf8'));return files.get(p);}
function patch(p,before,after){const s=read(p);if(!s.includes(before)||s.indexOf(before)!==s.lastIndexOf(before))throw Error('PATCH_CONTEXT_MISMATCH: '+p+' '+before.slice(0,70));files.set(p,s.replace(before,after));}
if(read('src/app.js').includes('/* V5.1 guided-practice hooks */')){console.log('Tutorial hooks already integrated.');process.exit(0);}
// Ensure concurrent P21 changes are never silently replaced.
const expected={'src/app.js':'79d8f07e4843a593d425eae9bdbe948a73676e3b18cdb74b37956d06ec2b09cb','index.html':'d4476ff7564f112a8daed91226eb272080f76421072ae7fe4b65c10df483d289','native/client/bundle.config.json':'4193a049e80fa390f343f6fd7acec827ee38e57f9df8833880a9b5acea36caa5','scripts/p21/build-web.js':'d1334ddb4e2640503e916efff86564d697822c5283d53ee135631f73b7daec7b'};
for(const [p,hash] of Object.entries(expected))if(crypto.createHash('sha256').update(read(p)).digest('hex')!==hash)throw Error('SOURCE_CHANGED_REVIEW_REQUIRED: '+p);
patch('src/app.js',"const G=window.MegaGame,D=", "/* V5.1 guided-practice hooks */\nconst T=window.MegaTutorial;\nconst G=window.MegaGame,D=");
patch('src/app.js','practice:match.practice,moves:match.state.moves','practice:match.practice,tutorial:T?.snapshot(match)||null,moves:match.state.moves');
patch('src/app.js','function beginOnline(m){','function beginOnline(m){\n T?.stop();');
patch('src/app.js','function startGame(practice=false,rematch=false){','function startGame(practice=false,rematch=false){\n T?.stop();');
patch('src/app.js'," $('#gameScreen').hidden=false;$('#matchMode').textContent=practice?", " if(practice)T?.start(match);\n $('#gameScreen').hidden=false;$('#matchMode').textContent=practice?");
patch('src/app.js','}\nfunction clearPreview(){',' T?.render(match);\n}\nfunction clearPreview(){');
patch('src/app.js',"return;lastInput=performance.now();if(data.settings.confirm", "return;if(T&&!T.allows(match,{b,c})){T.hint();return;}lastInput=performance.now();if(data.settings.confirm");
patch('src/app.js',' try{match.state=G.apply(match.state,m);}'," if(T&&!T.permits(match,m,source))return;const before=match.state;\n try{match.state=G.apply(match.state,m);}");
patch('src/app.js',' match.last=m;match.pending=null;', ' T?.after(match,before,m);match.last=m;match.pending=null;');
patch('src/app.js',"match.state.turn!=='O'||sheetOpen()||document.hidden)return;const current", "match.state.turn!=='O'||sheetOpen()||document.hidden||T?.blocked(match))return;const current");
patch('src/app.js','||sheetOpen()||document.hidden)return;if(now-lastInput', '||sheetOpen()||document.hidden||T?.blocked(match))return;if(now-lastInput');
patch('src/app.js',"const starter=rematch&&match?(match.first==='X'?'O':'X'):practice?'X':first;","const starter=practice?'X':rematch&&match?(match.first==='X'?'O':'X'):first;");
patch('src/app.js','lastTick=lastInput=performance.now();paint();syncAudio();scheduleBot();','lastTick=lastInput=performance.now();paint();syncAudio();save();scheduleBot();');
patch('src/app.js','function finish(reason){if(!match||match.recorded)return;', 'function finish(reason){if(!match||match.recorded)return;T?.stop();');
patch('src/app.js','function leave(){clearInterval(onlinePoll);','function leave(){T?.stop();clearInterval(onlinePoll);');
patch('src/app.js','function tutorial(){', `function tutorial(){
 if(match&&!match.state.winner){rules();return;}
 open('How to play','<p>Learn by playing. Claim three Mini Boards in a line to win the Mega Board.</p>'+fullButton('Start guided practice','practice')+fullButton('Read the rules','rules','',true)+'<p class="caption">No coins or personal stats. Skip guidance at any time.</p>','tutorial');
}
function rules(){`);
patch('src/app.js',"settings,wallet,tutorial,matchstats:","settings,wallet,tutorial,rules,matchstats:");
patch('src/app.js','Practice vs Beginner Bot','Start guided practice');
patch('src/app.js','Replay the four-step tutorial','Learn by playing, or read the rules');
patch('src/app.js','restartyes:()=>{close();startGame();}', 'restartyes:()=>{close();startGame(match?.practice||false);}');
patch('src/app.js','refreshIcons();applyTheme();buildBoard();render();save();',`T?.bind({getMatch:()=>match,notify,save,paint,scheduleBot,commitBot:m=>move(m,'bot'),restart:()=>{close();startGame(true);}});
refreshIcons();applyTheme();buildBoard();render();save();`);
patch('src/app.js','Number(old.turnRemaining)||0));paint();save();scheduleBot();', 'Number(old.turnRemaining)||0));if(old.practice)T?.restore(match,old.tutorial);paint();save();scheduleBot();');
patch('src/app.js',"getSettings:()=>({...data.settings})", "getSettings:()=>({...data.settings}),getTutorial:()=>T?.snapshot(match)||null");
patch('index.html','<link rel="stylesheet" href="src/styles.css">','<link rel="stylesheet" href="src/styles.css">\n<link rel="stylesheet" href="src/tutorial/tutorial.css">');
patch('index.html','<script src="src/app.js"></script>','<script src="src/tutorial/lesson.js"></script><script src="src/tutorial/client.js"></script><script src="src/app.js"></script>');
const p='native/client/bundle.config.json',config=JSON.parse(read(p));config.client_scripts.splice(config.client_scripts.indexOf('src/app.js'),0,'src/tutorial/lesson.js','src/tutorial/client.js');config.client_styles.push('src/tutorial/tutorial.css');files.set(p,JSON.stringify(config,null,2)+'\n');
patch('scripts/p21/build-web.js',"const GAME_FILES = [", "const GAME_FILES = ['tutorial/lesson.js', 'tutorial/client.js', 'tutorial/tutorial.css', ");
// Only commit writes after every input and patch has passed preflight.
for(const [p,s] of files)fs.writeFileSync(p,s);
console.log('Integrated: '+[...files.keys()].join(', '));
