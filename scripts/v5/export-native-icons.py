"""Package the approved emblem for native launchers; never redraw its master."""
import argparse
import hashlib
from io import BytesIO
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, __version__ as pillow_version

ROOT = Path(__file__).resolve().parents[2]
SOURCE = "assets/p21/logos/mega-xoxo-icon-only-logo.png"
EXPECTED_SOURCE = "3b3f7042c5826fcd31ba831d8546fccb5aea840c2c821627b6def2f4ce360286"
PROFILE = "assets/p21/icons/native/srgb.icc"
EXPECTED_PROFILE = "85ecec0f261679a58a1a9228e33abedc31c0ae56f3c4b3f783aaa791fa53f2ac"
IOS = "native/ios/MegaXO/Assets.xcassets"
ANDROID = "native/android/app/src/main/res"
DEST = "assets/p21/icons/native"
BACKGROUND = "#030917"
DENSITIES = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value, indent=2) + "\n").encode()


def circle_radius(image):
    """Include every rendered alpha value, including the faint outer halo."""
    alpha = image.getchannel("A")
    center = image.width / 2
    return max(math.hypot(x + .5 - center, y + .5 - center)
               for y in range(image.height) for x in range(image.width)
               if alpha.getpixel((x, y)))


def exports():
    source = (ROOT / SOURCE).read_bytes()
    profile = (ROOT / PROFILE).read_bytes()
    if digest(source) != EXPECTED_SOURCE or digest(profile) != EXPECTED_PROFILE:
        raise ValueError("Approved emblem or frozen sRGB profile changed; review before exporting")
    original = Image.open(BytesIO(source)).convert("RGBA")
    bounds = original.getchannel("A").getbbox()
    if not bounds:
        raise ValueError("Approved emblem has no visible pixels")
    emblem = original.crop(bounds)
    files, records, previews = {}, [], {}

    def icon(path, size, fraction, mode, opaque):
        canvas = Image.new("RGBA", (size, size), BACKGROUND if opaque else (0, 0, 0, 0))
        mark = emblem.copy()
        mark.thumbnail((round(size * fraction), round(size * fraction)), Image.Resampling.LANCZOS)
        canvas.alpha_composite(mark, ((size - mark.width) // 2, (size - mark.height) // 2))
        output = canvas.convert(mode)
        encoded = BytesIO()
        output.save(encoded, format="PNG", optimize=True, icc_profile=profile)
        files[path] = encoded.getvalue()
        record = {"path": path, "bytes": len(files[path]), "sha256": digest(files[path]),
                  "size": [size, size], "mode": mode, "emblem_fraction": fraction,
                  "opaque_background": BACKGROUND if opaque else None}
        records.append(record)
        previews[path] = output
        return output, record

    icon(f"{IOS}/AppIcon.appiconset/AppIcon-1024.png", 1024, .80, "RGB", True)
    icon(f"{DEST}/play-store-512.png", 512, .80, "RGBA", True)
    for density, size in DENSITIES.items():
        image, record = icon(f"{ANDROID}/drawable-{density}/ic_launcher_foreground.png", size, .55, "RGBA", False)
        # Android's 108dp layers have a central 66dp safe circle. Validate the
        # resampled output, not just its bounding box or the PWA safe area.
        radius = circle_radius(image) * 108 / size
        if radius > 33:
            raise ValueError(f"{density}: rendered emblem/halo exceeds Android's safe circle")
        record["max_alpha_radius_dp"] = round(radius, 6)
    info = {"author": "xcode", "version": 1}
    files[f"{IOS}/Contents.json"] = json_bytes({"info": info})
    files[f"{IOS}/AppIcon.appiconset/Contents.json"] = json_bytes({
        "images": [{"filename": "AppIcon-1024.png", "idiom": "universal", "platform": "ios", "size": "1024x1024"}],
        "info": info})
    files[f"{ANDROID}/mipmap-anydpi-v26/ic_launcher.xml"] = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
        '    <background android:drawable="@color/ic_launcher_background" />\n'
        '    <foreground android:drawable="@drawable/ic_launcher_foreground" />\n'
        '</adaptive-icon>\n').encode()
    files[f"{ANDROID}/values/ic_launcher_colors.xml"] = (
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
        f'    <color name="ic_launcher_background">{BACKGROUND}</color>\n'
        '</resources>\n').encode()
    manifest = {"schema_version": 1, "generator": "scripts/v5/export-native-icons.py",
                "source": {"path": SOURCE, "bytes": len(source), "sha256": EXPECTED_SOURCE},
                "alpha_crop": list(bounds),
                "color_profile": {"path": PROFILE, "sha256": EXPECTED_PROFILE,
                                  "extracted_from": "assets/p21/icons/pwa-512.png embedded ICC profile"},
                "tool": {"pillow": pillow_version}, "outputs": records,
                "android_geometry": {"layer_dp": 108, "safe_circle_diameter_dp": 66,
                                     "alpha_threshold": 0, "prebaked_mask": False},
                "rights": "Deterministic exports of the owner-approved emblem; no new artwork or theme entitlement.",
                "acceptance": "Source packaging only; signed archive/store/device appearance requires separate verification."}
    files[f"{DEST}/PROVENANCE.json"] = json_bytes(manifest)
    return files, previews, profile


def preview(images, profile):
    sheet = Image.new("RGB", (660, 306), "#182238")
    draw = ImageDraw.Draw(sheet)
    ios = images[f"{IOS}/AppIcon.appiconset/AppIcon-1024.png"]
    foreground = images[f"{ANDROID}/drawable-xxxhdpi/ic_launcher_foreground.png"]
    # The launcher shows the central 72dp viewport of the 108dp layer. Preview
    # both masks on that viewport; the source resources stay square/unmasked.
    android = Image.new("RGBA", foreground.size, BACKGROUND)
    android.alpha_composite(foreground)
    inset = foreground.width // 6
    android = android.crop((inset, inset, foreground.width - inset, foreground.height - inset))
    for column, (label, image, shape) in enumerate([
            ("iOS / iPadOS", ios, "ios"), ("Android circle", android, "circle"),
            ("Android squircle", android, "squircle")]):
        x = 18 + column * 220
        draw.text((x, 12), label, fill="white")
        for size, y in [(128, 38), (60, 194)]:
            tile = image.convert("RGBA").resize((size, size), Image.Resampling.LANCZOS)
            mask = Image.new("L", (size * 4, size * 4))
            pixels = mask.load()
            for py in range(mask.height):
                for px in range(mask.width):
                    dx, dy = (px + .5 - mask.width / 2) / (mask.width / 2), (py + .5 - mask.height / 2) / (mask.height / 2)
                    inside = dx * dx + dy * dy <= 1 if shape == "circle" else abs(dx) ** 4 + abs(dy) ** 4 <= 1
                    if inside:
                        pixels[px, py] = 255
            mask = mask.resize((size, size), Image.Resampling.LANCZOS)
            sheet.paste(tile, (x, y), mask)
            draw.text((x + size + 7, y + size // 2), f"{size}px", fill="white")
    draw.text((18, 280), "Mask simulations only; native launcher/device review remains separate.", fill="white")
    path = ROOT / ".artifacts/native-icons/native-icon-preview.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path, format="PNG", icc_profile=profile)
    return str(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Regenerate in memory and refuse stale exports without writing")
    parser.add_argument("--preview", action="store_true", help="Save an ignored small-size mask preview")
    args = parser.parse_args()
    if args.check and args.preview:
        parser.error("--check does not write previews")
    files, images, profile = exports()
    for relative, data in files.items():
        path = ROOT / relative
        if args.check:
            if not path.is_file() or path.read_bytes() != data:
                raise ValueError(f"Missing or stale native icon export: {relative}")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
    result = {"files": len(files), "master_sha256": EXPECTED_SOURCE, "check": args.check}
    if args.preview:
        result["preview"] = preview(images, profile)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
