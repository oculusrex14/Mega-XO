"""V3.5.1 Chromium + actual HTTP/SQLite; test-only native providers.
Loopback browser navigation is blocked here, so assets are inlined unchanged and
browser requests bridge to the real local server with a per-browser cookie jar.
No production ad SDK, real payment or font/pixel-equivalence claim is made.
"""
import json, os, re, socket, subprocess, urllib.request, urllib.error, shutil
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close()
server=subprocess.Popen(['node',str(ROOT/'tests/monetization-browser-server.js'),str(port)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
origin=server.stdout.readline().strip();assert origin.startswith('http://')
html=(ROOT/'index.html').read_text()
html=re.sub(r'<link[^>]+href="https:[^"]+"[^>]*>','',html)
html=re.sub(r'<script src="https:[^"]+"[^>]*></script>','',html)
html=re.sub(r'<link rel="stylesheet" href="([^"]+)">',lambda m:'<style>'+(ROOT/m[1]).read_text()+'</style>',html)
html=re.sub(r'<script src="([^"]+)"></script>',lambda m:'<script>'+(ROOT/m[1]).read_text()+'</script>',html)
errors=[];checks=[];jar={'cookie':''}
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE') or shutil.which('chromium'),headless=True,args=['--no-sandbox'])
  page=browser.new_page(viewport={'width':390,'height':844});page.on('pageerror',lambda e:errors.append(str(e)))
  def bridge(url,options=None):
   options=options or {};path=re.sub(r'^https?://[^/]+','',str(url));headers=dict(options.get('headers',{}));headers['Origin']=origin
   if jar['cookie']:headers['Cookie']=jar['cookie']
   body=options.get('body');req=urllib.request.Request(origin+path,data=body.encode() if body is not None else None,headers=headers,method=options.get('method','GET'))
   try:
    res=urllib.request.urlopen(req,timeout=8);status=res.status;raw=res.read();cookie=res.headers.get('Set-Cookie')
   except urllib.error.HTTPError as e:status=e.code;raw=e.read();cookie=e.headers.get('Set-Cookie')
   if cookie:jar['cookie']=cookie.split(';')[0]
   return {'status':status,'data':json.loads(raw)}
  page.expose_function('__bridge',bridge)
  shim='''<script>
  Object.defineProperty(window,'localStorage',{value:{data:{},getItem(k){return this.data[k]??null},setItem(k,v){this.data[k]=String(v)},removeItem(k){delete this.data[k]}}});
  window.fetch=async(url,options={})=>{const r=await __bridge(url,{...options,headers:Object.fromEntries(new Headers(options.headers||{}))});return new Response(JSON.stringify(r.data),{status:r.status,headers:{'Content-Type':'application/json'}});};
  const fixture=async(path,body)=>{const r=await fetch('/__test__/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});return r.json();};
  window.MegaNativeIdentity={getCredential:async({provider,nonce})=>fixture('token',{provider,nonce,subject:'alice'})};
  window.__purchases=0;window.__ads=0;window.__privacy=false;window.__ready={};
  window.MegaBilling={products:async()=>[{id:'crowns_100',price:'$0.99 TEST'},{id:'crowns_525',price:'$4.99 TEST'},{id:'crowns_1100',price:'$9.99 TEST'},{id:'remove_ads',price:'$3.99 TEST'}],purchase:async id=>{__purchases++;return (await fixture('buy',{productId:id})).evidence;},restore:()=>fixture('restore')};
  window.MegaAds={privacyState:()=>({canRequestAds:__privacy}),privacyOptions:async()=>{__privacy=true;},isReady:kind=>__ready[kind]===true,prepare:async kind=>{__ready[kind]=true;},showRewarded:async ticket=>{__ads++;const r=await fixture('ad',ticket);await fetch('/api/monetization/admob-ssv?'+r.query);return {shown:true,completed:true};},showInterstitial:async()=>{__ads++;return {shown:true};},reportAd:async()=>{}};
  </script>'''
  page.set_content(html.replace('<body>','<body>'+shim),wait_until='domcontentloaded')

  assert page.locator('[data-c="email-form"]').count()==1
  assert page.locator('[data-c="email-form"][data-id="continue"]').inner_text()=='Continue with email'
  page.locator('[data-c="email-form"][data-id="continue"]').click(timeout=10000)
  page.locator('#cEmailAddress').fill('alice@example.com')
  page.locator('#cEmailPassword').fill('correct-horse-42')
  assert page.locator('#cEmailPasswordConfirm').count()==0
  page.locator('[data-c="email-submit"][data-id="continue"]').click()
  page.locator('#cEmailOtp').wait_for(timeout=10000)
  otp=page.evaluate('fetch("/__test__/otp",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}).then(r=>r.json())')
  assert otp['purpose']=='signup' and otp['to']=='alice@example.com'
  page.locator('#cEmailOtp').fill(otp['code'])
  page.locator('[data-c="email-otp"]').click()
  page.locator('#identityScreen.profile').wait_for(timeout=10000)
  assert page.locator('button[data-c="edit"]').count()==1
  page.locator('button[data-c="edit"]').click()
  page.locator('#cUsername').fill('alice_xo')
  page.locator('#cDisplayName').fill('Alice')
  page.locator('[data-c="saveprofile"]').click()
  page.wait_for_function('document.querySelector("#identityScreen")?.innerText.includes("@alice_xo")')
  checks.append('single Continue with email button sends OTP, verifies ownership, creates the profile and allows username editing')
  page.locator('[data-c="dismiss"]').click()

  page.evaluate('MegaApp.goFriends()')
  page.wait_for_function('document.querySelector("#page")?.innerText.includes("Friends")')
  assert 'View / edit your profile' in page.locator('#page').inner_text()
  checks.append('Friends page exposes the signed-in self profile as a view/edit destination')

  page.evaluate('MegaMonetizationUI.open()')
  page.locator('#sheet[data-kind="monetization"]').wait_for()
  assert page.locator('.mono-frame').count()==0
  assert 'Board-frame collection archived' not in page.locator('#sheetBody').inner_text()
  assert 'V3.5.1' not in page.locator('#sheetBody').inner_text()
  assert 'future theme' not in page.locator('#sheetBody').inner_text().lower()
  assert page.locator('.mono-balance strong').inner_text()=='0'
  checks.append('Rewards & Themes presents player-facing rewards with no archived-feature or roadmap commentary')
  output=ROOT/'tests-output';output.mkdir(exist_ok=True)
  for theme in ['vector','midnight','paperclub','afterhours']:
   page.evaluate('(theme)=>{const s=MegaApp.getSave();s.settings.theme=theme;MegaApp.applyPractice(s);}',theme)
   for width in [320,390,768]:
    page.set_viewport_size({'width':width,'height':844})
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    assert page.evaluate('document.querySelector("#sheet").scrollWidth<=document.querySelector("#sheet").clientWidth+1')
   page.set_viewport_size({'width':390,'height':844});page.screenshot(path=str(output/('v351-'+theme+'.png')))
  checks.append('Rewards & Themes stays responsive across all four retained themes')

  page.locator('[data-monetization="prepare"]').click()
  page.wait_for_function('!document.querySelector("[data-monetization=reward]").disabled')
  page.locator('[data-monetization="reward"][data-value="credits"]').click();page.locator('[data-monetization="watch"]').click()
  page.wait_for_function('document.querySelector(".mono-balance strong")?.textContent === "5"')
  wallet=page.evaluate('MegaAccount.request("/api/v1/profile")')['wallet'];assert wallet['coins']==150 and wallet['crowns']==0
  assert page.evaluate('__ads')==1
  page.evaluate('MegaCommunity.openProfile()')
  page.wait_for_function('document.querySelector("#identityScreen")?.innerText.includes("Cosmetic Credits")')
  assert page.locator('#identityScreen').inner_text().count('Cosmetic Credits')>=1
  assert 'saved for future themes' not in page.locator('#identityScreen').inner_text()
  checks.append('verified rewarded ad grants 5 account-bound credits and self profile shows the same balance')
  page.locator('[data-c="dismiss"]').click()

  page.evaluate('MegaMonetizationUI.open()')
  assert page.locator('[data-monetization="review"][data-value="starter_100"]').count()==0
  assert page.locator('[data-monetization="review"][data-value="style_collection"]').count()==0
  before=page.evaluate('__purchases')
  page.locator('[data-monetization="review"][data-value="remove_ads"]').click()
  assert page.evaluate('__purchases')==before
  assert 'Optional rewarded ads' in page.locator('#sheetBody').inner_text()
  page.locator('[data-monetization="confirm"]').click()
  page.wait_for_function('document.querySelector("[data-monetization=review][data-value=remove_ads]")?.textContent === "Owned"')
  page.locator('[data-monetization="review"][data-value="crowns_100"]').click()
  page.locator('[data-monetization="confirm"]').click()
  page.wait_for_function('window.__purchases === 2')
  wallet=page.evaluate('MegaAccount.request("/api/v1/profile")')['wallet'];assert wallet['crowns']==100
  page.locator('[data-monetization="restore"]').click();page.wait_for_function('!document.querySelector("[data-monetization=restore]").disabled')
  state=page.evaluate('MegaAccount.request("/api/monetization/status")');wallet=page.evaluate('MegaAccount.request("/api/v1/profile")')['wallet']
  assert state['removeAds'] and state['credits']==5 and wallet['crowns']==100
  checks.append('shop exposes Crown packs and Remove Ads only; restore does not duplicate consumable Crowns')

  page.screenshot(path=str(output/'v351-account.png'))
  assert not errors,errors
  print(json.dumps({'checks':checks,'pageErrors':errors},indent=2))
  browser.close()
finally:
 server.terminate();server.wait(timeout=5)
