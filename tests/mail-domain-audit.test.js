'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {audit}=require('../scripts/mail-domain-audit');

function resolver(records){
 return {
  async resolveTxt(name){if(!(name in records.txt)){const e=Error('missing');e.code='ENODATA';throw e;}return records.txt[name].map(x=>[x]);},
  async resolveMx(name){if(!(name in records.mx)){const e=Error('missing');e.code='ENODATA';throw e;}return records.mx[name].map((exchange,i)=>({exchange,priority:i+1}));},
  async resolveCname(name){return records.cname?.[name]||[];}
 };
}
const domain='antimatterinnovations.com',returnPath='send.'+domain,google='google._domainkey.'+domain,resend='resend._domainkey.'+domain;
function healthy(){
 return resolver({txt:{
  [domain]:['v=spf1 include:_spf.google.com ~all'],
  [returnPath]:['v=spf1 include:amazonses.com ~all'],
  ['_dmarc.'+domain]:['v=DMARC1; p=quarantine; pct=100; rua=mailto:dmarc@antimatterinnovations.com; adkim=r; aspf=r'],
  [google]:['v=DKIM1; k=rsa; p='+'A'.repeat(120)],
  [resend]:['p='+'B'.repeat(120)]
 },mx:{[domain]:['aspmx.l.google.com'],[returnPath]:['feedback-smtp.us-east-1.amazonses.com']}});
}
test('mail domain audit proves Workspace and Resend authentication posture without exposing keys',async()=>{
 const out=await audit({resolver:healthy(),domain,returnPath,dkimHosts:[google,resend],minDmarcPolicy:'quarantine'});
 assert.equal(out.ok,true);assert.deepEqual(out.failures,[]);assert.equal(out.observed.dkim.length,2);
 assert.equal(JSON.stringify(out).includes('A'.repeat(40)),false);assert.equal(JSON.stringify(out).includes('B'.repeat(40)),false);
});
test('mail domain audit fails closed on duplicate SPF or missing DMARC/DKIM',async()=>{
 const r=healthy();r.resolveTxt=async name=>{
  if(name===domain)return [['v=spf1 include:_spf.google.com ~all'],['v=spf1 -all']];
  if(name==='_dmarc.'+domain){const e=Error('missing');e.code='ENODATA';throw e;}
  if(name===resend){const e=Error('missing');e.code='ENODATA';throw e;}
  return healthy().resolveTxt(name);
 };
 const out=await audit({resolver:r,domain,returnPath,dkimHosts:[google,resend],minDmarcPolicy:'quarantine'});
 assert.equal(out.ok,false);for(const failure of ['apexSpfUnique','dkimPublished','dmarcUnique','dmarcPolicy'])assert(out.failures.includes(failure),failure);
});
