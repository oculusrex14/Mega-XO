"""Full V3.3.3 UI with actual HTTP/SQLite identity service.
Loopback navigation is blocked in the execution environment: use set_content,
per-browser cookie jars and a Python fetch bridge to the real local service.
Only provider signing is a test fixture. No production fake sign-in endpoint.
"""
import json, os, re, socket, subprocess, urllib.request, urllib.error, shutil, threading
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close()
server=subprocess.Popen(['node',str(ROOT/'tests/community-browser-server.js'),str(port)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
origin=server.stdout.readline().strip();assert origin.startswith('http://')
base=(ROOT/'index.html').read_text()
base=re.sub(r'<link[^>]+href="https:[^"]+"[^>]*>','',base)
base=re.sub(r'<script src="https:[^"]+"[^>]*></script>','',base)
base=re.sub(r'<link rel="stylesheet" href="([^"]+)">',lambda m:'<style>'+(ROOT/m[1]).read_text()+'</style>',base)
base=re.sub(r'<script src="([^"]+)"></script>',lambda m:'<script>'+(ROOT/m[1]).read_text()+'</script>',base)
# Use the already-shipped offline icon fallback when the CDN is not available.

errors=[];results=[]
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE') or shutil.which('chromium'),args=['--no-sandbox'])
  def client(subject,storage=None,initial_cookie="",offline=False):
   jar={'cookie':initial_cookie,'offline':offline}; lock=threading.Lock();ctx=browser.new_context(viewport={'width':390,'height':844});page=ctx.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
   def bridge(url,options=None):
    
    if jar['offline']:return {'status':503,'data':{'error':'SERVICE_UNAVAILABLE'}}
    options=options or {}; path=re.sub(r'^https?://[^/]+','',str(url))
    if not path.startswith('/'):return {'status':503,'data':{'error':'SERVICE_UNAVAILABLE'}}
    headers=dict(options.get('headers',{}));headers['Origin']=origin
    if jar['cookie']:headers['Cookie']=jar['cookie']
    body=options.get('body');req=urllib.request.Request(origin+path,data=body.encode() if body is not None else None,headers=headers,method=options.get('method','GET'))
    try:
     res=urllib.request.urlopen(req,timeout=8);status=res.status;data=res.read();cookie=res.headers.get('Set-Cookie')
    except urllib.error.HTTPError as e:status=e.code;data=e.read();cookie=e.headers.get('Set-Cookie')
    if cookie:jar['cookie']=cookie.split(';')[0]
    try:data=json.loads(data)
    except:data={}
    return {'status':status,'data':data}
   page.expose_function('__bridge',bridge)
   shim='<script>Object.defineProperty(window,"localStorage",{value:{data:'+json.dumps(storage or {})+',getItem(k){return this.data[k]??null},setItem(k,v){this.data[k]=String(v)},removeItem(k){delete this.data[k]}}});window.fetch=async(url,options={})=>{const r=await __bridge(url,{...options,headers:Object.fromEntries(new Headers(options.headers||{}))});return new Response(JSON.stringify(r.data),{status:r.status,headers:{"Content-Type":"application/json"}});};window.MegaNativeIdentity={getCredential:async({provider,nonce})=>{const r=await fetch("/__test__/token",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({provider,nonce,subject:'+json.dumps(subject)+'})});return r.json();}};</script>'
   html=base.replace('<body>','<body>'+shim)
   page.set_content(html,wait_until='domcontentloaded');return page,jar
  a,ja=client('alice');b,jb=client('bob')
  a.locator('#identityScreen.signin').wait_for(timeout=10000)
  # Real new screens and four theme CSS variants. No new font download in this test.
  output=ROOT/'tests-output';output.mkdir(exist_ok=True)
  for theme in ['vector','midnight','paperclub','afterhours']:
   a.evaluate('(theme)=>{const s=MegaApp.getSave();s.settings.theme=theme;MegaApp.applyPractice(s);}',theme)
   a.wait_for_timeout(100)
   assert a.evaluate('document.documentElement.scrollWidth<=innerWidth')
   assert a.locator('.theme-loader span').count()>=9
   a.screenshot(path=str(output/('signin-'+theme+'.png')))
  results.append('four themed sign-in surfaces and CSS loaders at 390px')
  # Guest transition must not spin-lock the MutationObserver/Lucide loop.
  a.evaluate("""()=>{window.__realIconRefresh=MegaIcons.refresh;window.__iconRefreshProbe=0;MegaIcons.refresh=()=>{window.__iconRefreshProbe++;const n=document.querySelector('[data-lucide]');if(n)n.replaceWith(n.cloneNode(true));return true;};}""")
  a.locator('[data-c="guest"]').click();a.wait_for_timeout(350)
  refresh_a=a.evaluate('window.__iconRefreshProbe');a.wait_for_timeout(350);refresh_b=a.evaluate('window.__iconRefreshProbe')
  assert refresh_b==refresh_a,(refresh_a,refresh_b)
  assert refresh_b<12,refresh_b
  assert a.evaluate('document.querySelector("#page") && !document.querySelector("#identityScreen")')
  a.evaluate("""()=>{MegaIcons.refresh=window.__realIconRefresh;delete window.__realIconRefresh;delete window.__iconRefreshProbe;MegaIcons.refresh();}""")
  results.append('guest dismissal remains responsive with a mutation-producing icon refresh')
  # Settings decoration must be idempotent for guests as well as linked profiles.
  a.locator('#settingsButton').click();a.locator('#sheet[data-kind="settings"]').wait_for(timeout=3000)
  assert a.locator('#sheet .community-profile-cta').count()==1
  a.wait_for_timeout(700);assert a.locator('#sheet .community-profile-cta').count()==1
  a.locator('#sheetClose').click();assert not a.locator('#sheet').get_attribute('data-kind')
  results.append('guest settings stays at one profile CTA and close clears sheet kind')
  # Private rooms must open before any online-account readiness check.
  a.locator('[data-action="mode"][data-value="private"]').click();a.locator('[data-action="start"]').click()
  a.locator('#partyScreen[data-view="hub"]').wait_for(timeout=3000)
  assert 'One device' in a.locator('#partyBody').inner_text()
  a.locator('[data-party="back"]').click();a.locator('[data-action="mode"][data-value="bot"]').click()
  results.append('guest can reach free Private Rooms without online readiness')
  # Guest starts real offline game without creating a cloud account.
  a.locator('[data-action="start"]').first.click();a.locator('#board .cell:not([disabled])').first.click();a.wait_for_timeout(1600)
  assert a.evaluate('MegaXO.getState().moves.length')>=2
  a.locator('[data-action="leave"]').click();a.locator('#sheet [data-action="home"]').click()
  assert a.evaluate('JSON.parse(localStorage.getItem("mega_v32_state")).records.length')==0
  results.append('guest offline play and unchanged bot reply')
  # Sign in via verified native tokens from the fixture provider key.
  for page,name in [(a,'alice'),(b,'bob')]:
   if not page.locator('#identityScreen.signin').count():page.evaluate('MegaCommunity.login()')
   page.locator('[data-c="signin"][data-id="google"]').click()
   page.locator('[data-c="edit"]').wait_for(timeout=10000);page.locator('[data-c="edit"]').click()
   page.locator('#cUsername').fill(name);page.locator('#cDisplayName').fill(name.title());page.locator('[data-c="saveprofile"]').click()
   page.locator('#identityScreen.profile').wait_for();page.locator('[data-c="dismiss"]').click()
   page.locator('[data-action="nav"][data-value="friends"]').click()
   page.locator('#cQuery').wait_for(timeout=5000)
  results.append('two real accounts with unique usernames, tags and profile edit')
  a.locator('#settingsButton').click();a.locator('#sheet[data-kind="settings"]').wait_for();assert not a.locator('#setting-notifications').is_checked();assert a.locator('#setting-notifyMatches').is_disabled();assert a.locator('#setting-notifySocial').is_disabled();assert a.locator('#setting-notifyRewards').is_disabled();a.locator('#sheetClose').click()
  results.append('notification groups are opt-in and disabled by default')
  a.locator('#cQuery').fill('bob');a.locator('#cSearch button').click();a.locator('.friend-person').last.click();a.locator('[data-c="social"]').first.click();a.locator('[data-c="social"][data-id^="cancel:"]').wait_for(timeout=5000);a.locator('[data-c="dismiss"]').click()
  b.evaluate('MegaCommunity.refresh()');b.locator('#notificationBadge:not([hidden])').wait_for(timeout=5000);b.locator('#notificationButton').click();b.locator('#sheet[data-kind="notifications"] .notification-group').wait_for();assert 'friend request' in b.locator('#sheet[data-kind="notifications"]').inner_text().lower();b.locator('[data-c="open-friends"]').click();b.locator('[data-c="social"][data-id^="accept:"]').wait_for(timeout=5000);b.locator('[data-c="social"][data-id^="accept:"]').click()
  a.evaluate('MegaCommunity.refresh()');a.locator('.friend-person').last.click();a.locator('[data-c="challenge"]').click()
  a.locator('#challengeRated').select_option('false');a.locator('[data-action="sendchallenge"]').click()
  a.locator('#sheet[data-kind="waiting"] .theme-loader').wait_for(timeout=5000);assert 'Opponent pays' not in a.locator('#sheet[data-kind="waiting"]').inner_text() or 'Free' in a.locator('#sheet[data-kind="waiting"]').inner_text()
  b.evaluate('MegaCommunity.refresh()');b.locator('#notificationBadge:not([hidden])').wait_for(timeout=5000);b.locator('#notificationButton').click();b.locator('#sheet[data-kind="notifications"] [data-c="review"]').wait_for(timeout=5000)
  for theme in ['vector','midnight','paperclub','afterhours']:
   b.evaluate('(theme)=>{const s=MegaApp.getSave();s.settings.theme=theme;MegaApp.applyPractice(s);}',theme)
   assert b.evaluate('document.querySelector("#sheet").scrollWidth <= document.querySelector("#sheet").clientWidth + 1')
   assert b.evaluate('document.querySelector(".topbar").scrollWidth <= document.querySelector(".topbar").clientWidth + 1')
   b.screenshot(path=str(output/('notifications-'+theme+'.png')))
  b.locator('#sheet[data-kind="notifications"] [data-c="review"]').click();b.locator('[data-action="acceptinvite"]').click()
  a.locator('#gameScreen:not([hidden])').wait_for(timeout=5000);b.locator('#gameScreen:not([hidden])').wait_for(timeout=5000)
  first=a if a.locator('#board .cell:not([disabled])').count() else b
  other=b if first==a else a
  before=first.locator('#boardWrap').bounding_box();first.locator('#board .cell:not([disabled])').first.click();other.locator('#board .cell:not([disabled])').first.wait_for(timeout=5000);other.locator('#board .cell:not([disabled])').first.click()
  assert first.locator('#boardWrap').bounding_box()==before
  results.append('friend search -> notification -> accept -> challenge notification -> accept -> real board moves across all themes')
  a.locator('[data-action="matchstats"]').click();a.locator('#sheet [data-action="resign"]').click();a.locator('[data-action="resignyes"]').click()
  a.locator('[data-action="home"]').wait_for(timeout=5000);a.locator('[data-action="home"]').click()
  b.locator('[data-action="home"]').wait_for(timeout=5000);b.locator('[data-action="home"]').click()
  a.locator('[data-action="nav"][data-value="friends"]').click();a.locator('.friend-person').last.click();a.locator('[data-c="statsmode"][data-id="friend"]').click()
  assert a.locator('#identityScreen .stat').first.locator('strong').inner_text()=='1'
  results.append('friend stats reflect actual completed match')
  a.locator('[data-c="dismiss"]').click();a.locator('#navigation [data-action="nav"][data-value="play"]').click();a.locator('[data-action="mode"][data-value="online"]').click();a.locator('[data-action="onlinetype"][data-value="casual"]').click();a.locator('[data-action="start"]').click()
  a.locator('#sheet[data-kind="queue"] .theme-loader').wait_for(timeout=5000)
  for theme in ['vector','midnight','paperclub','afterhours']:
   a.evaluate('(theme)=>{const s=MegaApp.getSave();s.settings.theme=theme;MegaApp.applyPractice(s);}',theme)
   a.screenshot(path=str(output/('queue-'+theme+'.png')))
  a.locator('[data-action="cancelqueue"]').click()
  results.append('casual queue loading in all four themes and cancellation')
  # One-device lobby loading uses actual roster counts, not fake participants.
  a.locator('[data-action="mode"][data-value="private"]').click();a.locator('[data-action="start"]').click();a.locator('[data-party="local"]').click();a.locator('#partyNames').fill('Alice\nBob\nCara\nDan');a.locator('[data-party="createRoom"]').click()
  a.locator('.lobby-wait').wait_for(timeout=5000);assert '4 joined' in a.locator('.lobby-wait').inner_text()
  a.screenshot(path=str(output/'lobby-afterhours.png'));a.locator('[data-party="back"]').click()
  results.append('private lobby shows four real local participants and waiting animation')
  a.evaluate('MegaCommunity.openProfile()');a.locator('[data-c="sync"]').click();a.wait_for_timeout(500)
  assert a.evaluate('MegaCommunity.getStatus().syncState')=='saved'
  for width,height in [(320,568),(390,844),(768,1024)]:
   a.set_viewport_size({'width':width,'height':height});assert a.evaluate('document.documentElement.scrollWidth<=innerWidth')
  # Cold-start offline edits belong to the known owner and must sync after reconnect.
  persisted=a.evaluate('localStorage.data');owner=a.evaluate('JSON.parse(localStorage.getItem("mega_v333_owner"))')
  original_revision=a.evaluate('JSON.parse(localStorage.getItem("mega_v333_sync")).revision')
  cookie=ja['cookie'];a.close()
  offline_client,offline_jar=client('alice',persisted,cookie,True)
  offline_client.wait_for_function('MegaCommunity.getStatus().syncState === "offline" && !document.querySelector("#identityScreen")')
  offline_client.evaluate("""()=>{const data=MegaApp.getSave();data.settings.theme='paperclub';data.records.push({id:'cold-start-practice',mode:'bot',difficulty:'Easy',result:'win',activeSeconds:44,moves:15,reason:'line'});MegaApp.applyPractice(data);}""")
  metadata=offline_client.evaluate('JSON.parse(localStorage.getItem("mega_v333_sync"))')
  assert metadata['actor']==owner and metadata['dirty'] and metadata['revision']==original_revision
  offline_jar['offline']=False;offline_client.evaluate('window.dispatchEvent(new Event("online"))')
  offline_client.wait_for_function('MegaCommunity.getStatus().linked && MegaCommunity.getStatus().syncState === "saved"',timeout=10000)
  cloud=offline_client.evaluate('MegaAccount.request("/api/account/save")')
  assert cloud['practice']['settings']['theme']=='paperclub'
  assert any(r['id']=='cold-start-practice' for r in cloud['practice']['records'])
  tag=offline_client.evaluate('MegaAccount.peek().profile.tag')
  results.append('offline cold-start preserves pending revision and syncs after reconnect')
  # A fresh device recovers the same tag, stats archive and chosen theme.
  recovered,recovered_jar=client('alice')
  recovered.locator('#identityScreen.signin').wait_for(timeout=10000)
  recovered.locator('[data-c="signin"][data-id="google"]').click()
  recovered.wait_for_function('MegaCommunity.getStatus().linked && MegaCommunity.getStatus().syncState === "saved"',timeout=10000)
  assert recovered.evaluate('MegaAccount.peek().profile.tag')==tag
  assert recovered.evaluate('MegaApp.getSave().settings.theme')=='paperclub'
  assert recovered.evaluate('MegaApp.getSave().records.some(r=>r.id==="cold-start-practice")')
  recovered.evaluate('MegaCommunity.openProfile()');recovered.locator('[data-c="connections"]').click()
  assert recovered.locator('[data-c="unlink"]').is_disabled()
  recovered.locator('[data-c="signin"][data-id="apple"][data-intent="link"]').click()
  recovered.wait_for_function('MegaAccount.peek()?.profile?.providers?.includes("apple")',timeout=10000)
  assert recovered.evaluate('MegaAccount.peek().profile.tag')==tag
  results.append('new device restores the same profile and Apple linking preserves its tag and progress')
  # Selecting an unrelated new profile never silently imports another account's practice.
  inherited=recovered.evaluate('localStorage.data')
  stranger,stranger_jar=client('charlie',inherited)
  stranger.locator('#identityScreen.signin').wait_for(timeout=10000)
  stranger.locator('[data-c="signin"][data-id="google"]').click()
  stranger.locator('#identityScreen.conflict').wait_for(timeout=10000)
  assert 'Start fresh for this profile' in stranger.locator('#identityScreen').inner_text()
  stranger.locator('[data-c="restore-choice"]').click()
  stranger.wait_for_function('MegaCommunity.getStatus().syncState === "saved"',timeout=10000)
  assert stranger.evaluate('MegaApp.getSave().records.length')==0
  assert stranger.evaluate('MegaAccount.peek().profile.tag')!=tag
  assert len(stranger.evaluate('MegaAccount.request("/api/account/save")')['practice']['records'])==0
  assert any(r['id']=='cold-start-practice' for r in stranger.evaluate('JSON.parse(localStorage.getItem("mega_v333_archive:"+%s))' % json.dumps(owner))['records'])
  results.append('profile switch requires explicit practice choice; displaced progress is archived')
  assert not errors,errors
  print(json.dumps({'passed':results,'pageErrors':errors,'limitations':'set_content + authenticated HTTP bridge; provider tokens signed by fixture RSA keys; no live Google/Apple consent or native build'},indent=2))
  browser.close()
finally:
 server.terminate();server.wait(timeout=5)
