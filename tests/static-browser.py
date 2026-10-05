from pathlib import Path
import socket, subprocess, sys, time
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]

def free_port():
    s=socket.socket();s.bind(('127.0.0.1',0));port=s.getsockname()[1];s.close();return port

def main():
    port=free_port()
    proc=subprocess.Popen([sys.executable,'-m','http.server',str(port),'--bind','127.0.0.1','--directory',str(ROOT)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        deadline=time.time()+5
        while time.time()<deadline:
            try:
                with socket.create_connection(('127.0.0.1',port),timeout=.2):break
            except OSError:time.sleep(.05)
        else:raise RuntimeError('static server did not start')
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True)
            page=browser.new_page(viewport={'width':390,'height':844})
            favicon_404=[]
            page.on('response',lambda r: favicon_404.append(r.url) if r.status==404 and r.url.endswith('/favicon.ico') else None)
            page.goto(f'http://127.0.0.1:{port}/',wait_until='domcontentloaded')
            page.locator('#identityScreen.signin').wait_for(timeout=10000)

            # Every sign-in theme uses the XO game animation; After Hours must not fall back
            # to the retired square/arcade-route animation.
            for theme in ['vector','midnight','paperclub','afterhours']:
                page.evaluate("""theme=>{const s=MegaApp.getSave();s.settings.theme=theme;MegaApp.applyPractice(s);}""",theme)
                page.wait_for_timeout(80)
                assert page.eval_on_selector('.xo-step-1 .xo-loader-mark','el=>getComputedStyle(el).animationName')=='xo-mark-1'
                assert page.eval_on_selector('.xo-loader-strike path','el=>getComputedStyle(el).animationName')=='xo-loader-strike'
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')

            page.locator('[data-c="guest"]').click()
            page.locator('#page').wait_for(timeout=3000)
            assert page.evaluate('1+1')==2

            # Theme-specific readability audit at phone width. Thresholds differ because
            # the four font families have very different apparent sizes.
            minimum={'vector':9.0,'midnight':9.5,'paperclub':11.0,'afterhours':10.0}
            for theme in ['vector','midnight','paperclub','afterhours']:
                page.evaluate("""theme=>{const s=MegaApp.getSave();s.settings.theme=theme;MegaApp.applyPractice(s);}""",theme)
                page.locator('[data-action="mode"][data-value="bot"]').click()
                page.wait_for_timeout(50)
                for selector in ['.setup-chip','.setup-title span','.mode-copy small','.nav-button']:
                    size=float(page.eval_on_selector(selector,'el=>parseFloat(getComputedStyle(el).fontSize)'))
                    assert size>=minimum[theme],(theme,selector,size)
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
                page.locator('#settingsButton').click()
                page.locator('#sheet[data-kind="settings"]').wait_for(timeout=3000)
                for selector in ['.setting-group h4','.setting-row small','.setting-row select']:
                    size=float(page.eval_on_selector(selector,'el=>parseFloat(getComputedStyle(el).fontSize)'))
                    assert size>=minimum[theme],(theme,selector,size)
                page.locator('#sheetClose').click()

            page.locator('#settingsButton').click()
            page.locator('#sheet[data-kind="settings"]').wait_for(timeout=3000)
            assert page.locator('#sheet .community-profile-cta').count()==1
            page.wait_for_timeout(900)
            assert page.locator('#sheet .community-profile-cta').count()==1
            page.locator('#sheetClose').click()
            assert page.locator('#sheet').get_attribute('data-kind') is None

            page.locator('[data-action="mode"][data-value="private"]').click()
            page.locator('[data-action="start"]').click()
            page.locator('#partyScreen[data-view="hub"]').wait_for(timeout=3000)
            assert 'One device' in page.locator('#partyBody').inner_text()
            page.locator('[data-party="back"]').click()

            # Tournaments behaves like every other mode: select first, open only from CTA.
            page.locator('[data-action="mode"][data-value="tournament"]').click()
            assert page.locator('#partyScreen').count()==0
            assert page.locator('[data-action="mode"][data-value="tournament"]').get_attribute('aria-pressed')=='true'
            assert 'Browse Tournaments' in page.locator('[data-action="start"]').inner_text()
            page.locator('[data-action="start"]').scroll_into_view_if_needed()
            page.locator('[data-action="start"]').click()
            page.locator('#partyScreen[data-view="tables"]').wait_for(timeout=3000)

            # Midnight selected-mode icon tile remains readable.
            page.locator('[data-party="back"]').click()
            page.evaluate("""()=>{const s=MegaApp.getSave();s.settings.theme='midnight';MegaApp.applyPractice(s);}""")
            page.locator('[data-action="mode"][data-value="bot"]').click()
            bg=page.eval_on_selector('.mode.active .mode-symbol',"el=>getComputedStyle(el).backgroundColor")
            fg=page.eval_on_selector('.mode.active .mode-symbol svg',"el=>getComputedStyle(el).color")
            assert bg!=fg,(bg,fg)

            # Newer tournament pages use their own per-theme type scale too.
            for theme in ['vector','midnight','paperclub','afterhours']:
                page.evaluate("""theme=>{const s=MegaApp.getSave();s.settings.theme=theme;MegaApp.applyPractice(s);}""",theme)
                page.locator('[data-action="mode"][data-value="tournament"]').click()
                page.locator('[data-action="start"]').scroll_into_view_if_needed()
                page.locator('[data-action="start"]').click()
                page.locator('#partyScreen[data-view="tables"]').wait_for(timeout=3000)
                floor={'vector':9.0,'midnight':9.5,'paperclub':11.0,'afterhours':9.5}[theme]
                for selector in ['.party-currency','.party-entry>span','.party-table-stats span','.party-table .button']:
                    size=float(page.eval_on_selector(selector,'el=>parseFloat(getComputedStyle(el).fontSize)'))
                    assert size>=floor,(theme,selector,size)
                assert page.evaluate('document.querySelector("#partyScreen").scrollWidth<=document.querySelector("#partyScreen").clientWidth+1')
                page.locator('[data-party="back"]').click()

            assert not favicon_404,favicon_404
            browser.close()
        print('static guest/settings/private/tournament/theme/favicon sweep: PASS')
    finally:
        proc.terminate()
        try:proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill();proc.wait()

if __name__=='__main__':
    main()
