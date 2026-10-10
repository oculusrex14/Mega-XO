"""Optional model-data UI with isolated synthetic bytes, not an approved neural model."""
import json, os, shutil, threading
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2];OUT=ROOT/'.artifacts/v51';OUT.mkdir(parents=True,exist_ok=True)
class Quiet(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),partial(Quiet,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start();base=f'http://127.0.0.1:{server.server_port}'
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE') or shutil.which('chromium'),headless=True,args=['--no-sandbox']);page=browser.new_page(viewport={'width':390,'height':844});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(base) else r.abort())
  page.goto(base+'/index.html',wait_until='domcontentloaded');page.locator('[data-c="guest"]').click()
  before=page.evaluate('MegaApp.getSave()')
  page.locator('[data-action="aipack"]').click();assert 'No approved Impossible' in page.locator('#aiPackPanel').inner_text();assert page.locator('[data-pack-action="download"]').count()==0
  page.evaluate("""async()=>{
   const bytes=new Uint8Array([1,2,3,4]),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
   const info={schemaVersion:1,version:'synthetic-ui-fixture',sha256:hash,url:'/fixture/'+hash+'.onnx',bytes:4,gzipBytes:4,ruleset:MegaBotContract.RULESET,encodingVersion:'planes8-v1',deploymentStatus:'APPROVED'};
   const cache=new Map();window.__packRequests=0;
   const store=new MegaBotPack.Store({baseURL:location.href,catalog:[info],cacheStorage:{open:async()=>({match:async k=>cache.get(k)?.clone(),put:async(k,v)=>cache.set(k,v.clone()),delete:async k=>cache.delete(k)})},fetcher:async()=>{__packRequests++;return new Response(bytes);}});
   window.__packUI=MegaAiPack.create({catalog:[info],store});__packUI.show();
  }""")
  page.wait_for_function('document.querySelector("[data-pack-status]").textContent==="Not downloaded"')
  assert page.locator('[data-pack-action="download"]').is_disabled();assert page.evaluate('__packRequests')==0
  page.locator('#aiPackConsent').check();page.locator('[data-pack-action="download"]').click();page.wait_for_function('__packUI.getState().status==="ready"')
  assert page.evaluate('__packRequests')==1;assert 'verified and cached' in page.locator('[data-pack-status]').inner_text()
  assert page.locator('[data-pack-action="start"]').count()==0
  sizes=page.locator('.ai-pack-controls button').evaluate_all('(els)=>els.map(e=>[e.getBoundingClientRect().width,e.getBoundingClientRect().height])')
  assert all(w>=44 and h>=44 for w,h in sizes),sizes
  page.locator('[data-pack-action="remove"]').click();page.wait_for_function('__packUI.getState().status==="unavailable"')
  page.locator('[data-pack-action="download"]').click();page.wait_for_function('__packUI.getState().status==="ready"');assert page.evaluate('__packRequests')==2
  after=page.evaluate('MegaApp.getSave()');assert after['wallet']==before['wallet'];assert after['records']==before['records'];assert after['daily']==before['daily']
  assert page.evaluate('MegaGame.LEVELS.length')==5
  report={'browser':'Chromium','browserVersion':browser.version,'syntheticBytes':True,'approvedProductCatalogEmpty':True,'noAutomaticDownload':True,'consentRequired':True,'verifiedCache':True,'removeAndRedownload':True,'noPlayableModeClaim':True,'noEconomyOrStatsChange':True,'pageErrors':errors}
  page.screenshot(path=str(OUT/'pack-manager.png'));browser.close()
 if errors:raise AssertionError(errors)
 (OUT/'pack-browser.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
finally:server.shutdown();server.server_close()
