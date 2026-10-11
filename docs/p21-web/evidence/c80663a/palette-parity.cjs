'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {chromium} = require('playwright');
const baseline = '1a1a434bba893a8d70fb768b086a63fde1d06cb3';
const oldCss = execFileSync('git', ['show', baseline + ':apps/web/board.css'], {encoding:'utf8'});
const currentCss = fs.readFileSync('apps/web/board.css', 'utf8');
const report = {
  case_id: 'P21-NEON-ORIGINAL-PALETTE-PARITY',
  source_commit: execFileSync('git', ['rev-parse','HEAD'], {encoding:'utf8'}).trim(),
  baseline_commit: baseline,
  command: 'env -u NODE_OPTIONS NODE_PATH=.artifacts/p21-browser-qa/node_modules /Users/oculus/.hermes/node/bin/node .artifacts/p21-theme-review/palette-parity.cjs',
  environment: 'Local loopback Chromium; fresh unauthenticated contexts; old/new board CSS at identical cascade position',
  checked_at: new Date().toISOString(), checks: [],
};
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
(async()=>{
  const browser = await chromium.launch();
  try {
    for(const width of [1151,390]) {
      const page = await browser.newPage({viewport:{width,height:865}, reducedMotion:'reduce'});
      await page.goto('http://127.0.0.1:4173/game',{waitUntil:'networkidle'});
      await page.evaluate(()=>document.fonts.ready);
      await page.locator('[data-gb-setting="mode"]').selectOption('local');
      await page.locator('[data-gb-cell="0:4"]').click();
      await page.evaluate(()=>{
        const link=[...document.querySelectorAll('link[rel="stylesheet"]')].find(el=>el.href.endsWith('/board.css'));
        if(!link)throw new Error('Board stylesheet absent');
        const replacement=document.createElement('style');replacement.id='parity-board-css';link.after(replacement);link.disabled=true;
      });
      const capture = css => page.evaluate(async css=>{
        document.getElementById('parity-board-css').textContent=css;
        // Theme selection can demand a new local font. Resolve layout first
        // and await that font before comparing old/new geometry.
        document.querySelector('.gb-stage').getBoundingClientRect();
        await document.fonts.ready;
        const selectors=['.gb-stage','.gb-frame','.gb-mini','.gb-mini--active','.gb-cell--legal','.gb-mark--x','.gb-mark--o','.gb-avatar--x','.gb-avatar--o','.gb-turn-strip','.gb-turn-strip p','.gb-move-dot'];
        return Object.fromEntries(selectors.map(selector=>{
          const style=getComputedStyle(document.querySelector(selector));
          return [selector,Object.fromEntries([...style].map(property=>[property,style.getPropertyValue(property)]))];
        }));
      },css);
      for(const theme of ['vector','midnight','paperclub','afterhours']) {
        await page.locator('[data-gb-setting="theme"]').selectOption(theme);
        const previous=await capture(oldCss),current=await capture(currentCss);
        const differences=[];
        for(const selector of Object.keys(previous))for(const property of Object.keys(previous[selector])) {
          if(previous[selector][property]!==current[selector][property])differences.push({selector,property,before:previous[selector][property],after:current[selector][property]});
        }
        report.checks.push({width,theme,result:differences.length?'FAIL':'PASS',baseline_styles_sha256:digest(previous),current_styles_sha256:digest(current),differences});
      }
      await page.close();
    }
  } finally {await browser.close();}
  report.result=report.checks.every(check=>check.result==='PASS')?'PASS':'FAIL';
  fs.writeFileSync('.artifacts/p21-theme-review/original-palette-parity.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({result:report.result,checks:report.checks.length,failures:report.checks.filter(check=>check.result==='FAIL')}));
  if(report.result!=='PASS')process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});
