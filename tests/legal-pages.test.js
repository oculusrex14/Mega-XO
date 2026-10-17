'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {buildService}=require('../server/community-server');

async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-legal-')),file=path.join(dir,'db.sqlite');
 const service=buildService({file,origin:'http://127.0.0.1',allowLocalHttp:true,storeOptions:{otpSecret:'a'.repeat(64)}});
 await new Promise((resolve,reject)=>{service.server.once('error',reject);service.server.listen(0,'127.0.0.1',resolve);});
 t.after(async()=>{await service.close();fs.rmSync(dir,{recursive:true,force:true});});
 return 'http://127.0.0.1:'+service.server.address().port;
}

test('public legal, privacy-choice, support and deletion pages have clean routes',async t=>{
 const base=await fixture(t);
 const cases=[
  ['/privacy','Privacy Policy'],
  ['/privacy-choices','Privacy choices'],
  ['/terms','Terms of Service'],
  ['/support','Support'],
  ['/delete-account','Delete your Mega XOXO account']
 ];
 for(const [route,title] of cases){
  const response=await fetch(base+route),text=await response.text();
  assert.equal(response.status,200,route);assert.match(response.headers.get('content-type')||'',/text\/html/);
  assert(text.includes(title),route+' title');assert(text.includes('Antimatter Innovations'),route+' developer');
  assert.equal(/password_hash|code_hash|MEGA_OTP_SECRET|RESEND_API_KEY/.test(text),false,route+' secret-like content');
 }
});

test('privacy and terms publish owner-approved wording without activating new data uses',()=>{
 const privacy=fs.readFileSync(path.join(__dirname,'..','public','privacy.html'),'utf8');
 const terms=fs.readFileSync(path.join(__dirname,'..','public','terms.html'),'utf8');
 for(const document of [privacy,terms]){
  assert.doesNotMatch(document,/Draft for legal review|Not yet effective|Pending legal approval/);
  assert.match(document,/India-based sole proprietorship/);
  assert.match(document,/mailto:contact@antimatterinnovations\.com/);
 }
 assert.match(privacy,/collecting player gameplay for training is not enabled by this policy/);
 assert.match(terms,/Indian law governs these Terms/);
});

test('settings exposes privacy policy terms privacy choices and support inside the app',()=>{
 const app=fs.readFileSync(path.join(__dirname,'..','src','app.js'),'utf8');
 // B2/APP-002: app surfaces open the canonical public documents, never relative bundle paths.
 const links=fs.readFileSync(path.join(__dirname,'..','src','public-links.js'),'utf8');
 for(const route of ['privacy','privacy-choices','terms','support']){
  assert(links.includes('https://megaxo.online/'+route),route);
  assert(app.includes("publicLink('"+route+"',"),route);
 }
});
