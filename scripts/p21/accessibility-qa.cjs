'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {once} = require('node:events');
const {createPreviewServer} = require('./serve-web.js');
const {ROOT, WEBSITE_ROUTES} = require('./build-web.js');
// Tool dependencies are kept outside the product payload and its dependencies.
const {chromium} = require('playwright');
const axe = require('axe-core');

async function main() {
 const manifest=JSON.parse(fs.readFileSync(path.join(ROOT,'.artifacts/p21-web/web-build.manifest.json')));
 const report={case_ids:['P21-A11Y-001','P21-A11Y-PAPER-HUD-01','P21-A11Y-FORCED-COLORS-01'],source_commit:manifest.source_commit,bundle_sha256:manifest.bundle_sha256,command:`env -u NODE_OPTIONS ${process.execPath} scripts/p21/accessibility-qa.cjs`,environment:'Local loopback Chromium; guest; no authenticated/provider traffic',tool_version:axe.version,checks:[],manual_review:[]};
 const server=createPreviewServer();server.listen(0,'127.0.0.1');await once(server,'listening');
 const browser=await chromium.launch();report.browser=browser.version();
 try {
  for(const width of [1672,390]) {
   const page=await browser.newPage({viewport:{width,height:941}});
   for(const route of [...WEBSITE_ROUTES,'/play?mode=practice']) {
    await page.goto(`http://127.0.0.1:${server.address().port}${route}`);await page.evaluate(()=>document.fonts.ready);await page.evaluate(axe.source);
    const result=await page.evaluate(async()=>{
     const data=await axe.run({runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa','best-practice']}});
     const compact=entry=>({id:entry.id,impact:entry.impact,nodes:entry.nodes.map(node=>({target:node.target,failure_summary:node.failureSummary}))});
     return {violations:data.violations.map(compact),incomplete:data.incomplete.map(compact)};
    });
    report.checks.push({route,width,result:result.violations.length?'FAIL':'PASS',violations:result.violations});
    if(result.incomplete.length)report.manual_review.push({route,width,items:result.incomplete});
   }
   await page.close();
  }
  const page=await browser.newPage({viewport:{width:390,height:844}});await page.goto(`http://127.0.0.1:${server.address().port}/play?mode=practice`);
  await page.locator('[data-gb-setting="theme"]').selectOption('paperclub');
  const hud=await page.locator('.gb-turn-icon').evaluate(el=>({foreground:getComputedStyle(el).color,background:getComputedStyle(el).backgroundColor}));
  const luminance=css=>{const rgb=css.match(/[\d.]+/g).slice(0,3).map(Number).map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
  const l=[luminance(hud.foreground),luminance(hud.background)].sort((a,b)=>b-a);const contrast=(l[0]+.05)/(l[1]+.05);
  report.checks.push({case_id:'P21-A11Y-PAPER-HUD-01',result:contrast>=4.5?'PASS':'FAIL',...hud,contrast});
  await page.emulateMedia({forcedColors:'active',reducedMotion:'reduce'});
  const forced=await page.locator('.gb-page-heading h1 span').evaluate(el=>({background:getComputedStyle(el).backgroundImage,color:getComputedStyle(el).color,transition:getComputedStyle(el).transitionDuration}));
  report.checks.push({case_id:'P21-A11Y-FORCED-COLORS-01',result:forced.background==='none'?'PASS':'FAIL',...forced});
  await page.close();
 } finally {await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 report.result=report.checks.every(check=>check.result==='PASS')?'PASS':'FAIL';
 report.limitations=['Automated checks are not physical VoiceOver/TalkBack acceptance.','Incomplete image/gradient contrast findings require human review.','No live account, native store, provider or production acceptance.'];
 const output=path.join(ROOT,'tests-output/p21-web');fs.mkdirSync(output,{recursive:true});
 fs.writeFileSync(path.join(output,'accessibility-qa.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({result:report.result,checks:report.checks.length,violations:report.checks.filter(check=>check.result==='FAIL'),incomplete_views:report.manual_review.length}));
 if(report.result!=='PASS')process.exitCode=1;
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
