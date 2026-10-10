'use strict';
// One-time preflighted client/data-boundary integration. No deployment or network permission edits.
const fs=require('node:fs'),crypto=require('node:crypto');const files=new Map();
const expected={
 'src/app.js':'a5d9bd9d1ed1a634878b9b4e276c4ac991b060a05a2ba682da35c6add45b2664',
 'src/domain.js':'5c4bf7e41c61ea7db152d1e53ebe2b8f30421fba7261dc03bc9724a02cc7c8a4',
 'index.html':'6b61ca2d68629d253caf4aba20bb46dc6f7a9badaa1cd9d922ce283e6da4e304',
 'native/client/bundle.config.json':'714b71fdcd8fd5adf86be9bea357ef003100604b3e78f1011dd85bbcfc3a6329',
 'scripts/p21/build-web.js':'41ab20a34abd7e0c354e486683e5606047b8275ae2fb33094026331be71dda40',
 'tests/v51-bot-tutorial.test.js':'fb39ca1d797b7af780f6b9794410f608c9b8a192f85aa5a6e81b18afb6bd7e6e'
};
function read(p){if(!files.has(p))files.set(p,fs.readFileSync(p,'utf8'));return files.get(p);}
function patch(p,a,b){const s=read(p);if(!s.includes(a)||s.indexOf(a)!==s.lastIndexOf(a))throw Error('PATCH_CONTEXT_MISMATCH '+p);files.set(p,s.replace(a,b));}
if(read('src/app.js').includes('/* V5.1 optional AI pack setup */')){console.log('Pack setup already integrated.');process.exit(0);}
for(const [p,hash] of Object.entries(expected))if(crypto.createHash('sha256').update(read(p)).digest('hex')!==hash)throw Error('SOURCE_CHANGED_REVIEW_REQUIRED '+p);
patch('src/app.js'," const placed=online.profile?.games>=D.POLICY.placements", " /* V5.1 optional AI pack setup */\n if(mode==='bot'&&window.MegaAiPack)setup+=fullButton('Impossible AI pack: setup','aipack','',true);\n const placed=online.profile?.games>=D.POLICY.placements");
patch('src/app.js','settings,wallet,tutorial,rules,matchstats:',"settings,wallet,tutorial,rules,aipack:()=>window.MegaAiPack?.show(),matchstats:");
patch('src/domain.js'," if(['ranked','casual','friend'].includes(record.mode))throw Error('SERVER_RESULT_REQUIRED');", " if(['ranked','casual','friend'].includes(record.mode))throw Error('SERVER_RESULT_REQUIRED');\n // On-device neural results and explicit Expert recovery stay unverified and unpaid.\n if(record.resultClass==='unverified-local-ai'||record.difficulty==='Impossible')return 0;");
patch('index.html','<link rel="stylesheet" href="src/styles.css">','<link rel="stylesheet" href="src/styles.css">\n<link rel="stylesheet" href="src/bot/pack.css">');
patch('index.html','<script src="src/app.js"></script>','<script src="src/bot/pack.js"></script><script src="src/bot/pack-ui.js"></script><script src="src/app.js"></script>');
const p='native/client/bundle.config.json',config=JSON.parse(read(p));config.client_scripts.splice(config.client_scripts.indexOf('src/app.js'),0,'src/bot/pack.js','src/bot/pack-ui.js');config.client_styles.push('src/bot/pack.css');files.set(p,JSON.stringify(config,null,2)+'\n');
patch('scripts/p21/build-web.js','const GAME_FILES = [',"const GAME_FILES = ['bot/pack.js', 'bot/pack-ui.js', 'bot/pack.css', ");
files.set('tests/v51-bot-tutorial.test.js',read('tests/v51-bot-tutorial.test.js')+"require('./bot/local-ai.test.cjs');\n");
for(const [p,s] of files)fs.writeFileSync(p,s);
console.log('Integrated '+[...files.keys()].join(', '));
