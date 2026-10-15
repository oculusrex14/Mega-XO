#!/usr/bin/env python3
"""Package store key art with the unchanged approved brand; never synthesize app UI.
Uses Pillow and a system font for captions. No game/build/provider state is changed.
"""
from pathlib import Path
import hashlib, json
from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'assets/store/v5.2'
ART = OUT / 'key-art-source.png'
LOGO = ROOT / 'assets/p21/logos/mega-xoxo-horizontal-logo.png'
ICC = (ROOT / 'assets/p21/icons/native/srgb.icc').read_bytes()
FONT = Path('/System/Library/Fonts/Avenir Next.ttc')


def font(size, bold=False):
    # macOS Avenir Next: Bold=0, Medium=5. Raster output only; font not redistributed.
    return ImageFont.truetype(str(FONT), size, index=0 if bold else 5)


def background(size):
    return ImageOps.fit(Image.open(ART).convert('RGB'), size, method=Image.Resampling.LANCZOS, centering=(0.5, 0.52)).convert('RGBA')


def shade_left(im, strength=0.48):
    # Layout scrim, no semantic artwork or UI edits.
    overlay=Image.new('RGBA', im.size)
    d=ImageDraw.Draw(overlay)
    w,h=im.size
    for x in range(w):
        a=int(255*strength*max(0,1-x/(w*0.7)))
        d.line((x,0,x,h),fill=(2,7,22,a))
    return Image.alpha_composite(im,overlay)


def brand(im, x,y,width):
    logo=Image.open(LOGO).convert('RGBA')
    logo=logo.resize((width,round(width*logo.height/logo.width)),Image.Resampling.LANCZOS)
    im.alpha_composite(logo,(x,y))


def write(im, relative):
    p=OUT/relative;p.parent.mkdir(parents=True,exist_ok=True)
    # Apple and the Play feature graphic prohibit alpha, even if it is uniformly opaque.
    im.convert('RGB').save(p,icc_profile=ICC,optimize=True)
    return p


files=[]
# Separate, deliberately authored compositions for each aspect ratio.
header=shade_left(background((3840,1646)),0.50)
brand(header,260,510,1420)
d=ImageDraw.Draw(header)
d.text((320,1070),'Nine boards. One bigger game.',font=font(94,True),fill='#f0f5ff')
files.append(write(header,'apple/product-page-header-3840x1646.png'))

# A 3:2 search asset should say what the game is, even without screenshots.
search=Image.new('RGBA',(1920,1280),'#030917')
# Preserve both complete game pieces in the taller ratio, with quiet sky above.
landscape=Image.open(ART).convert('RGBA').resize((1920,960),Image.Resampling.LANCZOS)
fade=Image.new('L',landscape.size,255)
fd=ImageDraw.Draw(fade)
for y in range(160):
    fd.line((0,y,1920,y),fill=round(255*y/159))
landscape.putalpha(fade)
search.alpha_composite(landscape,(0,320))
search=shade_left(search,0.55)
brand(search,110,110,920)
d=ImageDraw.Draw(search)
d.text((135,500),'Ultimate',font=font(96,True),fill='#f0f5ff')
d.text((135,620),'Tic-tac-toe.',font=font(96,True),fill='#f0f5ff')
d.text((142,800),'Think one board ahead.',font=font(43),fill='#9cddff')
files.append(write(search,'apple/search-results-1920x1280.png'))

feature=shade_left(background((1024,500)),0.65)
brand(feature,58,70,424)
d=ImageDraw.Draw(feature)
d.text((70,248),'Nine boards.',font=font(46,True),fill='#f4f7ff')
d.text((70,309),'One bigger game.',font=font(46,True),fill='#f4f7ff')
files.append(write(feature,'play/feature-graphic-1024x500.png'))

# Review contact sheet is not a store upload.
thumbs=[]
for p in files:
    im=Image.open(p).convert('RGB')
    im.thumbnail((1100,735),Image.Resampling.LANCZOS)
    thumbs.append((p.name,im.copy()))
height=sum(im.height+80 for _,im in thumbs)+30
sheet=Image.new('RGB',(1160,height),'#050b18');sd=ImageDraw.Draw(sheet)
y=24
for name,im in thumbs:
    sd.text((30,y),name,font=font(20),fill='#b8d8ed')
    y+=38;sheet.paste(im,(30,y));y+=im.height+42
sheet.save(OUT/'creative-preview.jpg',quality=92,subsampling=0,icc_profile=ICC)

manifest={
 'schema':'store-creatives/v1','created':'2026-10-15','state':'CREATIVE_DRAFTS_NOT_SUBMITTED',
 'source_commit':'b5cdae26c62b1e35d032a063fce002eddf7eda3d',
 'gameplay_claims':'No powers, ad earning, online availability, store approval, ratings or awards advertised.',
 'screenshots':'DEFERRED by owner on 2026-10-15 until Undo and powers are complete. None included.',
 'generator':'scripts/store/export-creatives.py',
 'artwork':{'source':str(ART.relative_to(ROOT)),'sha256':hashlib.sha256(ART.read_bytes()).hexdigest(),'method':'Built-in image_gen; standalone marketing illustration, not a screenshot'},
 'brand':{'source':str(LOGO.relative_to(ROOT)),'sha256':hashlib.sha256(LOGO.read_bytes()).hexdigest(),'method':'Approved master composited unchanged in proportion; no AI redraw'},
 'font':{'name':'Avenir Next (system)','redistributed':False},
 'assets':[]
}
alt={
 'product-page-header-3840x1646.png':'Cyan X and magenta O above a luminous mountain valley, with the Mega XOXO logo and Nine boards. One bigger game.',
 'search-results-1920x1280.png':'Mega XOXO Ultimate Tic-tac-toe artwork with cyan X, magenta O and Think one board ahead.',
 'feature-graphic-1024x500.png':'Mega XOXO: Nine boards. One bigger game. Cyan X and magenta O in a blue and violet mountain valley.'
}
for p in files:
    with Image.open(p) as im:
        assert im.mode=='RGB' and len(im.getbands())==3
        a=alt[p.name];assert len(a)<=140
        manifest['assets'].append({'path':str(p.relative_to(ROOT)),'width':im.width,'height':im.height,'mode':im.mode,'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'alt':a})
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'exports':manifest['assets'],'preview':str((OUT/'creative-preview.jpg').relative_to(ROOT))},indent=2))
