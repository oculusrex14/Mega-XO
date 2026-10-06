'use strict';
const dns=require('node:dns').promises;

const domainPattern=/^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const list=value=>String(value||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
const joinTxt=rows=>(rows||[]).map(parts=>Array.isArray(parts)?parts.join(''):String(parts));
async function safe(fn){
 try{return await fn();}
 catch(error){if(['ENODATA','ENOTFOUND','NXDOMAIN','SERVFAIL'].includes(error?.code))return [];throw error;}
}
const spfRecords=rows=>joinTxt(rows).filter(x=>/^v=spf1(?:\s|$)/i.test(x.trim()));
function tags(record,prefix){
 const out={};if(typeof record!=='string'||!record.toLowerCase().startsWith(prefix.toLowerCase()))return out;
 for(const part of record.split(';').slice(1)){const [key,...rest]=part.trim().split('=');if(key&&rest.length)out[key.toLowerCase()]=rest.join('=').trim();}
 return out;
}
const policyRank={none:0,quarantine:1,reject:2};

async function dkimPresence(host,resolver){
 const txt=await safe(()=>resolver.resolveTxt(host));const flat=joinTxt(txt);
 if(flat.some(x=>/(^|;\s*)p=[A-Za-z0-9+/=]{40,}/i.test(x)))return {host,present:true,type:'TXT'};
 const cnames=await safe(()=>resolver.resolveCname(host));
 if(cnames.length)return {host,present:true,type:'CNAME'};
 return {host,present:false,type:'missing'};
}

async function audit(options={}){
 const resolver=options.resolver||dns,domain=String(options.domain||process.env.MEGA_EMAIL_DOMAIN||'antimatterinnovations.com').trim().toLowerCase();
 if(!domainPattern.test(domain))throw Error('INVALID_EMAIL_DOMAIN');
 const returnPath=String(options.returnPath||process.env.MEGA_MAIL_RETURN_PATH_DOMAIN||('send.'+domain)).trim().toLowerCase();
 if(!domainPattern.test(returnPath)||!(returnPath===domain||returnPath.endsWith('.'+domain)))throw Error('INVALID_RETURN_PATH_DOMAIN');
 const dkimHosts=options.dkimHosts||list(process.env.MEGA_MAIL_DKIM_HOSTS);
 const apexIncludes=options.apexSpfIncludes||list(process.env.MEGA_MAIL_APEX_SPF_INCLUDES||'_spf.google.com');
 const returnIncludes=options.returnSpfIncludes||list(process.env.MEGA_MAIL_RETURN_SPF_INCLUDES||'amazonses.com');
 const mxSuffixes=options.mxSuffixes||list(process.env.MEGA_MAIL_MX_SUFFIXES||'google.com');
 const minPolicy=String(options.minDmarcPolicy||process.env.MEGA_DMARC_MIN_POLICY||'none').toLowerCase();
 const requireRua=options.requireRua??((process.env.MEGA_DMARC_REQUIRE_RUA||'true')!=='false');
 if(!(minPolicy in policyRank))throw Error('INVALID_DMARC_MIN_POLICY');

 const [apexTxt,returnTxt,mx,returnMx,dmarcTxt,dkim]=await Promise.all([
  safe(()=>resolver.resolveTxt(domain)),
  safe(()=>resolver.resolveTxt(returnPath)),
  safe(()=>resolver.resolveMx(domain)),
  safe(()=>resolver.resolveMx(returnPath)),
  safe(()=>resolver.resolveTxt('_dmarc.'+domain)),
  Promise.all(dkimHosts.map(host=>dkimPresence(host,resolver)))
 ]);
 const apexSpf=spfRecords(apexTxt),returnSpf=spfRecords(returnTxt),dmarcRecords=joinTxt(dmarcTxt).filter(x=>/^v=DMARC1(?:;|$)/i.test(x.trim()));
 const dmarc=dmarcRecords.length===1?tags(dmarcRecords[0],'v=DMARC1'):{};
 const dmarcPolicy=String(dmarc.p||'').toLowerCase(),pct=dmarc.pct===undefined?100:Number(dmarc.pct);
 const hasInclude=(record,name)=>record.toLowerCase().split(/\s+/).includes('include:'+name.toLowerCase());
 const checks={
  apexSpfUnique:apexSpf.length===1,
  apexSpfIncludes:apexSpf.length===1&&apexIncludes.every(name=>hasInclude(apexSpf[0],name)),
  workspaceMxPresent:mx.length>0&&mx.some(row=>mxSuffixes.some(suffix=>String(row.exchange||'').toLowerCase().endsWith(suffix))),
  returnPathAligned:returnPath===domain||returnPath.endsWith('.'+domain),
  returnPathSpfUnique:returnSpf.length===1,
  returnPathSpfIncludes:returnSpf.length===1&&returnIncludes.every(name=>hasInclude(returnSpf[0],name)),
  returnPathMxPresent:returnMx.length>0,
  dkimHostsConfigured:dkimHosts.length>0,
  dkimPublished:dkimHosts.length>0&&dkim.every(row=>row.present),
  dmarcUnique:dmarcRecords.length===1,
  dmarcPolicy:policyRank[dmarcPolicy]!==undefined&&policyRank[dmarcPolicy]>=policyRank[minPolicy],
  dmarcFullCoverage:Number.isFinite(pct)&&pct===100,
  dmarcAlignment:['','r','s'].includes(String(dmarc.adkim||'').toLowerCase())&&['','r','s'].includes(String(dmarc.aspf||'').toLowerCase()),
  dmarcReporting:!requireRua||typeof dmarc.rua==='string'&&dmarc.rua.length>0
 };
 const failures=Object.entries(checks).filter(([,ok])=>!ok).map(([name])=>name);
 return {
  ok:failures.length===0,
  generatedAt:new Date().toISOString(),
  domain,returnPath,
  requirements:{apexSpfIncludes,returnSpfIncludes,mxSuffixes,minDmarcPolicy:minPolicy,requireRua,dkimHosts},
  observed:{apexSpfCount:apexSpf.length,returnPathSpfCount:returnSpf.length,workspaceMxCount:mx.length,returnPathMxCount:returnMx.length,dkim,dmarcCount:dmarcRecords.length,dmarcPolicy:dmarcPolicy||null,dmarcPct:Number.isFinite(pct)?pct:null,dmarcAdkim:dmarc.adkim||'r',dmarcAspf:dmarc.aspf||'r',dmarcRuaPresent:typeof dmarc.rua==='string'&&dmarc.rua.length>0},
  checks,failures
 };
}

async function main(){
 const result=await audit();process.stdout.write(JSON.stringify(result,null,2)+'\n');if(!result.ok)process.exitCode=2;
}
if(require.main===module)main().catch(error=>{console.error('MAIL_DOMAIN_AUDIT_FAILED: '+error.message);process.exitCode=1;});
module.exports={audit,spfRecords,tags,dkimPresence};
