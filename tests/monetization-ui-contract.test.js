'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../src/monetization-ui.js'),'utf8');
const automatic=source.slice(source.indexOf('async function automatic('),source.indexOf("window.addEventListener('mega:local-save'"));
const storeRouting=source.slice(source.indexOf('const WEBSITE_STORE_URL'),source.indexOf('const request='))+
 '\nwindow.__storeRouting={directApkDistribution,storePurchaseAction};';
function setup(){let resolve;const c={busy:false,adGeneration:0,M:{interstitialAllowed:()=>true,noteFullScreen:()=>{}},adContext:()=>({}),adPlatform:()=> 'android',who:()=> 'alice',request:()=>new Promise(r=>resolve=r),progress:{},persist:()=>{},Date,shown:0};c.window={MegaAds:{showInterstitial:async()=>{c.shown++;}}};vm.createContext(c);vm.runInContext(automatic,c);return {c,resolve:v=>resolve(v)};}
test('cancelled late ad permit cannot unlock another pending purchase operation',async()=>{const {c,resolve}=setup(),p=c.automatic(0);c.busy=true;c.adGeneration=1;resolve({allowed:true});await p;assert.equal(c.shown,0);assert.equal(c.busy,true);});
test('automatic presentation releases only its own busy lock',async()=>{const {c,resolve}=setup(),p=c.automatic(0);resolve({allowed:true});await p;assert.equal(c.shown,1);assert.equal(c.busy,false);});
test('only an explicit direct APK gets a fixed website-store link without account data',()=>{
 const make=distribution=>{const c={window:{MegaNativeStore:distribution===undefined?undefined:{distribution}},esc:value=>String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]))};vm.createContext(c);vm.runInContext(storeRouting,c);return c.window.__storeRouting;};
 const fallback='<button data-monetization="review">Native purchase</button>',direct=make('direct-apk');
 assert.equal(direct.directApkDistribution(),true);
 const link=direct.storePurchaseAction(fallback);
 assert.match(link,/^<a\b/);
 const href=link.match(/href="([^"]+)"/)[1],url=new URL(href);
 assert.equal(url.origin,'https://megaxo.online');assert.equal(url.pathname,'/store');
 assert.equal(url.search,'');assert.equal(url.hash,'');
 assert.match(link,/referrerpolicy="no-referrer"/);
 assert.equal(make(undefined).storePurchaseAction(fallback),fallback);
 assert.equal(make('google-play').storePurchaseAction(fallback),fallback);
 assert.equal(make('ios').storePurchaseAction(fallback),fallback);
 assert.equal(make('unknown').storePurchaseAction(fallback),fallback);
});
