'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative));
const source = relative => read(relative).toString('utf8');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const approved = '3b3f7042c5826fcd31ba831d8546fccb5aea840c2c821627b6def2f4ce360286';
const ios = 'native/ios/MegaXO/Assets.xcassets';
const android = 'native/android/app/src/main/res';
const densitySizes = {mdpi:108, hdpi:162, xhdpi:216, xxhdpi:324, xxxhdpi:432};

// Decode the actual exported PNG pixels with built-in Node APIs. Geometry and
// opacity assertions must not trust the generator's own reported measurements.
function png(relative) {
 const bytes = read(relative), compressed = [];
 assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', relative);
 let width, height, channels, colorType, profile;
 for (let offset = 8; offset < bytes.length;) {
  const length = bytes.readUInt32BE(offset), kind = bytes.toString('ascii', offset + 4, offset + 8);
  const data = bytes.subarray(offset + 8, offset + 8 + length);
  if (kind === 'IHDR') {
   width = data.readUInt32BE(0);height = data.readUInt32BE(4);colorType = data[9];
   assert.equal(data[8], 8);assert.ok([2, 6].includes(colorType));
   assert.deepEqual([...data.subarray(10)], [0, 0, 0], 'non-interlaced PNG');
   channels = colorType === 6 ? 4 : 3;
  } else if (kind === 'IDAT') compressed.push(data);
  else if (kind === 'iCCP') {
   const end = data.indexOf(0);assert.ok(end > 0);assert.equal(data[end + 1], 0);
   profile = zlib.inflateSync(data.subarray(end + 2));
  }
  offset += length + 12;
 }
 const raw = zlib.inflateSync(Buffer.concat(compressed)), stride = width * channels;
 assert.equal(raw.length, (stride + 1) * height);
 const pixels = Buffer.alloc(stride * height);
 for (let y = 0; y < height; y++) {
  const filter = raw[y * (stride + 1)];assert.ok(filter <= 4);
  for (let x = 0; x < stride; x++) {
   const left = x >= channels ? pixels[y * stride + x - channels] : 0;
   const above = y ? pixels[(y - 1) * stride + x] : 0;
   const upperLeft = y && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
   const p = left + above - upperLeft, distances = [Math.abs(p - left), Math.abs(p - above), Math.abs(p - upperLeft)];
   const paeth = distances[0] <= distances[1] && distances[0] <= distances[2] ? left : distances[1] <= distances[2] ? above : upperLeft;
   const prediction = [0, left, above, Math.floor((left + above) / 2), paeth][filter];
   pixels[y * stride + x] = (raw[y * (stride + 1) + x + 1] + prediction) & 255;
  }
 }
 const pixel = (x, y) => {
  const offset = (y * width + x) * channels;
  return [...pixels.subarray(offset, offset + 3), channels === 4 ? pixels[offset + 3] : 255];
 };
 return {bytes, width, height, channels, colorType, profile, pixel};
}

test('native/store exports are pinned to the approved emblem, frozen sRGB profile and recorded bytes', () => {
 const provenance = JSON.parse(source('assets/p21/icons/native/PROVENANCE.json'));
 assert.equal(provenance.source.path, 'assets/p21/logos/mega-xoxo-icon-only-logo.png');
 assert.equal(provenance.source.sha256, approved);
 assert.equal(sha(read(provenance.source.path)), approved);
 assert.equal(provenance.color_profile.sha256, '85ecec0f261679a58a1a9228e33abedc31c0ae56f3c4b3f783aaa791fa53f2ac');
 assert.equal(sha(read(provenance.color_profile.path)), provenance.color_profile.sha256);
 assert.equal(provenance.outputs.length, 7);
 for (const output of provenance.outputs) {
  const decoded = png(output.path);
  assert.equal(sha(decoded.bytes), output.sha256, output.path);
  assert.equal(decoded.bytes.length, output.bytes, output.path);
  assert.deepEqual([decoded.width, decoded.height], output.size, output.path);
  assert.ok(decoded.profile, 'native/store PNG embeds its sRGB profile');
  assert.equal(sha(decoded.profile), provenance.color_profile.sha256);
 }
});

test('iOS default icon is an opaque square 1024px RGB PNG in the target resource catalog', () => {
 const catalog = JSON.parse(source(`${ios}/AppIcon.appiconset/Contents.json`));
 assert.deepEqual(catalog.images, [{filename:'AppIcon-1024.png', idiom:'universal', platform:'ios', size:'1024x1024'}]);
 const icon = png(`${ios}/AppIcon.appiconset/AppIcon-1024.png`);
 assert.deepEqual([icon.width, icon.height, icon.channels], [1024, 1024, 3]);
 for (const [x, y] of [[0, 0], [1023, 0], [0, 1023], [1023, 1023]]) assert.deepEqual(icon.pixel(x, y), [3, 9, 23, 255], 'corners stay opaque and unrounded');
 const project = source('native/ios/MegaXO.xcodeproj/project.pbxproj');
 const reference = project.match(/([A-F0-9]{24})[^\n]*isa = PBXFileReference;[^\n]*lastKnownFileType = folder\.assetcatalog;[^\n]*path = Assets\.xcassets;/)?.[1];
 assert.ok(reference, 'catalog is a project file reference');
 const buildFile = project.match(new RegExp(`([A-F0-9]{24})[^\\n]*isa = PBXBuildFile;[^\\n]*fileRef = ${reference}`))?.[1];
 assert.ok(buildFile, 'catalog has a build file');
 assert.match(project, new RegExp(`isa = PBXResourcesBuildPhase;[^\\n]*files = \\([^)]*${buildFile}`));
 assert.match(project, new RegExp(`isa = PBXGroup; children = \\([^)]*${reference}`));
 assert.equal((project.match(/ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;/g) || []).length, 2, 'Debug and Release select the catalog');
});

test('Android launcher resolves an adaptive icon with an opaque matching background in both flavors', () => {
 const manifest = source('native/android/app/src/main/AndroidManifest.xml');
 assert.match(manifest, /<application\s[^>]*android:icon="@mipmap\/ic_launcher"/);
 assert.match(manifest, /<application\s[^>]*android:roundIcon="@mipmap\/ic_launcher"/);
 const adaptive = source(`${android}/mipmap-anydpi-v26/ic_launcher.xml`);
 assert.match(adaptive, /<adaptive-icon\s/);
 assert.match(adaptive, /<background android:drawable="@color\/ic_launcher_background"/);
 assert.match(adaptive, /<foreground android:drawable="@drawable\/ic_launcher_foreground"/);
 assert.doesNotMatch(adaptive, /<monochrome/);
 assert.match(source(`${android}/values/ic_launcher_colors.xml`), /<color name="ic_launcher_background">#030917<\/color>/);
 assert.match(source('native/android/app/build.gradle.kts'), /minSdk = 28/);
 assert.doesNotMatch(source('native/android/app/src/online/AndroidManifest.xml'), /android:(?:icon|roundIcon)=/);
});

test('all Android density foreground pixels and halos survive the 66dp safe circle and launcher circle/squircle masks', () => {
 for (const [density, size] of Object.entries(densitySizes)) {
  const foreground = png(`${android}/drawable-${density}/ic_launcher_foreground.png`);
  assert.deepEqual([foreground.width, foreground.height, foreground.channels], [size, size, 4]);
  let visible = 0, maxRadius = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
   if (!foreground.pixel(x, y)[3]) continue;
   visible++;
   const dx = (x + .5 - size / 2) * 108 / size, dy = (y + .5 - size / 2) * 108 / size;
   const radius = Math.hypot(dx, dy);maxRadius = Math.max(maxRadius, radius);
   assert.ok(radius <= 33, `${density}: every nonzero alpha pixel fits the 66dp safe circle`);
   assert.ok(radius <= 36, `${density}: no circle-mask clipping in the central 72dp viewport`);
   assert.ok((Math.abs(dx) / 36) ** 4 + (Math.abs(dy) / 36) ** 4 <= 1, `${density}: no squircle-mask clipping`);
  }
  assert.ok(visible > size * size * .1, 'the foreground is not an empty or microscopic placeholder');
  assert.ok(maxRadius >= 28, 'the approved emblem retains useful launcher size');
  assert.deepEqual(foreground.pixel(0, 0), [0, 0, 0, 0], 'foreground is unmasked and transparent outside the emblem');
 }
});

test('Play listing export is a full-square opaque-alpha 512px 32-bit sRGB PNG under 1MB', () => {
 const icon = png('assets/p21/icons/native/play-store-512.png');
 assert.deepEqual([icon.width, icon.height, icon.channels], [512, 512, 4]);
 assert.ok(icon.bytes.length <= 1024 * 1024);
 for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) assert.equal(icon.pixel(x, y)[3], 255);
 for (const [x, y] of [[0, 0], [511, 0], [0, 511], [511, 511]]) assert.deepEqual(icon.pixel(x, y), [3, 9, 23, 255]);
});
