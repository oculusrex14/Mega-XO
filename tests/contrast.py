import os, shutil
from pathlib import Path
from playwright.sync_api import sync_playwright
import re,json
ROOT=Path(__file__).resolve().parents[1]
css=(ROOT/'src/styles.css').read_text()
html='<html><head><style>'+css+'</style></head><body><div id="target"></div></body></html>'
def lum(v):
 h=v.strip().lstrip('#');cs=[int(h[i:i+2],16)/255 for i in (0,2,4)]
 cs=[x/12.92 if x<=.04045 else ((x+.055)/1.055)**2.4 for x in cs]
 return .2126*cs[0]+.7152*cs[1]+.0722*cs[2]
def ratio(a,b):
 l1,l2=sorted([lum(a),lum(b)])
 return (l2+.05)/(l1+.05)
report=[]
with sync_playwright() as p:
 b=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE') or shutil.which('chromium'),args=['--no-sandbox']);page=b.new_page();page.set_content(html)
 for theme in ['vector','dark','paper','neon']:
  page.evaluate('(x)=>document.documentElement.dataset.theme=x',theme)
  tokens=page.evaluate('''()=>{let out={};for(const n of ['ink','muted','surface','raised','soft','cta','on-cta','accent','on-accent','accent-soft','x','x-soft','o','o-soft'])out[n]=getComputedStyle(document.documentElement).getPropertyValue('--'+n).trim();return out;}''')
  for fg,bg,minimum in [('ink','surface',4.5),('ink','raised',4.5),('muted','surface',4.5),('muted','raised',4.5),('muted','soft',4.5),('on-cta','cta',4.5),('on-accent','accent',4.5),('x','x-soft',3),('o','o-soft',3),('x','soft',3),('o','soft',3)]:
   value=ratio(tokens[fg],tokens[bg]);assert value>=minimum,(theme,fg,bg,value)
   report.append({'theme':theme,'foreground':fg,'background':bg,'ratio':round(value,2),'minimum':minimum})
 b.close()
print(json.dumps(report,indent=2))
(ROOT/'.artifacts').mkdir(exist_ok=True)
(ROOT/'.artifacts/contrast-results.json').write_text(json.dumps(report,indent=2))
