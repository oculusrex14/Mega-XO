"""Functional Chromium checks. External font/icon requests are blocked for deterministic offline tests.
This suite checks interaction/state, NOT pixel equivalence, fonts or theme contrast.
The small test-only sheet positioning shim supports testing historical CSS fixtures too.
"""
import subprocess,json,shutil,os,re,urllib.request,urllib.error
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
server=subprocess.Popen(['node',str(ROOT/'tests/fixture-server.js')],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
origin=server.stdout.readline().strip()
assert origin.startswith('http://127.0.0.1:')
results=[]
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE') or shutil.which('chromium'),args=['--no-sandbox'])
 def create(user=None):
  context=browser.new_context(viewport={'width':390,'height':844},extra_http_headers={'X-Fixture-User':user} if user else {})
  context.route('https://**/*',lambda route:route.abort())
  page=context.new_page();page.set_default_timeout(5000);page.errors=[];page.on('pageerror',lambda e:page.errors.append(str(e)))
  def api_call(payload):
   headers=payload.get('headers',{});headers['Origin']=origin
   if user:headers['X-Fixture-User']=user
   body=payload.get('body');request=urllib.request.Request(origin+payload['path'],data=body.encode() if body else None,headers=headers,method=payload.get('method','GET'))
   try:
    with urllib.request.urlopen(request) as response:return {'status':response.status,'body':response.read().decode()}
   except urllib.error.HTTPError as error:return {'status':error.code,'body':error.read().decode()}
  page.expose_function('__fixtureFetch',api_call)
  text=(ROOT/'index.html').read_text()
  text=re.sub(r'<link[^>]+(?:fonts.googleapis|fonts.gstatic)[^>]*>','',text)
  text=re.sub(r'<script src="https://unpkg.com/[^"]+"></script>','',text)
  text=text.replace('<link rel="stylesheet" href="src/styles.css">','<style>'+(ROOT/'src/styles.css').read_text()+'</style>')
  text=text.replace('<link rel="stylesheet" href="src/party.css">','<style>'+(ROOT/'src/party.css').read_text()+'</style>')
  shim='<script>Object.defineProperty(window,"localStorage",{value:{data:{mega_v32_tutorial_seen:"1"},getItem(k){return this.data[k]??null},setItem(k,v){this.data[k]=String(v)},removeItem(k){delete this.data[k]}}});window.fetch=async(path,options={})=>{const r=await window.__fixtureFetch({path,method:options.method||"GET",headers:options.headers||{},body:options.body});return new Response(r.body,{status:r.status,headers:{"Content-Type":"application/json"}});};</script>'
  text=text.replace('<script src="src/game.js"></script>',shim+'<script>'+(ROOT/'src/game.js').read_text()+'</script>')
  for name in ['domain','icons','network','app','tournament','party-ui']:text=text.replace('<script src="src/'+name+'.js"></script>','<script>'+(ROOT/('src/'+name+'.js')).read_text()+'</script>')
  page.set_content(text)
  page.add_style_tag(content='#routeOverlay{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}#sheet:not([hidden]){position:fixed;z-index:99;inset:auto 0 0 0;max-height:90vh;overflow:auto;background:var(--surface);padding:16px}#sheetBackdrop:not([hidden]){position:fixed;inset:0;z-index:98;background:#0005}')
  return page
 def click(page,action,value=None):
  if action=='close':page.locator('#sheetClose').click();return
  sel='[data-action="'+action+'"]'+('' if value is None else '[data-value="'+value+'"]')
  page.locator(sel+':visible').first.click()
 try:
  page=create();page.wait_for_timeout(150)
  assert page.locator('#navigation button').count()==5
  assert page.locator('.mode').count()==5
  click(page,'wallet');assert 'Saved on this device' in page.locator('#sheetBody').inner_text()
  page.locator('#exchangeAmount').fill('100');click(page,'exchange');click(page,'exchangeconfirm')
  assert 'Exchange complete' in page.locator('#toast').inner_text()
  assert page.evaluate("JSON.parse(localStorage.getItem('mega_v32_state')).wallet.crowns")==10
  page.locator('#exchangeFrom').select_option('crowns');page.locator('#exchangeAmount').fill('10');click(page,'exchange');click(page,'exchangeconfirm')
  assert page.evaluate("JSON.parse(localStorage.getItem('mega_v32_state')).wallet.coins")==100
  click(page,'close');click(page,'nav','rank');page.wait_for_timeout(100)
  assert page.locator('.standing').count()==0
  assert [x.inner_text() for x in page.locator('.tab').all()]==['Skill','Wealth']
  assert not page.locator('[data-action="demo"]').count()
  click(page,'nav','play');click(page,'mode','local');click(page,'start');before=page.locator('#boardWrap').bounding_box()
  page.locator('.cell[data-b="4"][data-c="2"]').click()
  assert page.evaluate('MegaXO.getState().required')==2
  page.wait_for_timeout(40);assert page.locator('#routeOverlay line').count()==1
  for theme in ['vector','midnight','paperclub','afterhours']:
   page.locator('#matchSettings').click();click(page,'theme',theme);click(page,'close')
   assert page.locator('html').get_attribute('data-theme')==theme
   # Themes intentionally have different border/material geometry. Inside each
   # theme, cells and the board must stay square and unchanged by adding marks.
   current=page.locator('#boardWrap').bounding_box();assert abs(current['width']-current['height'])<1
   moves=page.evaluate('MegaXO.getState().moves.length')
   page.locator('#board .cell:not([disabled])').first.click()
   after=page.locator('#boardWrap').bounding_box()
   assert abs(current['width']-after['width'])<1 and abs(current['height']-after['height'])<1
   assert page.evaluate('MegaXO.getState().moves.length')==moves+1
  click(page,'leave');click(page,'home');click(page,'mode','bot');click(page,'start')
  page.locator('.cell[data-b="4"][data-c="2"]').click();page.wait_for_function('MegaXO.getState().moves.length===2',timeout=7000)
  assert not page.errors,page.errors;results.append('offline exchange round-trip, no fabricated ranks, five tabs and five home modes, local routing, four theme IDs preserve match, bot reply')
  a=create('alice');b=create('bob');a.wait_for_timeout(200);b.wait_for_timeout(200)
  click(a,'nav','rank');a.wait_for_selector('.standing');click(a,'challenge','bob')
  a.locator('#challengeRated').select_option('true');assert a.locator('#challengeAmount').input_value()=='26'
  click(a,'sendchallenge');a.wait_for_timeout(250);assert 'Challenge sent' in a.locator('#sheetTitle').inner_text(),a.locator('#toast').inner_text();click(b,'nav','friends');b.wait_for_selector('[data-action="reviewinvite"]')
  click(b,'reviewinvite');assert 'You pay: 0' in b.locator('#sheetBody').inner_text()
  click(b,'acceptinvite');a.wait_for_function('MegaXO.getState()!==null');b.wait_for_function('MegaXO.getState()!==null')
  a.locator('.cell[data-b="4"][data-c="2"]').click();b.wait_for_function('MegaXO.getState().moves.length===1')
  b.locator('.cell[data-b="2"][data-c="0"]').click();a.wait_for_function('MegaXO.getState().moves.length===2')
  click(a,'matchstats');click(a,'resign');click(a,'resignyes')
  a.wait_for_function("document.querySelector('#sheet').dataset.kind==='result'");b.wait_for_function("document.querySelector('#sheet').dataset.kind==='result'")
  stateA=a.evaluate("async()=>fetch('/api/v1/profile',{headers:{'X-Fixture-User':'alice'}}).then(r=>r.json())")
  stateB=b.evaluate("async()=>fetch('/api/v1/profile',{headers:{'X-Fixture-User':'bob'}}).then(r=>r.json())")
  assert stateA['wallet']['crowns']==74 and stateB['wallet']['crowns']==13,(stateA,stateB)
  assert stateA['rating']<1500 and stateB['rating']>1700
  assert not a.errors and not b.errors,(a.errors,b.errors)
  results.append('two authenticated clients: live leaderboard, gap quote, invitation, zero-cost acceptance, authoritative alternating moves, funded settlement and Elo')
 finally:
  browser.close();server.terminate();server.wait(timeout=10)
(ROOT/'.artifacts').mkdir(exist_ok=True)
(ROOT/'.artifacts/economy-ui.json').write_text(json.dumps({'passed':results},indent=2))
print(json.dumps({'passed':results},indent=2))
