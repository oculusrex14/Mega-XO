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
            page.locator('[data-c="guest"]').click()
            page.locator('#page').wait_for(timeout=3000)
            assert page.evaluate('1+1')==2

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
            assert not favicon_404,favicon_404
            browser.close()
        print('static guest/settings/private/favicon sweep: PASS')
    finally:
        proc.terminate()
        try:proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill();proc.wait()

if __name__=='__main__':
    main()
