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
  ['/delete-account','Delete your Mega XO account']
 ];
 for(const [route,title] of cases){
  const response=await fetch(base+route),text=await response.text();
  assert.equal(response.status,200,route);assert.match(response.headers.get('content-type')||'',/text\/html/);
  assert(text.includes(title),route+' title');assert(text.includes('Antimatter Innovations'),route+' developer');
  assert.equal(/password_hash|code_hash|MEGA_OTP_SECRET|RESEND_API_KEY/.test(text),false,route+' secret-like content');
 }
});

test('privacy and terms remain explicitly draft-gated before legal approval',()=>{
 const privacy=fs.readFileSync(path.join(__dirname,'..','public','privacy.html'),'utf8');
 const terms=fs.readFileSync(path.join(__dirname,'..','public','terms.html'),'utf8');
 assert.match(privacy,/Draft for legal review/);assert.match(privacy,/Not yet effective/);
 assert.match(terms,/Draft for legal review/);assert.match(terms,/Governing law.*Pending legal approval/s);
});

test('settings exposes privacy policy terms privacy choices and support inside the app',()=>{
 const app=fs.readFileSync(path.join(__dirname,'..','src','app.js'),'utf8');
 for(const route of ['/privacy','/privacy-choices','/terms','/support'])assert(app.includes('href="'+route+'"'),route);
});
