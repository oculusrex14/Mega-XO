# Mega Pass transparent object asset — delivered

Owner follow-up: Codex should generate the required artwork rather than delegate generation to the implementation executor. This receipt supersedes section C2's original generation-to-do. The wider Store redesign and payment work remain planned, not implemented by this asset commit.

## Delivered file

- Repository: assets/p21/art/mega-pass.webp
- Website build destination: /assets/art/mega-pass.webp
- Format: WebP with generated alpha, 768 x 481, 54,176 bytes (about 53 KiB).
- SHA-256: 41bb979e30ae2ebcd4b722ecd4144286019d1c077b02deb066571f5aa844e325
- Design: a purple enamel membership ticket with violet/magenta faceted crown and gold rim; text-free, no scenery or baked-in card background.
- References inspected: assets/p21/art/currency/coin.webp and crown.webp. Neither existing asset was changed.
- Method: built-in imagegen with transparent_background:true; final image was generated fresh after two discarded halo-heavy attempts. No CLI image-generation fallback was used. Original tool outputs remain outside the shipped bundle.
- Export: cwebp -q 90 -alpha_q 100 -m 6 -resize 768 0, preserving generated alpha. No masking, background knockout or alpha threshold was applied by a script.

## Validation actually performed

RGBA decode succeeded. All four corner pixels have alpha 0. Center alpha is 253/255 (near opaque); generated alpha range is 0–254. The export has 185,809 fully transparent pixels. The visible silhouette at alpha >8 occupies x=72..708, y=81..404; faint near-transparent generated edge noise beyond it remains unchanged. These are alpha measurements, not a claim that every outside pixel is mathematically zero.

The actual WebP was served in a local browser beside the unmodified Coin/Crown images at 240px, then at 96px. Inspected on navy, light gray and a CSS checkerboard: no visible landscape, rectangular matte or diffuse cloud; ticket/crown silhouette stays readable at the small size. Local screenshot: .artifacts/mega-pass-asset-qa.png in the owner's Test XO workspace. This is an isolated asset QA page, not a screenshot of a completed Store redesign.

Packaging check PASS on the reviewed V5.2 d6086a2 checkout plus the new asset: node scripts/p21/build-web.js --output .artifacts/pass-asset-build-check. The output included assets/art/mega-pass.webp, byte-identical to the source (cmp exit 0), without changing the build allowlist. Generated bundle SHA-256: e1edfaf9717fab8193b82ada091a256bff5ba8bd92363e5faace9c723f2f874a. This was a local packaging check with the added artwork, not a deployment of that older source SHA.

No full application suite or provider test was needed for this standalone asset/document addition. Store integration must run the page/build checks specified in the execution plan. Do not label the new pass sold/live because this image exists.

## Integration for the executor

Use the existing root-art WebP discovery in scripts/p21/build-web.js; it maps this source to /assets/art/mega-pass.webp. On the authorized implementation base, change the pass image reference from mega-pass.png to mega-pass.webp and remove only the proven redundant explicit PNG copy. Leave the old banner source untouched until the UI change and all references have been reviewed.

Example markup:

~~~html
<img class="pg-pass-art" src="/assets/art/mega-pass.webp"
     width="768" height="481" alt="" decoding="async">
~~~

Use object-fit:contain, height:auto, and a bounded art column (roughly 220–280px on desktop). Preserve the native aspect ratio. Do not reinstate object-fit:cover, use this as a landscape background, or upscale it into another full-width hero. Keep product names, prices, billing terms and buttons in accessible HTML. Native can retain MegaIcons.pass() rather than bundle this raster object.

## Final built-in generation prompt

~~~text
Use case: product-mockup.
Create a clean game inventory sprite: one small premium membership ticket, a physical opaque purple enamel ticket with clipped corners and one semicircular notch on each short side, thin metallic gold trim, one raised faceted magenta crystal crown emblem at center. No lettering or numbers. Render with the simple polished 3D collectible style of a mobile game's coin and crown icons. Non-emissive materials, no atmospheric lighting. Gentle white studio highlights on the physical surfaces only. Nearly straight-on view, slight tilt. The pass is a simple bold 1.6:1 horizontal object centered in the canvas and entirely visible with ample margin.
ABSOLUTELY CLEAN TRANSPARENT CUTOUT: alpha zero everywhere outside the exact physical ticket boundary and side notches, no glow, no aura, no haze, no halo, no dust, no sparkles, no shadow, no pedestal, no floor, no backdrop. Interior opaque. Treat it as a UI sprite that will be placed over arbitrary light or dark backgrounds. Do not paint any pixels around it. Avoid a dramatic scene or cinematic illustration; only the little isolated inventory item, like a professionally cut-out product icon.
~~~
