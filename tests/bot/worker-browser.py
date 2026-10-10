"""Real HTTP Worker lifecycle and retained P21 game checks; no physical-device claim."""
import json, os, shutil, threading
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'.artifacts/v51';OUT.mkdir(parents=True,exist_ok=True)
class Quiet(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),partial(Quiet,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
base=f'http://127.0.0.1:{server.server_port}';results=[];errors=[]
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE') or shutil.which('chromium'),headless=True,args=['--no-sandbox'])
  for route in ['/index.html','/.artifacts/p21-web/game/index.html']:
   context=browser.new_context(viewport={'width':390,'height':844})
   page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
   page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(base) else r.abort())
   page.add_init_script("""window.__posted=[];window.__terminated=0;const W=window.Worker;window.Worker=class extends W{postMessage(m,...a){window.__posted.push({engine:m.engine,at:performance.now()});return super.postMessage(m,...a)}terminate(){window.__terminated++;return super.terminate()}};localStorage.setItem('mega_v51_search','experimental');""")
   page.goto(base+route,wait_until='domcontentloaded');page.locator('[data-c="guest"]').click()
   page.locator('[data-action="difficulty"][data-value="Expert"]').click()
   page.locator('[data-action="start"]').click()
   assert page.evaluate("MegaXO.getBotInfo().engine")=='experimental'
   seed=page.evaluate('MegaXO.getBotInfo().seed')
   page.locator('#board .cell:not(:disabled)').first.click()
   page.wait_for_function('__posted.length===1')
   page.locator('[data-action="matchstats"]').click()
   page.wait_for_timeout(500)
   assert page.evaluate('MegaXO.getState().moves.length')==1
   assert page.evaluate('__terminated')>=1
   page.locator('#sheetClose').click()
   page.wait_for_function('MegaXO.getState().moves.length===2')
   assert page.evaluate('MegaXO.getBotDiagnostics().engineVersion')=='search-v1-experimental'
   assert page.evaluate('MegaApp.getSave().offlineMatch.bot.seed')==seed
   page.evaluate("localStorage.setItem('mega_v51_search','legacy')")
   assert page.evaluate('MegaXO.getBotInfo().engine')=='experimental'
   state=page.evaluate('MegaXO.getState()');page.reload(wait_until='domcontentloaded')
   if page.locator('[data-c="guest"]').is_visible():page.locator('[data-c="guest"]').click()
   page.evaluate('MegaApp.resumeOffline()')
   assert page.evaluate('MegaXO.getState()')==state
   assert page.evaluate('MegaXO.getBotInfo().seed')==seed
   assert page.evaluate('MegaXO.getBotInfo().engine')=='experimental'
   results.append({'route':route,'realWorker':True,'cancelledBeforeMove':True,'canonicalMove':True,'pinnedSeed':True,'engineVersion':'search-v1-experimental'})
   context.close()
  browser.close()
 assert not errors,errors
 report={'results':results,'pageErrors':errors,'physicalDevices':False,'defaultEngine':'legacy','promotionApproved':False}
 (OUT/'worker-browser.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
finally:server.shutdown();server.server_close()
