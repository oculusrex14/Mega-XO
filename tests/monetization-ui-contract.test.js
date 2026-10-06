'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../src/monetization-ui.js'),'utf8');
const automatic=source.slice(source.indexOf('async function automatic('),source.indexOf("window.addEventListener('mega:local-save'"));
function setup(){let resolve;const c={busy:false,adGeneration:0,M:{interstitialAllowed:()=>true,noteFullScreen:()=>{}},adContext:()=>({}),who:()=> 'alice',request:()=>new Promise(r=>resolve=r),progress:{},persist:()=>{},Date,shown:0};c.window={MegaAds:{showInterstitial:async()=>{c.shown++;}}};vm.createContext(c);vm.runInContext(automatic,c);return {c,resolve:v=>resolve(v)};}
test('cancelled late ad permit cannot unlock another pending purchase operation',async()=>{const {c,resolve}=setup(),p=c.automatic(0);c.busy=true;c.adGeneration=1;resolve({allowed:true});await p;assert.equal(c.shown,0);assert.equal(c.busy,true);});
test('automatic presentation releases only its own busy lock',async()=>{const {c,resolve}=setup(),p=c.automatic(0);resolve({allowed:true});await p;assert.equal(c.shown,1);assert.equal(c.busy,false);});
