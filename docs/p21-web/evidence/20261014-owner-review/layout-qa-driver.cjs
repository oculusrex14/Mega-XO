const {chromium,firefox,webkit}=require('playwright');
const axe=require('axe-core'); const fs=require('fs'); const path=require('path');
(async()=>{
 const base=process.env.P21_REVIEW_ORIGIN||'http://127.0.0.1:4184';
 const output=path.resolve(process.env.P21_REVIEW_OUTPUT||'.artifacts/p21-owner-review'); fs.mkdirSync(output,{recursive:true}); const manifest=process.env.P21_REVIEW_ORIGIN?{source_commit:'5897497493617e1f389af1626451899831045840',bundle_sha256:'31cdb4d302a12182b709c7430b389d79a42a706001360fab56afb3dd22028b7c'}:await (await fetch(base+'/web-build.manifest.json',{signal:AbortSignal.timeout(60000)})).json(); const results=[];
 for(const [name,engine] of Object.entries(process.env.P21_REVIEW_ORIGIN?{chromium}:{chromium,firefox,webkit})) {
  const browser=await engine.launch(name==='chromium'?{executablePath:'/Users/oculus/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'}:{});
  for(const width of (process.env.P21_REVIEW_ORIGIN?[1625,390]:[1625,390,320])){
   const page=await browser.newPage({viewport:{width,height:865}});
   for(const route of ['/sponsors','/privacy','/terms','/settings']){
    const response=await page.goto(base+route,{waitUntil:'domcontentloaded',timeout:60000});await page.evaluate(()=>document.fonts.ready);
    const metrics=await page.evaluate(()=>({width:innerWidth,content:document.documentElement.scrollWidth,h1:document.querySelectorAll('main h1').length,draft:/Draft for legal review|Not yet effective|Pending legal approval/.test(document.querySelector('main').innerText),pressLink:!!document.querySelector('footer a[href="/press"]'),email:!!document.querySelector('main a[href="mailto:contact@antimatterinnovations.com"]')}));
    if(response.status()!==200||metrics.content>width+1||metrics.h1!==1||metrics.draft||metrics.pressLink)throw Error(name+route+' layout or content assertion failed');
    if(route==='/sponsors'){
     const gap=await page.evaluate(()=>{const p=document.querySelector('.pg-sponsor-disclosure');return p.querySelector('.mx-button').getBoundingClientRect().top-p.querySelector('ul').getBoundingClientRect().bottom});
     if(gap<24)throw Error('Sponsor gap too small');metrics.sponsor_gap=gap;
     await page.locator('.pg-sponsor-disclosure').scrollIntoViewIfNeeded();
    }
    await page.evaluate(axe.source);
    const accessibility=await page.evaluate(async()=>{const r=await axe.run({runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']}});return r.violations.map(v=>({id:v.id,impact:v.impact,targets:v.nodes.map(n=>n.target)}))});
    if(accessibility.length)throw Error(name+route+' accessibility assertion failed: '+JSON.stringify(accessibility));metrics.axe_violations=0;
    if(name==='chromium'&&width!==320)await page.screenshot({path:path.join(output,route.slice(1)+'-'+width+'.png'),fullPage:false});
    results.push({engine:name,version:browser.version(),route,width,status:response.status(),...metrics,result:'PASS'});
   }
   const gone=await page.goto(base+'/press',{waitUntil:'domcontentloaded',timeout:60000});if(gone.status()!==404)throw Error('Removed page did not return 404');
   const sitemap=await page.request.get(base+'/sitemap.xml');if((await sitemap.text()).includes('/press'))throw Error('Removed page in sitemap');
   results.push({engine:name,route:'/press',width,status:gone.status(),result:'PASS'});await page.close();
  }
  await browser.close();
 }
 fs.writeFileSync(path.join(output,'visual-qa.json'),JSON.stringify({origin:base,checked_at:new Date().toISOString(),source_commit:manifest.source_commit,bundle_sha256:manifest.bundle_sha256,results},null,2)+'\n');console.log(JSON.stringify({checks:results.length,pass:results.length,fail:0,origin:base}));
})().catch(e=>{console.error(e.message);process.exit(1)});
