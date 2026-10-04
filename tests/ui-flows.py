import os, shutil
from pathlib import Path
from playwright.sync_api import sync_playwright
import json
ROOT=Path(__file__).resolve().parents[1]
def document(storage=None):
 text=(ROOT/'index.html').read_text()
 text=text.replace('<link rel="preconnect" href="https://fonts.googleapis.com">','').replace('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>','').replace('<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600&family=Space+Grotesk:wght@500;600;700&family=Caveat:wght@600;700&family=Patrick+Hand&family=Orbitron:wght@600;800&family=Chakra+Petch:wght@400;500;600;700&family=Share+Tech+Mono&display=swap" rel="stylesheet">','').replace('<link rel="stylesheet" href="src/styles.css">','<style>'+(ROOT/'src/styles.css').read_text()+'</style>')
 shim='<script>Object.defineProperty(window,"localStorage",{value:{data:'+json.dumps(storage or {})+',getItem(k){return this.data[k]??null},setItem(k,v){this.data[k]=String(v)}}});</script>'
 text=text.replace('<script src="src/game.js"></script>',shim+'<script>'+(ROOT/'src/game.js').read_text()+'</script>')
 for n in ['domain','icons','app']:text=text.replace('<script src="src/'+n+'.js"></script>','<script>'+(ROOT/('src/'+n+'.js')).read_text()+'</script>')
 return text
with sync_playwright() as p:
 b=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE') or shutil.which('chromium'),args=['--no-sandbox']);page=b.new_page(viewport={'width':390,'height':844});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.set_content(document({'mega_v32_tutorial_seen':'1'}))
 fixture=page.evaluate('''()=>{const d=MegaDomain.fresh();d.records=[{id:'a',mode:'bot',difficulty:'Medium',result:'win',activeSeconds:60,at:Date.now()},{id:'b',mode:'bot',difficulty:'Medium',result:'loss',activeSeconds:120,at:Date.now()}];d.playSeconds={'bot:all':180,'bot:Medium':180};const daily=MegaDomain.getDaily(d);daily.finished=3;return d;}''')
 page.goto('about:blank');page.set_content(document({'mega_v32_tutorial_seen':'1','mega_v32_state':json.dumps(fixture)}))
 page.locator('[data-action="nav"][data-value="stats"]').last.click()
 for text in ['50.0%','1:30','0.05']:assert text in page.locator('#page').inner_text()
 page.locator('[data-action="statmode"][data-value="ranked"]').click();assert page.locator('.stat').first.inner_text()=='Win rate\n--'
 page.locator('[data-action="nav"][data-value="play"]').last.click();page.locator('[data-action="nav"][data-value="quests"]').click()
 page.locator('[data-action="claim"][data-value="finish"]').click();assert page.locator('#walletAmount').inner_text()=='105'
 assert page.locator('[data-action="claim"][data-value="finish"]').is_disabled()
 page.locator('[data-action="claim"][data-value="three"]').click();assert page.locator('#walletAmount').inner_text()=='120'
 page.locator('[data-action="wallet"]').first.click();page.locator('[data-action="cosmetic"][data-value="Orbit frame"]').click();assert page.locator('#walletAmount').inner_text()=='60'
 page.locator('[data-action="cosmetic"][data-value="Orbit frame"]').click();assert page.locator('#walletAmount').inner_text()=='60'
 page.locator('#sheetClose').click()
 page.locator('[data-action="nav"][data-value="rank"]').last.click();page.locator('[data-action="demo"]').click();assert page.locator('.standing').count()==20
 page.locator('#rankLeague').select_option('gold');assert page.locator('.standing').count()==20
 page.locator('#rankScope').select_option('local');assert page.locator('.standing').count()==16
 page.locator('.standing button').first.click();assert 'Winner net, before bonuses' in page.locator('#sheetBody').inner_text();assert '0 coins' in page.locator('#sheetBody').inner_text();page.locator('#sheetClose').click()
 page.locator('[data-action="nav"][data-value="friends"]').last.click();assert page.locator('.friend-code').inner_text().startswith('MEGA-');assert 'Your squad is empty' in page.locator('#page').inner_text()
 page.locator('[data-action="nav"][data-value="play"]').last.click();page.locator('[data-action="mode"][data-value="local"]').click();page.locator('[data-action="settimer"][data-value="30"]').click();page.locator('[data-action="start"]').click();page.wait_for_timeout(1500);before=page.locator('#clock').inner_text();page.locator('#matchSettings').click();page.wait_for_timeout(1800);page.locator('[data-action="theme"][data-value="midnight"]').click();page.locator('#sheetClose').click();assert before==page.locator('#clock').inner_text(),(before,page.locator('#clock').inner_text())
 page.locator('[data-action="leave"]').click();page.locator('[data-action="home"]').click()
 page.locator('[data-action="mode"][data-value="bot"]').click();page.locator('[data-action="first"][data-value="O"]').click();page.locator('[data-action="start"]').click();assert page.locator('.cell:not([disabled])').count()==0
 page.wait_for_function('MegaXO.getState().moves.length === 1',timeout=5000);assert page.evaluate('MegaXO.getState().moves[0].player')=='O'
 assert not errors,errors
 print('PASS: mode stats, timing, quests, duplicate claims, cosmetic purchase idempotence, top-20/country/league filters, friend and leaderboard quotes, theme-clock preservation, bot-first opening; no console errors.')
 b.close()
