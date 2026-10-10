'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const read=name=>fs.readFileSync(path.join(root,name));
const source=name=>read(name).toString('utf8');
const themes=['vector','midnight','paperclub','afterhours'];

test('Mega XOXO browser and native display names',()=>{
 const html=source('index.html');
 assert.match(html,/<title>Mega XOXO<\/title>/);
 assert.match(html,/MEGA XOXO<\/b>/);
 assert.doesNotMatch(html,/\bMega XO\b|\bMEGA XO\b/);
 assert.match(source('native/android/app/src/main/res/values/strings.xml'),/Mega XOXO/);
 assert.match(source('native/ios/MegaXO/Info.plist'),/Mega XOXO/);
 assert.match(source('src/community.js'),/Welcome to Mega XOXO/);
});

test('all themed logo PNG originals and optimized WebP files exist',()=>{
 for(const theme of themes)for(const suffix of ['.png','-app.webp','-mark.webp']){
   const b=read('assets/p21/logos/mega-xoxo-'+theme+suffix);
   assert.ok(b.length>1000&&b.length<3000000,theme+suffix+' size budget');
   if(suffix==='.png')assert.equal(b.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
   else {assert.equal(b.subarray(0,4).toString('ascii'),'RIFF');assert.equal(b.subarray(8,12).toString('ascii'),'WEBP');}
 }
});

test('theme-matched header mark is in V5 native bundle allowlist',()=>{
 const app=source('src/app.js');
 assert.match(app,/function updateBrandMark\(/);
 assert.match(app,/updateBrandMark\(\);/);
 const config=JSON.parse(source('native/client/bundle.config.json'));
 assert.ok(config.allowed_source_prefixes.includes('assets/p21/logos/'));
 assert.equal(config.client_assets.length,8);
 for(const theme of themes)for(const suffix of ['-app.webp','-mark.webp']){
  const f='assets/p21/logos/mega-xoxo-'+theme+suffix;
  assert.ok(config.client_assets.some(x=>x.source===f&&x.destination===f),f);
 }
 assert.match(source('scripts/v5/build-client.js'),/for \(const asset of config\.client_assets \|\| \[\]\) add\('client-asset'/);
});

test('original uploaded logo remains byte-identical in repo',()=>{
 const sha=crypto.createHash('sha256').update(read('assets/p21/reference/brand-owner-original.png')).digest('hex');
 assert.equal(sha,'af0eec08b3f554830e5a0fc95d470b20b4c8a15e3e526c99d0f07684c56cf34a');
});
