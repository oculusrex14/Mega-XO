"""Resize the approved raster emblem for browser icons; leave its master intact."""
import hashlib
import json
from pathlib import Path

from PIL import Image, __version__ as pillow_version

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "assets/p21/logos/mega-xoxo-icon-only-logo.png"
DEST = ROOT / "assets/p21/icons"
PROFILE = ROOT / "assets/p21/scene-layers/srgb.icc"
EXPECTED_SOURCE = "3b3f7042c5826fcd31ba831d8546fccb5aea840c2c821627b6def2f4ce360286"


def record(file):
    data = file.read_bytes()
    return {"path": str(file.relative_to(ROOT)), "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest()}


def main():
    if record(SOURCE)["sha256"] != EXPECTED_SOURCE:
        raise ValueError("Approved emblem master changed; review before exporting")
    original = Image.open(SOURCE).convert("RGBA")
    bounds = original.getchannel("A").getbbox()
    if not bounds:
        raise ValueError("Emblem has no visible pixels")
    emblem = original.crop(bounds)
    profile = PROFILE.read_bytes()
    DEST.mkdir(parents=True, exist_ok=True)
    rows = []

    def icon(size, fraction, opaque=False):
        canvas = Image.new("RGBA", (size, size), "#030917" if opaque else (0, 0, 0, 0))
        mark = emblem.copy()
        mark.thumbnail((round(size * fraction), round(size * fraction)), Image.Resampling.LANCZOS)
        canvas.alpha_composite(mark, ((size - mark.width) // 2, (size - mark.height) // 2))
        return canvas.convert("RGB") if opaque else canvas

    variants = [(f"favicon-{n}.png", n, .94, False) for n in (16, 32, 48)]
    variants += [("apple-touch-icon.png", 180, .80, True),
                 ("pwa-192.png", 192, .80, False), ("pwa-512.png", 512, .80, False),
                 ("pwa-maskable-512.png", 512, .55, True)]
    for name, size, fraction, opaque in variants:
        file = DEST / name
        output = icon(size, fraction, opaque)
        output.save(file, format="PNG", optimize=True, icc_profile=profile)
        decoded = Image.open(file)
        if decoded.size != (size, size) or decoded.info.get("icc_profile") != profile:
            raise ValueError("Export size/color profile mismatch")
        if opaque and decoded.mode != "RGB":
            raise ValueError("Launcher background must be opaque")
        rows.append({**record(file), "size": [size, size], "mode": decoded.mode,
                     "emblem_fraction": fraction, "opaque_background": "#030917" if opaque else None})
    ico = DEST / "favicon.ico"
    icon(48, .94).save(ico, format="ICO", sizes=[(16, 16), (32, 32), (48, 48)])
    decoded = Image.open(ico)
    if decoded.ico.sizes() != {(16, 16), (32, 32), (48, 48)}:
        raise ValueError("ICO must contain all three favicon sizes")
    rows.append({**record(ico), "sizes": [[16, 16], [32, 32], [48, 48]], "mode": "RGBA"})
    manifest = {"schema_version": 1, "task_ids": ["R16", "P21-K019", "P21-K180"],
                "source": record(SOURCE), "alpha_crop": list(bounds), "color_profile": record(PROFILE),
                "tool": {"pillow": pillow_version}, "generator": "scripts/p21/export-icons.py",
                "outputs": rows,
                "status": "Raster browser exports verified; editable vector, monochrome mask and physical install review remain open",
                "maskable_safe_area": "Emblem box is <=55% of canvas; its corners fit within the centered 40%-radius safe circle",
                "rights": "Owner-approved emblem resized without changing its design. No new logo or native launcher configuration."}
    (DEST / "PROVENANCE.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"files": len(rows), "bytes": sum(row["bytes"] for row in rows), "master_sha256": EXPECTED_SOURCE}))


if __name__ == "__main__":
    main()
