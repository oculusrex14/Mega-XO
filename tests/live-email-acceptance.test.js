'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {mask,strongPassword}=require('../scripts/live-email-acceptance');

test('live email acceptance masks mailbox and generates policy-compliant temporary passwords',()=>{
 assert.equal(mask('player@example.com'),'p***@example.com');
 for(let i=0;i<20;i++){
  const password=strongPassword();
  assert.ok(password.length>=10);
  assert.match(password,/[A-Za-z]/);
  assert.match(password,/[0-9]/);
 }
});
test('live email acceptance never prints generated passwords or OTPs by design',()=>{
 const source=fs.readFileSync(path.join(__dirname,'..','scripts','live-email-acceptance.js'),'utf8');
 assert.ok(source.includes("code=''"));
 assert.ok(source.includes('setRawMode(true)'));
 assert.ok(source.includes("process.stdout.write('*')"));
 assert.equal(source.includes('console.log(first)'),false);
 assert.equal(source.includes('console.log(second)'),false);
 assert.equal(source.includes('console.log(code)'),false);
 assert.ok(source.includes('old password rejected'));
 assert.ok(source.includes('same profile restored'));
});
