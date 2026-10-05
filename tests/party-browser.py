"""Functional party UI checks. No pixel-equivalence or native-radio claim.
Use the actual V3.3 party modules and a small isolated host shell; API traffic
is bridged to the real Node/SQLite HTTP handler when browser loopback is restricted.
"""
import json, os, shutil, subprocess, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
server=subprocess.Popen(['node',str(ROOT/'tests/party-browser-server.js')],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
port=int(server.stdout.readline().strip())
css=(ROOT/'src/styles.css').read_text()+'\n'+(ROOT/'src/party.css').read_text()
# Existing game/nav is represented only at the integration boundary. No fixture players are in production code.
html='''<!doctype html><html data-theme="vector"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'''+css+'''</style><body><div id="app" class="app"><div id="page"><div class="mode-list"><button class="mode active" data-value="private">Private Match</button></div><button data-action="start">Open Private Lobby</button></div><nav id="navigation"></nav></div>'''
for n in ['game','tournament','lan-icons','icons','party-ui']:
 html+='<script>'+(ROOT/('src/'+n+'.js')).read_text()+'</script>'
html+='</body></html>'
def bridge(path,options):
 if not path.startswith('/api/party/'):
  return {'status':503,'data':{'error':'SERVICE_UNAVAILABLE'}}
 target='http://127.0.0.1:'+str(port)+path
 headers=dict(options.get('headers',{}));headers['Origin']='http://mega.test'
 data=options.get('body')
 request=urllib.request.Request(target,data=data.encode() if data else None,headers=headers,method=options.get('method','GET'))
 try:
  response=urllib.request.urlopen(request,timeout=10); status=response.status; result=response.read()
 except urllib.error.HTTPError as e:status=e.code;result=e.read()
 return {'status':status,'data':json.loads(result)}
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE') or shutil.which('chromium'),args=['--no-sandbox'])
  errors=[]
  def client(storage=None):
   ctx=browser.new_context(viewport={'width':390,'height':844});page=ctx.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
   page.expose_function('__partyBridge',bridge)
   shim='<script>Object.defineProperty(window,"localStorage",{value:{data:'+json.dumps(storage or {})+',getItem(k){return this.data[k]??null},setItem(k,v){this.data[k]=String(v)},removeItem(k){delete this.data[k]}}});window.fetch=async(url,opts={})=>{const r=await __partyBridge(url,opts);return new Response(JSON.stringify(r.data),{status:r.status,headers:{"Content-Type":"application/json"}});};</script>'
   page.set_content(html.replace('<body>', '<body>'+shim));return page
  a,b=client(),client()
  # Tournaments is now a first-class app mode; party-ui no longer injects a fifth card.
  assert a.locator('[data-party="tables"]').count()==0
  a.evaluate('MegaParties.tables()')
  assert a.locator('.party-table').count()==4
  assert a.locator('.party-entry').count()==4
  for theme in ['vector','midnight','paperclub','afterhours']:
   a.evaluate("(t)=>document.documentElement.dataset.theme=t",theme)
   assert a.evaluate('document.querySelector("#partyScreen").scrollWidth<=document.querySelector("#partyScreen").clientWidth')
  a.evaluate("document.documentElement.dataset.theme='vector'")
  a.locator('[data-party="table"][data-table="low"]').click()
  assert '360' in a.locator('#partyBody').inner_text()
  a.locator('[data-party="back"]').click();a.locator('[data-party="local"]').click();a.locator('#partyNames').fill('Alice\nBob\nCara\nDan');a.locator('#partyFormat').select_option('mixed');a.locator('#partyClock').select_option('0');a.locator('[data-party="createRoom"]').click();a.locator('[data-party="start"]').click();assert 'Group A' in a.locator('#partyBody').inner_text();a.locator('[data-party="back"]').click()
  # Back from an event closes the overlay; explicitly reopen the private hub.
  a.locator('[data-action="start"]').click()
  assert 'Challenge a friend (1v1)' in a.locator('#partyBody').inner_text()
  assert a.locator('.party-choice').count()>=4
  a.locator('[data-party="back"]').click()
  # Actual separate-client free LAN room.
  for page,name in [(a,'Alice'),(b,'Bob')]:
   page.locator('[data-action="start"]').click();page.locator('[data-party="lan"]').click();page.locator('#partyName').fill(name)
  a.locator('#partyFormat').select_option('duel');a.locator('[data-party="createRoom"]').click()
  code=a.locator('.note b').first.inner_text().split()[-1]
  b.locator('[data-party="joinForm"]').click();b.locator('#partyName').fill('Bob');b.locator('#partyCode').fill(code);b.locator('[data-party="joinRoom"]').click()
  for page in [a,b]:page.locator('[data-party="ready"]').click()
  a.locator('[data-party="start"]').click()
  for page in [a,b]:
   page.locator('[data-party="game"]').first.click()
   page.locator('[data-party="gameReady"]:not([disabled])').wait_for(timeout=10000);page.locator('[data-party="gameReady"]').click()
  a.wait_for_timeout(1500)
  first=a if a.locator('#partyBoard .cell:not([disabled])').count() else b
  other=b if first==a else a
  before=first.locator('#partyBoardWrap').bounding_box()
  first.locator('[data-pb="4"][data-pc="2"]').hover();assert first.locator('.cell-hover').count()==1
  first.locator('[data-pb="4"][data-pc="2"]').click()
  first.wait_for_function('document.querySelectorAll("#partyRoute line").length===1',timeout=3000)
  other.locator('[data-mini="2"].active').wait_for(timeout=5000)
  assert first.locator('#partyBoardWrap').bounding_box()==before
  other.locator('[data-pb="2"][data-pc="4"]').click()
  first.locator('[data-mini="4"].active').wait_for(timeout=5000)
  # Reconnection keeps the same cryptographic guest identity/seat and current game.
  identity=first.evaluate('JSON.parse(localStorage.getItem("mega_party_session")).actor')
  storage=first.evaluate('localStorage.data');first.close();first=client(storage);first.locator('[data-action="start"]').click();first.locator('[data-party="reconnect"]').click();first.locator('[data-party="game"]').first.click()
  assert first.evaluate('JSON.parse(localStorage.getItem("mega_party_session")).actor')==identity
  first.locator('[data-mini="4"].active').wait_for(timeout=5000)
  for width,height in [(320,568),(390,844),(768,1024)]:
   first.set_viewport_size({'width':width,'height':height});box=first.locator('#partyBoardWrap').bounding_box();assert abs(box['width']-box['height'])<1;assert first.evaluate('document.documentElement.scrollWidth<=innerWidth')
  first.on('dialog',lambda d:d.accept());first.locator('[data-party="resign"]').click();first.locator('text=Final standings').wait_for(timeout=5000)
  assert not errors,errors
  print('PASS: fifth mode, payout table, local mixed event, two-client LAN lobby/ready/moves, legal hover/send, reload rejoin, square board at 320/390/768, resignation and final standings; no JS page errors')
  browser.close()
finally:
 server.terminate();server.wait(timeout=5)
