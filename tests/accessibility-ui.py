"""Headless accessibility release gate for the shipped static client.
This complements, but does not replace, physical VoiceOver/TalkBack acceptance.
"""
import json, os, re, shutil
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
html=(ROOT/'index.html').read_text()
html=re.sub(r'<link[^>]+href="https:[^"]+"[^>]*>','',html)
html=re.sub(r'<script src="https:[^"]+"[^>]*></script>','',html)
html=re.sub(r'<link rel="stylesheet" href="([^"]+)">',lambda m:'<style>'+(ROOT/m[1]).read_text()+'</style>',html)
html=re.sub(r'<script src="([^"]+)"></script>',lambda m:'<script>'+(ROOT/m[1]).read_text()+'</script>',html)

shim=r'''<script>
Object.defineProperty(window,'localStorage',{value:{data:{},getItem(k){return this.data[k]??null},setItem(k,v){this.data[k]=String(v)},removeItem(k){delete this.data[k]}}});
window.fetch=async()=>new Response(JSON.stringify({error:'SERVICE_UNAVAILABLE'}),{status:503,headers:{'Content-Type':'application/json'}});
</script>'''
html=html.replace('<body>','<body>'+shim)
results=[];errors=[]

def contrast_ratio(page,fg,bg):
 return page.evaluate("""([fg,bg])=>{
   const parse=value=>{value=value.trim();if(value.startsWith('#')){let h=value.slice(1);if(h.length===3)h=[...h].map(x=>x+x).join('');return [0,2,4].map(i=>parseInt(h.slice(i,i+2),16));}
     const m=value.match(/rgba?\\(([^)]+)\\)/);if(!m)throw new Error('UNSUPPORTED_COLOR:'+value);return m[1].split(',').slice(0,3).map(Number);};
   const lum=value=>{const rgb=parse(value).map(x=>x/255).map(x=>x<=.03928?x/12.92:Math.pow((x+.055)/1.055,2.4));return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];};
   const a=lum(fg),b=lum(bg),hi=Math.max(a,b),lo=Math.min(a,b);return (hi+.05)/(lo+.05);
 }""",[fg,bg])

with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE') or shutil.which('chromium'),headless=True,args=['--no-sandbox'])
 page=browser.new_page(viewport={'width':390,'height':844})
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.set_content(html,wait_until='domcontentloaded')
 page.locator('[data-c="guest"]').wait_for(timeout=10000)
 page.locator('[data-c="guest"]').click()
 page.locator('#page').wait_for(timeout=5000)

 # Every visible button must have an accessible name.
 unnamed=page.evaluate("""()=>[...document.querySelectorAll('button:not([hidden])')].filter(b=>b.getClientRects().length&&!((b.getAttribute('aria-label')||'').trim()||(b.textContent||'').trim())).map(b=>b.outerHTML.slice(0,180))""")
 assert not unnamed,unnamed
 results.append('visible buttons expose text or aria-label accessible names')

 # Keyboard opening, focus trap, Escape close and restoration for the app dialog.
 page.locator('#settingsButton').focus()
 page.keyboard.press('Enter')
 page.locator('#sheet[data-kind="settings"]').wait_for()
 page.wait_for_timeout(50)
 assert page.evaluate("document.activeElement===document.querySelector('#sheetClose')")
 assert page.locator('#sheet').get_attribute('role')=='dialog'
 assert page.locator('#sheet').get_attribute('aria-modal')=='true'
 for _ in range(35):
  page.keyboard.press('Tab')
  assert page.evaluate("document.querySelector('#sheet').contains(document.activeElement)")
 page.keyboard.press('Escape')
 page.wait_for_function("document.querySelector('#sheet').hidden===true")
 page.wait_for_timeout(50)
 assert page.evaluate("document.activeElement===document.querySelector('#settingsButton')")
 results.append('settings dialog traps keyboard focus, closes with Escape and restores invoking focus')

 # Minimum target size: WCAG 2.2 AA minimum 24x24 for visible interactive targets.
 violations=page.evaluate("""()=>[...document.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled])')].filter(x=>x.getClientRects().length).map(x=>{const r=x.getBoundingClientRect();return {tag:x.tagName,id:x.id,cls:x.className,w:r.width,h:r.height}}).filter(x=>x.w<24||x.h<24)""")
 assert not violations,violations
 for selector in ['.topbar button','.bottom-nav button']:
  sizes=page.locator(selector).evaluate_all("(els)=>els.filter(x=>x.getClientRects().length).map(x=>{const r=x.getBoundingClientRect();return [r.width,r.height]})")
  assert all(w>=44 and h>=44 for w,h in sizes),(selector,sizes)
 results.append('interactive targets meet 24px AA minimum; primary navigation controls meet 44px')

 # Board cells remain keyboard-addressable and announce board/cell/value state.
 page.locator('[data-action="mode"][data-value="bot"]').click()
 page.locator('[data-action="start"]').first.click()
 enabled=page.locator('#board .cell:not([disabled])')
 assert enabled.count()>0
 cell=enabled.first
 label=cell.get_attribute('aria-label')
 rect=cell.bounding_box()
 assert label and 'board' in label.lower() and 'cell' in label.lower(),label
 assert rect['width']>=24 and rect['height']>=24,rect
 cell.focus();page.keyboard.press('Enter')
 page.wait_for_timeout(50)
 assert page.evaluate("MegaXO.getState().moves.length")>=1
 results.append('game cells have spoken location/value labels, >=24px targets and keyboard activation')

 # Return home for responsive/theme checks.
 page.locator('[data-action="leave"]').click()
 page.locator('#sheet [data-action="home"]').click()
 page.set_viewport_size({'width':320,'height':844})
 themes=['vector','midnight','paperclub','afterhours']
 contrast={}
 for theme in themes:
  page.evaluate("(theme)=>{const s=MegaApp.getSave();s.settings.theme=theme;MegaApp.applyPractice(s);}",theme)
  page.wait_for_timeout(30)
  assert page.evaluate("document.documentElement.scrollWidth<=innerWidth")
  tokens=page.evaluate("""()=>{const s=getComputedStyle(document.documentElement),v=k=>s.getPropertyValue(k).trim();return {ink:v('--ink'),surface:v('--surface'),cta:v('--cta'),onCta:v('--on-cta'),accent:v('--accent'),onAccent:v('--on-accent')}}""")
  ratios={
    'ink/surface':contrast_ratio(page,tokens['ink'],tokens['surface']),
    'cta':contrast_ratio(page,tokens['onCta'],tokens['cta']),
    'accent':contrast_ratio(page,tokens['onAccent'],tokens['accent'])
  }
  assert min(ratios.values())>=4.5,(theme,ratios,tokens)
  contrast[theme]={k:round(v,2) for k,v in ratios.items()}
 results.append('all four themes reflow at 320 CSS px and retain >=4.5:1 core text/control contrast')

 # Connection state is page content, not a second sticky header. Verify all four themes.
 page.set_viewport_size({'width':320,'height':520})
 for theme in themes:
  page.evaluate("(theme)=>{const s=MegaApp.getSave();s.settings.theme=theme;MegaApp.applyPractice(s);}",theme)
  page.evaluate("""()=>document.dispatchEvent(new CustomEvent('mega:connectivity',{detail:{state:'degraded'}}))""")
  page.locator('#networkStatus').wait_for(state='visible')
  page.eval_on_selector('#contentScroll','el=>el.scrollTop=0')
  page.wait_for_timeout(20)
  header_before=page.locator('.topbar').bounding_box()
  status_before=page.locator('#networkStatus').bounding_box()
  action=page.locator('#networkStatusAction').bounding_box()
  assert action['height']>=44,(theme,action)
  colors=page.evaluate("""()=>{const card=getComputedStyle(document.querySelector('#networkStatus'));const copy=getComputedStyle(document.querySelector('#networkStatusText'));return {fg:copy.color,bg:card.backgroundColor};}""")
  assert contrast_ratio(page,colors['fg'],colors['bg'])>=4.5,(theme,colors)
  page.eval_on_selector('#contentScroll','el=>el.scrollTop=140')
  page.wait_for_timeout(20)
  header_after=page.locator('.topbar').bounding_box()
  status_after=page.locator('#networkStatus').bounding_box()
  assert page.eval_on_selector('#contentScroll','el=>el.scrollTop')>0,theme
  assert status_after['y']<status_before['y']-40,(theme,status_before,status_after)
  assert abs(header_after['y']-header_before['y'])<1,(theme,header_before,header_after)
  assert page.evaluate("document.documentElement.scrollWidth<=innerWidth"),theme
 page.evaluate("""()=>document.dispatchEvent(new CustomEvent('mega:connectivity',{detail:{state:'online'}}))""")
 page.set_viewport_size({'width':320,'height':844})
 page.eval_on_selector('#contentScroll','el=>el.scrollTop=0')
 results.append('connection status scrolls with page content, stays readable and reflows in all four themes')

 # Simulate enlarged default text while retaining the 320px reflow requirement.
 page.add_style_tag(content='html{font-size:200%!important} body,button,input,select{font-size:1rem!important}')
 assert page.evaluate("document.documentElement.scrollWidth<=innerWidth")
 results.append('320px layout remains horizontally contained with 200% inherited control text')

 # OS reduced motion must override animations independent of in-app preference.
 page.emulate_media(reduced_motion='reduce')
 duration=page.evaluate("""()=>{const n=document.createElement('div');n.className='route-path';document.body.append(n);const s=getComputedStyle(n);const out={animation:s.animationDuration,transition:s.transitionDuration};n.remove();return out;}""")
 def ms(value):
  part=value.split(',')[0].strip()
  return float(part[:-2]) if part.endswith('ms') else float(part[:-1])*1000 if part.endswith('s') else 0
 assert ms(duration['animation'])<=1 and ms(duration['transition'])<=1,duration
 results.append('prefers-reduced-motion suppresses route animation and transition timing')

 assert not errors,errors
 print(json.dumps({'checks':results,'contrast':contrast,'pageErrors':errors},indent=2))
 browser.close()
