'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {once} = require('node:events');
const {createPreviewServer} = require('./serve-web.js');
const {ROOT, WEBSITE_ROUTES, MANIFEST} = require('./build-web.js');
// Tool dependencies are kept outside the product payload and its dependencies.
const {chromium} = require('playwright');
const axe = require('axe-core');

async function main() {
 const directory=path.join(ROOT,'.artifacts/p21-web');
 const manifest=JSON.parse(fs.readFileSync(path.join(directory,MANIFEST)));
 const snapshot=fs.mkdtempSync(path.join(ROOT,'.artifacts/.p21-accessibility-qa-'));
 try {
  for(const file of manifest.files) {
   const source=path.resolve(directory,file.path),target=path.resolve(snapshot,file.path);
   if(!source.startsWith(directory+path.sep)||!target.startsWith(snapshot+path.sep))throw new Error('Invalid manifest payload path');
   const bytes=fs.readFileSync(source);
   if(crypto.createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new Error('Build changed during accessibility snapshot capture: '+file.path);
   fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);
  }
  fs.writeFileSync(path.join(snapshot,MANIFEST),JSON.stringify(manifest,null,2)+'\n');
 }catch(error){fs.rmSync(snapshot,{recursive:true,force:true});throw error;}
 const report={case_ids:['P21-A11Y-001','P21-A11Y-SYNTHETIC-LINKED','P21-A11Y-GAME-THEMES','P21-A11Y-PRERENDERED-ISOLATION','P21-A11Y-PRERENDERED','P21-A11Y-PAPER-HUD-01','P21-A11Y-FORCED-COLORS-01'],checked_at:new Date().toISOString(),runtime_version:process.version,source_commit:manifest.source_commit,bundle_sha256:manifest.bundle_sha256,command:`env -u NODE_OPTIONS ${process.execPath} scripts/p21/accessibility-qa.cjs`,environment:'Local loopback Chromium; guest or synthetic linked fixture; prerender audit blocks all site scripts and allows axe tooling only; read proxy explicitly disabled; no authenticated/provider traffic',isolated_payload_snapshot:true,tool_version:axe.version,checks:[],manual_review:[]};
 report.qa_script_sha256=crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
 const server=createPreviewServer({directory:snapshot,readApiOrigin:null});server.listen(0,'127.0.0.1');await once(server,'listening');
 const origin=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch();report.browser=browser.version();
 const localOnly=async page=>page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort('blockedbyclient'));
 try {
  for(const width of [1672,390]) {
   const page=await browser.newPage({viewport:{width,height:941}});
   await localOnly(page);
   for(const route of [...WEBSITE_ROUTES,'/play?mode=practice']) {
    await page.goto(`http://127.0.0.1:${server.address().port}${route}`,{waitUntil:'networkidle'});await page.locator('#main').waitFor();await page.evaluate(()=>document.fonts.ready);await page.evaluate(axe.source);
    const result=await page.evaluate(async()=>{
     const data=await axe.run({runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa','best-practice']}});
     const compact=entry=>({id:entry.id,impact:entry.impact,nodes:entry.nodes.map(node=>({target:node.target,failure_summary:node.failureSummary}))});
     return {violations:data.violations.map(compact),incomplete:data.incomplete.map(compact)};
    });
    report.checks.push({route,width,result:result.violations.length?'FAIL':'PASS',violations:result.violations});
    if(result.incomplete.length)report.manual_review.push({route,width,items:result.incomplete});
   }
   await page.goto(origin+'/game',{waitUntil:'networkidle'});
   await page.locator('[data-gb-setting="mode"],[data-game-mode]').selectOption('local');
   await page.locator('[data-gb-cell="0:4"]').click();
   for(const theme of ['cinematic','vector','midnight','paperclub','afterhours']) {
    await page.locator('[data-gb-setting="theme"]').selectOption(theme);await page.evaluate(axe.source);
    const result=await page.evaluate(async()=>{
     const data=await axe.run({runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa','best-practice']}});
     const compact=entry=>({id:entry.id,impact:entry.impact,nodes:entry.nodes.map(node=>({target:node.target,failure_summary:node.failureSummary}))});
     return {violations:data.violations.map(compact),incomplete:data.incomplete.map(compact)};
    });
    report.checks.push({case_id:'P21-A11Y-GAME-THEMES',route:'/game',width,theme,result:result.violations.length?'FAIL':'PASS',violations:result.violations});
    if(result.incomplete.length)report.manual_review.push({route:'/game',width,theme,items:result.incomplete});
   }
   await page.close();
  }
  // Axe needs asynchronous JavaScript execution. Chromium's fully disabled
  // execution mode can garbage-collect its pending promises, so this audit
  // enables tooling while aborting every site script request. The separate
  // browser suite still verifies genuine javaScriptEnabled:false rendering.
  for(const width of [1672,390]) {
   const context=await browser.newContext({javaScriptEnabled:true,viewport:{width,height:941}});
   const page=await context.newPage(),blockedScripts=[],apiRequests=[];
   await page.route('**/*',route=>{
    const request=route.request(),url=new URL(request.url());
    if(request.resourceType()==='script'){blockedScripts.push(url.pathname);return route.abort('blockedbyclient');}
    if(url.pathname.startsWith('/api/')){apiRequests.push(url.pathname);return route.abort('blockedbyclient');}
    return url.origin===origin?route.continue():route.abort('blockedbyclient');
   });
   for(const route of ['/','/how-to-play','/themes','/download','/faq','/privacy','/terms','/legal/support']) {
    const scriptStart=blockedScripts.length,apiStart=apiRequests.length;
    const response=await context.request.get(origin+route),sourceHTML=await response.text();
    await page.goto(origin+route,{waitUntil:'networkidle'});await page.locator('#main h1').waitFor();await page.evaluate(()=>document.fonts.ready);
    const isolation=await page.evaluate(html=>{
     const parsed=new DOMParser().parseFromString(html,'text/html');
     const siteScripts=[...document.querySelectorAll('script[src]')].map(script=>new URL(script.src).pathname);
     const inlineExecutionCandidates=[...document.scripts].filter(script=>!script.src&&!['application/ld+json','application/json'].includes(script.type)&&script.textContent.trim()).length;
     const inlineEventHandlers=[...document.querySelectorAll('*')].filter(element=>[...element.attributes].some(attribute=>/^on/i.test(attribute.name))).length;
     const globals=['MegaGame','MegaAccount','MegaNetwork'].filter(name=>typeof globalThis[name]!=='undefined');
     const mainUnhydrated=document.querySelector('#main').innerHTML===parsed.querySelector('#main').innerHTML;
     // An enabled HTML parser treats noscript body contents as text. Expose
     // the retained notice for the audit exactly as disabled rendering does.
     const notices=[...document.querySelectorAll('noscript')];
     for(const notice of notices){const container=document.createElement('div');container.dataset.qaNoscript='exposed-for-audit';container.innerHTML=notice.textContent;notice.replaceWith(container);}
     return {siteScripts,inlineExecutionCandidates,inlineEventHandlers,globals,mainUnhydrated,noscriptNoticesExposed:notices.length};
    },sourceHTML);
    const currentBlocked=blockedScripts.slice(scriptStart),currentAPI=apiRequests.slice(apiStart);
    const isolated=isolation.mainUnhydrated&&isolation.inlineExecutionCandidates===0&&isolation.inlineEventHandlers===0&&isolation.globals.length===0&&currentAPI.length===0&&isolation.siteScripts.every(script=>currentBlocked.includes(script));
    const mode={javaScriptEnabled:true,execution_mode:'audit-tool-only; every site script blocked; noscript notice exposed',site_scripts_blocked:currentBlocked};
    report.checks.push({case_id:'P21-A11Y-PRERENDERED-ISOLATION',route,width,...mode,result:isolated?'PASS':'FAIL',...isolation,apiRequests:currentAPI});
    if(!isolated)throw Error('Prerender audit could not prove site-script isolation: '+route+' at '+width);
    await page.evaluate(axe.source);
    const result=await page.evaluate(async()=>{
     const data=await axe.run({runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa','best-practice']}});
     const compact=entry=>({id:entry.id,impact:entry.impact,nodes:entry.nodes.map(node=>({target:node.target,failure_summary:node.failureSummary}))});
     return {violations:data.violations.map(compact),incomplete:data.incomplete.map(compact)};
    });
    report.checks.push({case_id:'P21-A11Y-PRERENDERED',route,width,...mode,result:result.violations.length?'FAIL':'PASS',violations:result.violations});
    if(result.incomplete.length)report.manual_review.push({route,width,...mode,items:result.incomplete});
   }
   await context.close();
  }
  // Published standings and personal cards need a separate synthetic linked
  // fixture: unavailable guest data cannot exercise their rendered controls.
  for(const width of [1672,390]) {
   const page=await browser.newPage({viewport:{width,height:941}});await localOnly(page);
   await page.route(origin+'/api/**',async route=>{
    const url=new URL(route.request().url());
    const profile={id:'fixture-player',name:'Fixture Player',tier:'emerald',rating:1968.25,games:24,region:'IN',season:{qualified:true},wallet:{coins:2450,crowns:12}};
    const rows=[{id:'fixture-rival',name:'Fixture Rival',tier:'gold',rating:1591.25,games:24,region:'IN',wealth:43210}];
    const known=route.request().method()==='GET'&&['/api/v1/profile','/api/v1/leaderboard'].includes(url.pathname);
    await route.fulfill({status:known?200:503,contentType:'application/json',body:JSON.stringify(known?url.pathname==='/api/v1/profile'?profile:rows:{error:'WEB_API_NOT_CONFIGURED'})});
   });
   for(const route of ['/leaderboard','/ranked','/profile','/store']) {
    await page.goto(origin+route,{waitUntil:'networkidle'});await page.evaluate(()=>document.fonts.ready);
    if(route==='/leaderboard')await page.locator('.pg-standings').waitFor();
    await page.evaluate(axe.source);
    const result=await page.evaluate(async()=>{
     const data=await axe.run({runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa','best-practice']}});
     const compact=entry=>({id:entry.id,impact:entry.impact,nodes:entry.nodes.map(node=>({target:node.target,failure_summary:node.failureSummary}))});
     return {violations:data.violations.map(compact),incomplete:data.incomplete.map(compact)};
    });
    report.checks.push({case_id:'P21-A11Y-SYNTHETIC-LINKED',route,width,data:'synthetic fixture only',result:result.violations.length?'FAIL':'PASS',violations:result.violations});
    if(result.incomplete.length)report.manual_review.push({route,width,data:'synthetic fixture only',items:result.incomplete});
   }
   await page.close();
  }
  const page=await browser.newPage({viewport:{width:390,height:844}});await localOnly(page);await page.goto(`http://127.0.0.1:${server.address().port}/play?mode=practice`);
  await page.locator('[data-gb-setting="theme"]').selectOption('paperclub');
  const hud=await page.locator('.gb-turn-icon').evaluate(el=>({foreground:getComputedStyle(el).color,background:getComputedStyle(el).backgroundColor}));
  const luminance=css=>{const rgb=css.match(/[\d.]+/g).slice(0,3).map(Number).map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
  const l=[luminance(hud.foreground),luminance(hud.background)].sort((a,b)=>b-a);const contrast=(l[0]+.05)/(l[1]+.05);
  report.checks.push({case_id:'P21-A11Y-PAPER-HUD-01',result:contrast>=4.5?'PASS':'FAIL',...hud,contrast});
  await page.locator('[data-gb-setting="theme"]').selectOption('cinematic');
  await page.emulateMedia({forcedColors:'active',reducedMotion:'reduce'});
  const forced=await page.locator('.gb-page-heading h1 span').evaluate(el=>({background:getComputedStyle(el).backgroundImage,color:getComputedStyle(el).color,transition:getComputedStyle(el).transitionDuration}));
  report.checks.push({case_id:'P21-A11Y-FORCED-COLORS-01',result:forced.background==='none'?'PASS':'FAIL',...forced});
  const forcedBoard=await page.locator('.gb-frame').evaluate(el=>({background:getComputedStyle(el).backgroundImage,shadow:getComputedStyle(el).boxShadow,edge:getComputedStyle(el,'::before').display}));
  report.checks.push({case_id:'P21-A11Y-NEON-FORCED-COLORS',result:forcedBoard.background==='none'&&forcedBoard.shadow==='none'&&forcedBoard.edge==='none'?'PASS':'FAIL',...forcedBoard});
  await page.close();
 } catch(error) {
  report.checks.push({case_id:'P21-A11Y-EXECUTION',result:'FAIL',message:String(error.message).slice(0,1000)});
 } finally {await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(snapshot,{recursive:true,force:true});}
 report.result=report.checks.every(check=>check.result==='PASS')?'PASS':'FAIL';
 report.limitations=['Automated checks are not physical VoiceOver/TalkBack acceptance.','Prerender axe checks allow audit JavaScript, block all site scripts, verify no hydration and expose the noscript notice. Actual JavaScript-disabled rendering is verified separately by browser-qa.cjs.','Incomplete image/gradient contrast findings require human review.','No live account, native store, provider or production acceptance.'];
 const output=path.join(ROOT,'tests-output/p21-web');fs.mkdirSync(output,{recursive:true});
 const immutableOutput=path.join(output,manifest.bundle_sha256.slice(0,12));fs.mkdirSync(immutableOutput,{recursive:true});
 fs.writeFileSync(path.join(immutableOutput,'accessibility-qa.json'),JSON.stringify(report,null,2)+'\n');
 fs.writeFileSync(path.join(immutableOutput,'accessibility-qa-'+(report.source_commit||'unversioned').slice(0,12)+'-'+report.checked_at.replace(/[^0-9]/g,'')+'.json'),JSON.stringify(report,null,2)+'\n');
 fs.writeFileSync(path.join(output,'accessibility-qa.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({result:report.result,checks:report.checks.length,violations:report.checks.filter(check=>check.result==='FAIL'),incomplete_views:report.manual_review.length}));
 if(report.result!=='PASS')process.exitCode=1;
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
