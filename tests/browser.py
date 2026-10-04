import os, shutil
from pathlib import Path
from playwright.sync_api import sync_playwright
import json, time
ROOT=Path(__file__).resolve().parents[1]
OUT=(ROOT/'.artifacts');OUT.mkdir(exist_ok=True)
results=[]
def document(storage=None):
 text=(ROOT/'index.html').read_text()
 text=text.replace('<link rel="stylesheet" href="src/styles.css">','<style>'+(ROOT/'src/styles.css').read_text()+'</style>')
 initial=json.dumps(storage or {})
 shim='<script>Object.defineProperty(window,"localStorage",{configurable:true,value:{data:'+initial+',getItem(k){return this.data[k]??null},setItem(k,v){this.data[k]=String(v)},removeItem(k){delete this.data[k]}}});</script>'
 text=text.replace('<script src="src/game.js"></script>',shim+'<script>'+(ROOT/'src/game.js').read_text()+'</script>')
 for name in ['domain','icons','app']:
  text=text.replace('<script src="src/'+name+'.js"></script>','<script>'+(ROOT/('src/'+name+'.js')).read_text()+'</script>')
 return text
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE') or shutil.which('chromium'),headless=True,args=['--no-sandbox'])
 page=browser.new_page(viewport={'width':390,'height':844},device_scale_factor=1)
 errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.set_content(document())
 page.locator('#sheetClose').click()
 page.screenshot(path=str(OUT/'home-vector.png'))
 for theme in ['vector','dark','paper','neon']:
  page.locator('#settingsButton').click()
  page.locator('[data-action="theme"][data-value="'+theme+'"]').click()
  assert page.locator('html').get_attribute('data-theme')==theme
  page.screenshot(path=str(OUT/('settings-'+theme+'.png')))
  page.locator('#sheetClose').click()
  page.screenshot(path=str(OUT/('home-'+theme+'.png')))
  page.locator('[data-action="nav"][data-value="rank"]').last.click()
  page.locator('#rankLeague').select_option('grandmaster')
  page.screenshot(path=str(OUT/('rank-'+theme+'.png')))
  page.locator('[data-action="nav"][data-value="play"]').last.click()
  page.locator('[data-action="start"]').click()
  before=page.locator('#boardWrap').bounding_box()
  page.locator('.cell[data-b="4"][data-c="2"]').click()
  page.wait_for_function('window.MegaXO.getState().moves.length === 2',timeout=5000)
  after=page.locator('#boardWrap').bounding_box()
  assert before==after,(before,after)
  page.screenshot(path=str(OUT/('game-'+theme+'.png')))
  page.locator('[data-action="settings"]').last.click()
  count=page.evaluate('window.MegaXO.getState().moves.length')
  page.locator('[data-action="theme"][data-value="'+theme+'"]').click()
  page.locator('#sheetClose').click()
  assert count==page.evaluate('window.MegaXO.getState().moves.length')
  page.locator('[data-action="leave"]').click();page.locator('[data-action="home"]').click()
  results.append({'theme':theme,'bot_reply':True,'stable_geometry':True,'settings_kept_moves':True})
 # 320-430 and tablet: no horizontal overflow; match controls reachable.
 for width,height in [(320,568),(360,640),(390,844),(430,932),(768,1024)]:
  page.set_viewport_size({'width':width,'height':height})
  page.locator('[data-action="mode"][data-value="local"]').click()
  page.locator('[data-action="start"]').click()
  box=page.locator('#boardWrap').bounding_box();assert abs(box['width']-box['height'])<1
  assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
  page.locator('[data-action="resign"]').scroll_into_view_if_needed()
  page.screenshot(path=str(OUT/('responsive-'+str(width)+'.png')))
  page.locator('[data-action="leave"]').click();page.locator('[data-action="home"]').click()
  results.append({'viewport':[width,height],'square_board':True,'no_horizontal_scroll':True})
 # Full local match: no size changes on claims and no personal rewards.
 page.set_viewport_size({'width':390,'height':844})
 page.locator('[data-action="mode"][data-value="local"]').click();page.locator('[data-action="start"]').click()
 before=page.locator('#boardWrap').bounding_box()
 for _ in range(81):
  if page.evaluate('Boolean(window.MegaXO.getState().winner)'):break
  page.locator('.cell:not([disabled])').first.click()
  assert page.locator('#boardWrap').bounding_box()==before
 assert page.evaluate('Boolean(window.MegaXO.getState().winner)')
 page.screenshot(path=str(OUT/'completed-local.png'))
 assert page.evaluate("JSON.parse(localStorage.getItem('mega_v32_state')).records.length")==0
 page.locator('[data-action="home"]').click()
 # Theme persists across reload.
 saved=page.evaluate('localStorage.data');page.goto('about:blank');page.set_content(document(saved));assert page.locator('html').get_attribute('data-theme')=='neon'
 assert not errors,errors
 results.append({'complete_local_game':True,'no_claim_resize':True,'local_excluded':True,'theme_persistence':True,'console_errors':errors})
 browser.close()
(OUT/'browser-results.json').write_text(json.dumps(results,indent=2))
print(json.dumps(results,indent=2))
