"""Reproducible scene-source exports; never edits the current website or masters."""
import hashlib
import json
from pathlib import Path
import random
import xml.etree.ElementTree as ET

from PIL import Image, ImageCms

ROOT = Path(__file__).resolve().parents[2]
DIRECTORY = ROOT / "assets/p21/scene-layers"
WIDTH, HEIGHT = 1672, 941
REFERENCE = "assets/p21/art/hero-source.png"
PROFILE = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()

PROMPTS = {
    "foreground": "Use case: background-extraction. Asset type: independent foreground terrain layer for the existing Mega XOXO website scene asset pack. Edit target is the referenced unlettered hero plate. Preserve the existing lower foreground rocky terrain silhouette, its original camera alignment, blue edge-lighting, deep navy-black material, faint violet foreground haze, and its left/right valley framing. Extract ONLY the very near rocky foreground occupying approximately the lower 30 percent of the reference and its lower left/right edges. Remove the sky, stars, purple planet, far mountains, middle-distance ridge and bright horizon completely, replacing all of those with actual alpha transparency. Keep original wide 16:9 canvas and terrain placement; the upper 60 percent must be fully transparent. Natural clean transparent transitions at the rocky ridge contour, no white or black backdrop, no new text, no UI, no letters, no board, no logos. A single independent image layer, not a contact sheet or collage. This is a source production asset for compositing, do not reimagine the scene or change the existing website.",
    "midground": "Use case: background-extraction. Asset type: independent midground mountain-ridge layer for Mega XOXO website source asset pack. Edit target is the referenced unlettered hero background. Preserve the original jagged left and right middle-distance mountains, central distant valley ridge line, original 16:9 canvas camera alignment, cobalt edge-lighting, indigo shadow rock material and purple-blue mountain glow. Extract ONLY the mountain silhouettes and middle-distance ridges. Remove all sky/stars/planet, remove the near dark rocky foreground in the bottom quarter, and remove the bright floor stream and horizon fog. Replace removed pixels with actual transparent alpha, including upper half sky and bottom foreground. Natural clean alpha edges around the mountain outlines. Keep mountains at their exact approximate positions from the original reference, not a new camera scene. No text, no UI, no game marks, no logo, no icons, no white/black backdrop. One standalone wide independent layer, not a contact sheet. The existing website rendering is not being replaced by this asset; it is a production compositing source.",
    "haze": "Use case: background-extraction. Asset type: independent atmospheric horizon haze layer for the existing Mega XOXO website scene source pack. Reference/edit target is the unlettered original hero scene. Preserve its restrained purple haze on the lower-left and cobalt/cyan horizon illumination across the valley near y=60–75% of the wide 16:9 canvas. Output ONLY the soft distant fog/haze and gentle horizon bloom, with true graded alpha transparency. Remove all opaque sky, stars, planet, mountains, rocks, river, foreground and every object; these must become transparent. Most of upper55% and lower10% should be transparent. Smooth cinematic diffuse blue and violet fog wisps, low intensity, no hard boundary or banding, no solid black/white background. Keep spatial light distribution roughly aligned to original. No text, logo, UI, shapes, board or marks. One standalone wide alpha atmospheric layer, not a collage or poster. Existing website is not being changed; this is an editable compositing-source layer.",
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def record(file):
    data = file.read_bytes()
    return {"path": str(file.relative_to(ROOT)), "bytes": len(data), "sha256": digest(data)}


def svg(inner):
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{HEIGHT}" viewBox="0 0 {WIDTH} {HEIGHT}">{inner}</svg>\n'


def main():
    DIRECTORY.mkdir(parents=True, exist_ok=True)
    assets = []
    for index, name in enumerate(PROMPTS, 2):
        master = DIRECTORY / f"{name}-source.png"
        image = Image.open(master)
        if image.mode != "RGBA" or image.size != (WIDTH, HEIGHT):
            raise ValueError(f"Unexpected RGBA canvas: {name}")
        alpha = image.getchannel("A")
        if alpha.getextrema()[0] != 0 or alpha.getextrema()[1] == 0:
            raise ValueError(f"Missing actual transparent artwork: {name}")
        export = DIRECTORY / f"{name}.webp"
        image.save(export, format="WEBP", quality=86 if name == "haze" else 88,
                   method=6, exact=True, icc_profile=PROFILE)
        optimized = Image.open(export)
        if optimized.size != image.size or optimized.mode != "RGBA" or optimized.getchannel("A").tobytes() != alpha.tobytes():
            raise ValueError(f"Export changed dimensions/alpha: {name}")
        if not optimized.info.get("icc_profile"):
            raise ValueError(f"Export has no embedded sRGB profile: {name}")
        assets.append({
            "id": f"P21-BG-{index:03}", "name": name,
            "source": record(master), "exports": [record(export)],
            "dimensions": [WIDTH, HEIGHT], "source_format": "RGBA PNG",
            "export_format": "RGBA WebP", "alpha_range": list(alpha.getextrema()),
            "alpha_bit_exact_in_export": True,
            "source_color_profile": "No embedded ICC profile; generated RGB is interpreted as sRGB for the separate export",
            "export_color_profile": "embedded sRGB ICC", "generator": "built-in image_gen",
            "model": "not exposed by tool", "seed": "not exposed by tool", "prompt": PROMPTS[name],
            "role": "independent source layer; not mounted in the current website",
            "fallback": "static WebP layer; current site retains its original hero-wide/hero-small stills",
        })

    rng = random.Random(210051)
    stars = []
    for _ in range(64):
        stars.append({"x": round(rng.uniform(25, WIDTH - 25), 2), "y": round(rng.uniform(35, 540), 2),
                      "radius": round(rng.uniform(.35, 1.2), 2), "opacity": round(rng.uniform(.12, .52), 2)})
    markup = ''.join(f'<circle cx="{star["x"]}" cy="{star["y"]}" r="{star["radius"]}" opacity="{star["opacity"]}"/>' for star in stars)
    starfile = DIRECTORY / 'stars.svg'
    starfile.write_text(svg(f'<g fill="#62c4ff">{markup}</g>'))
    assets.append({"id": "P21-BG-005", "name": "stars", "source": record(starfile), "exports": [],
                   "dimensions": [WIDTH, HEIGHT], "format": "editable SVG", "seed": 210051,
                   "placement_map": stars, "intensity_limit": "64 static stars, maximum opacity 0.52 and radius 1.2px at reference size; no flicker",
                   "fallback": "omit the decorative overlay; current original still remains available", "role": "source only; not mounted"})

    lights = [('left-glow', '#8240cf', '14%', '56%', .20),
              ('right-glow', '#147cff', '90%', '58%', .18),
              ('center-backlight', '#28c1ff', '58%', '71%', .12)]
    for index, (name, color, cx, cy, opacity) in enumerate(lights, 6):
        file = DIRECTORY / f'{name}.svg'
        file.write_text(svg(f'<defs><radialGradient id="light" cx="{cx}" cy="{cy}" r="55%"><stop stop-color="{color}" stop-opacity="{opacity}"/><stop offset="1" stop-color="{color}" stop-opacity="0"/></radialGradient></defs><rect width="{WIDTH}" height="{HEIGHT}" fill="url(#light)"/>'))
        assets.append({"id": f"P21-BG-{index:03}", "name": name, "source": record(file), "exports": [],
                       "dimensions": [WIDTH, HEIGHT], "format": "editable SVG lighting mask", "maximum_opacity": opacity,
                       "fallback": "omit optional glow; current original still remains available", "role": "source only; not mounted"})

    for file in DIRECTORY.glob('*.svg'):
        element = ET.fromstring(file.read_text())
        if element.attrib.get('viewBox') != f'0 0 {WIDTH} {HEIGHT}' or 'href' in file.read_text() or '<script' in file.read_text():
            raise ValueError(f'Invalid standalone SVG source: {file.name}')

    provenance = {
        "schema_version": 1, "created_on": "2026-10-12", "owner": "Antimatter Innovations",
        "reference": record(ROOT / REFERENCE), "request": "Owner-commissioned P21 independent scene layers",
        "task_ids": ["R16", "P21-K076", "P21-K077", "P21-K078", "P21-K079", "P21-K125"],
        "status": "PARTIAL_SOURCE_PACK; source/export checks pass, complete scene and owner visual acceptance remain open",
        "assets": assets, "export_command": "python3 scripts/p21/export-scene-layers.py (Pillow required)",
        "rights_note": "Owner-directed generated derivatives and original procedural vector sources. Provenance is not a trademark/legal clearance.",
        "current_site_unchanged": "Builder does not include assets/p21/scene-layers; no source layer is mounted by this commit",
        "open": ["independent far-ridge/cloud/vignette layers", "approved layered composite and per-breakpoint art direction",
                 "edge checks over dark/light surfaces and visual sign-off", "motion/video/3D/audio pack", "formal ownership/legal approval"],
    }
    (DIRECTORY / 'PROVENANCE.json').write_text(json.dumps(provenance, indent=2) + '\n')
    print(json.dumps({"result": "PASS_SOURCE_EXPORT_CHECKS", "assets": len(assets),
                      "raster_exports_bytes": sum(asset['exports'][0]['bytes'] for asset in assets if asset['exports']),
                      "site_rendering_changed": False}))


if __name__ == '__main__':
    main()
