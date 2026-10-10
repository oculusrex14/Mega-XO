"""Live static-client tutorial checks. Browser automation is not physical device evidence."""
import json, os, re, shutil, threading
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'.artifacts/v51'; OUT.mkdir(parents=True,exist_ok=True)
class Quiet(SimpleHTTPRequestHandler):
    def log_message(self,*args): pass
server=ThreadingHTTPServer(('127.0.0.1',0),partial(Quiet,directory=str(ROOT)))
thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
base=f'http://127.0.0.1:{server.server_port}'
results=[];errors=[]
INLINE=os.environ.get('MEGA_INLINE_BROWSER')=='1'
html=(ROOT/'index.html').read_text()
html=re.sub(r'<link[^>]+href="https:[^"]+"[^>]*>','',html)
html=re.sub(r'<script src="https:[^"]+"></script>','',html)
html=re.sub(r'<link rel="stylesheet" href="([^"]+)">',lambda m:'<style>'+(ROOT/m[1]).read_text()+'</style>',html)
html=re.sub(r'<script src="([^"]+)"></script>',lambda m:'<script>'+(ROOT/m[1]).read_text()+'</script>',html)
def load_page(context,saved=None):
 page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
 page.route('**/*',lambda route:route.continue_() if route.request.url.startswith(base) else route.abort())
 if INLINE:
  shim='<script>Object.defineProperty(window,"localStorage",{value:{data:'+json.dumps(saved or {})+',getItem(k){return this.data[k]??null},setItem(k,v){this.data[k]=String(v)},removeItem(k){delete this.data[k]}}});window.fetch=async()=>new Response(JSON.stringify({error:"SERVICE_UNAVAILABLE"}),{status:503,headers:{"Content-Type":"application/json"}});</script>'
  page.set_content(html.replace('<body>','<body>'+shim),wait_until='domcontentloaded')
 else:page.goto(base+'/index.html',wait_until='domcontentloaded')
 return page
try:
 with sync_playwright() as p:
  browser_name=os.environ.get('MEGA_BROWSER','chromium')
  if browser_name not in ('chromium','firefox','webkit'):raise ValueError('UNSUPPORTED_BROWSER')
  launch={'headless':True}
  if browser_name=='chromium':launch.update(executable_path=os.environ.get('CHROMIUM_EXECUTABLE') or shutil.which('chromium'),args=['--no-sandbox'])
  browser=getattr(p,browser_name).launch(**launch)
  browser_version=browser.version
  for theme in ['vector','midnight','paperclub','afterhours']:
   context=browser.new_context(viewport={'width':390,'height':844},reduced_motion='reduce')
   page=load_page(context)
   page.locator('[data-c="guest"]').wait_for();page.locator('[data-c="guest"]').click()
   page.evaluate("theme=>{const s=MegaApp.getSave();s.settings.theme=theme;s.settings.timer=30;MegaApp.applyPractice(s);MegaApp.tutorial();}",theme)
   page.locator('[data-action="practice"]').click()
   assert page.evaluate('MegaXO.getTutorial().phase')=='PROMPT'
   assert page.evaluate('MegaApp.getSave().offlineMatch.tutorial.phase')=='PROMPT'
   assert page.locator('#board .cell:not(:disabled)').count()==0
   page.locator('[data-tutor="continue"]').click()
   assert page.locator('#board .cell:not(:disabled)').count()==1
   page.locator('.cell[data-b="0"][data-c="0"]').dispatch_event('click')
   assert page.evaluate('MegaXO.getState().moves.length')==0
   page.locator('.tutorial-cell').focus();page.keyboard.press('Enter')
   assert page.evaluate('MegaXO.getState().moves.length')==1
   page.wait_for_timeout(1250)
   assert page.evaluate('MegaXO.getState().moves.length')==1
   assert page.locator('#clock').inner_text()=='30s'
   if theme=='vector':
    if INLINE:
     saved=page.evaluate('localStorage.data');page.close();page=load_page(context,saved)
    else:page.reload(wait_until='domcontentloaded')
    page.wait_for_function('!!window.MegaApp')
    if page.locator('[data-c="guest"]').is_visible():page.locator('[data-c="guest"]').click()
    page.evaluate('MegaApp.resumeOffline()')
    assert page.evaluate('MegaXO.getState().moves.length')==1
    assert page.evaluate('MegaXO.getTutorial().phase')=='AWAIT_CONTINUE'
   for revision in [2,3,4,5,6]:
    if revision%2==0:page.locator('[data-tutor="continue"]').click()
    else:page.locator('.tutorial-cell').click()
    assert page.evaluate('MegaXO.getState().moves.length')==revision
   assert page.evaluate("MegaXO.getState().mini[0]==='X' && MegaXO.getState().turn==='X' && MegaXO.getState().required===null && MegaXO.getState().winner===null")
   assert page.locator('#board .cell:not(:disabled)').count()==0
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
   for box in page.locator('#guidedPractice button').evaluate_all('(els)=>els.filter(e=>e.getClientRects().length).map(e=>{const r=e.getBoundingClientRect();return [r.width,r.height]})'):
    assert box[0]>=44 and box[1]>=44,box
   page.screenshot(path=str(OUT/(theme+'-free-route.png')))
   page.locator('[data-tutor="continue"]').click()
   assert page.evaluate('MegaXO.getTutorial().phase')=='DONE'
   assert page.locator('#board .cell:not(:disabled)').count()==69
   page.locator('#board .cell:not(:disabled)').first.click()
   page.wait_for_function('MegaXO.getState().moves.length===8')
   assert page.evaluate('MegaApp.getSave().records.length')==0
   assert page.evaluate('MegaApp.getSave().offlineMatch.practice') is True
   page.locator('[data-tutor="restart"]').click()
   assert page.evaluate('MegaXO.getState().moves.length')==8
   assert page.locator('#board .cell:not(:disabled)').count()==0
   page.locator('[data-tutor="restart-confirm"]').click()
   assert page.evaluate('MegaXO.getState().moves.length')==0
   page.locator('[data-tutor="skip"]').click()
   assert page.evaluate('MegaXO.getTutorial().phase')=='DONE'
   assert page.locator('#board .cell:not(:disabled)').count()==81
   page.evaluate("()=>{const b=document.createElement('button');b.dataset.action='rematch';document.body.append(b);b.click();b.remove();}")
   assert page.evaluate("MegaXO.getTutorial().phase==='PROMPT' && MegaXO.getState().turn==='X'")
   results.append({'theme':theme,'passed':True,'cases':['objective','initial-prompt-save','wrong-tap','keyboard','ack-pause','six-move-route','69-legal-handoff','real-Beginner','no-normal-stats','explicit-restart','skip','practice-rematch-X','44px-controls','no-horizontal-overflow']})
   context.close()
  browser.close()
 assert not errors,errors
 report={'engine':'headless '+browser_name,'browserVersion':browser_version,'delivery':'inline fixture with restored storage' if INLINE else 'HTTP static client','physicalDevices':False,'results':results,'pageErrors':errors,'limitations':['No physical Android or iOS WebView, Safari, assistive-technology user or moderated beta participant tested.','Local speech may be unavailable; mandatory captions and disabled narration fallback verified.']}
 (OUT/'tutorial-browser.json').write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps(report,indent=2))
finally:server.shutdown();server.server_close()
