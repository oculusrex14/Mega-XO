#!/usr/bin/env node
/* Deterministic P21 3D source-to-GLB exporter and readback validator. */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');
const outDir = path.join(repoRoot, 'assets/p21/three/exports');
const dependencyDir = path.join(repoRoot, '.artifacts/p21-three-tools/node_modules/three');
const readFile = (p) => fs.readFile(p);
const digest = (data) => crypto.createHash('sha256').update(data).digest('hex');

const [THREE, { GLTFExporter }, { GLTFLoader }] = await Promise.all([
  import(pathToFileURL(path.join(dependencyDir, 'build/three.module.js')).href),
  import(pathToFileURL(path.join(dependencyDir, 'examples/jsm/exporters/GLTFExporter.js')).href),
  import(pathToFileURL(path.join(dependencyDir, 'examples/jsm/loaders/GLTFLoader.js')).href),
]);
const { createAsset, assetNames, qualityNames } = await import(pathToFileURL(path.join(repoRoot, 'assets/p21/three/factories.mjs')).href);
const threePackage = JSON.parse(await readFile(path.join(dependencyDir, 'package.json'), 'utf8'));

// Three's browser-oriented GLTFExporter uses FileReader for Blob assembly.
// This narrowly implements its binary conversion in Node; no texture encoder is needed.
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class FileReaderForNode {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((buffer) => { this.result = buffer; this.onloadend?.(); }, (error) => { this.error = error; this.onerror?.(error); });
    }
    readAsDataURL(blob) {
      blob.arrayBuffer().then((buffer) => { this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buffer).toString('base64')}`; this.onloadend?.(); }, (error) => { this.error = error; this.onerror?.(error); });
    }
  };
}

function geometryReport(root) {
  root.updateMatrixWorld(true);
  const totals = { meshCount: 0, vertices: 0, triangles: 0, normalAttributes: 0, uvAttributes: 0, finite: true, normalsUnit: true, materials: [] };
  root.traverse((object) => {
    if (!object.isMesh) return;
    totals.meshCount++;
    const geometry = object.geometry;
    const positions = geometry.getAttribute('position');
    const normals = geometry.getAttribute('normal');
    const uvs = geometry.getAttribute('uv');
    if (!positions) throw new Error(`${object.name} has no position attribute`);
    totals.vertices += positions.count;
    totals.triangles += geometry.index ? geometry.index.count / 3 : positions.count / 3;
    if (normals && normals.itemSize >= 3) totals.normalAttributes++;
    if (uvs && uvs.itemSize >= 2) totals.uvAttributes++;
    if (normals && normals.itemSize >= 3) {
      for (let i = 0; i < normals.count; i++) {
        const length = Math.hypot(normals.getX(i), normals.getY(i), normals.getZ(i));
        if (!Number.isFinite(length) || Math.abs(length - 1) > 1e-3) totals.normalsUnit = false;
      }
    }
    for (const attribute of [positions, normals, uvs].filter(Boolean)) {
      for (const n of attribute.array) if (!Number.isFinite(n)) totals.finite = false;
    }
    const materialList = Array.isArray(object.material) ? object.material : [object.material];
    for (const mat of materialList) {
      if (!totals.materials.some((existing) => existing.name === mat.name)) {
        totals.materials.push({
          name: mat.name,
          color: mat.color?.getHexString() ? `#${mat.color.getHexString()}` : null,
          metalness: mat.metalness ?? null,
          roughness: mat.roughness ?? null,
          emissive: mat.emissive?.getHexString() ? `#${mat.emissive.getHexString()}` : null,
          emissiveIntensity: mat.emissiveIntensity ?? null,
          hasTexture: Boolean(mat.map || mat.normalMap || mat.roughnessMap || mat.metalnessMap || mat.emissiveMap),
        });
      }
    }
  });
  const bounds = new THREE.Box3().setFromObject(root);
  const size = bounds.getSize(new THREE.Vector3());
  totals.bounds = {
    min: [bounds.min.x, bounds.min.y, bounds.min.z].map(round6),
    max: [bounds.max.x, bounds.max.y, bounds.max.z].map(round6),
    size: [size.x, size.y, size.z].map(round6),
  };
  totals.pivot = root.getObjectByName('Pivot')?.position.toArray().map(round6) ?? null;
  totals.rootScale = root.scale.toArray().map(round6);
  totals.materials.sort((a, b) => a.name.localeCompare(b.name));
  return totals;
}

function round6(n) { return Number(n.toFixed(6)); }

async function exportBinary(root) {
  const exporter = new GLTFExporter();
  return new Uint8Array(await exporter.parseAsync(root, {
    binary: true,
    onlyVisible: true,
    trs: true,
    maxTextureSize: 256,
  }));
}

function checkGlb(bytes, label) {
  if (bytes.byteLength < 28) throw new Error(`${label} is too short to be a GLB`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  const version = view.getUint32(4, true);
  const length = view.getUint32(8, true);
  const jsonLength = view.getUint32(12, true);
  const jsonType = view.getUint32(16, true);
  if (magic !== 0x46546c67 || version !== 2 || length !== bytes.byteLength || jsonType !== 0x4e4f534a) {
    throw new Error(`${label} has an invalid GLB header`);
  }
  const gltf = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)).replace(/[\u0000\s]+$/g, ''));
  if (gltf.asset?.version !== '2.0') throw new Error(`${label} does not describe glTF 2.0`);
  if (gltf.images?.length) throw new Error(`${label} unexpectedly contains images`);
  if ((gltf.buffers || []).some((buffer) => buffer.uri)) throw new Error(`${label} contains an external buffer dependency`);
  const chunks = [];
  let offset = 12;
  while (offset < bytes.byteLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    chunks.push({ type: chunkType === 0x4e4f534a ? 'JSON' : chunkType === 0x004e4942 ? 'BIN' : `0x${chunkType.toString(16)}`, bytes: chunkLength });
    offset += 8 + chunkLength;
  }
  if (offset !== bytes.byteLength || !chunks.some((c) => c.type === 'BIN')) throw new Error(`${label} has missing or malformed binary chunk data`);
  const binChunk = chunks.find((chunk) => chunk.type === 'BIN');
  if (!gltf.buffers?.length || gltf.buffers[0].byteLength > binChunk.bytes || binChunk.bytes - gltf.buffers[0].byteLength > 3) {
    throw new Error(`${label} buffer declaration does not match its embedded BIN chunk`);
  }
  return { magic: 'glTF', version, length, chunks, json: gltf };
}

function loadBack(bytes, label) {
  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    loader.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '', resolve, (error) => reject(new Error(`${label} readback failed: ${error?.message || error}`)));
  });
}

async function fileInfo(relativePath, role = 'reference') {
  const bytes = await readFile(path.join(repoRoot, relativePath));
  return { path: relativePath, role, bytes: bytes.byteLength, sha256: digest(bytes) };
}

async function pngInfo(relativePath, role) {
  const bytes = await readFile(path.join(repoRoot, relativePath));
  if (bytes.toString('ascii', 1, 4) !== 'PNG') throw new Error(`${relativePath} is not a PNG`);
  return {
    path: relativePath,
    role,
    format: 'PNG',
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    colorType: bytes[25],
    alpha: bytes[25] === 4 || bytes[25] === 6,
    bytes: bytes.byteLength,
    sha256: digest(bytes),
  };
}

const rankSourcePaths = Object.freeze({
  wood: 'assets/p21/art/ranks/wood-source.png',
  stone: 'assets/p21/art/ranks/stone-source.png',
  iron: 'assets/p21/art/ranks/iron-source.png',
  bronze: 'assets/p21/art/ranks/bronze-source.png',
  silver: 'assets/p21/art/ranks/silver-source.png',
  gold: 'assets/p21/art/ranks/gold-source.png',
  diamond: 'assets/p21/art/crystal-source.png',
  emerald: 'assets/p21/art/ranks/emerald-source.png',
  champion: 'assets/p21/art/ranks/champion-source.png',
  master: 'assets/p21/art/ranks/master-source.png',
  grandmaster: 'assets/p21/art/ranks/grandmaster-source.png',
});

const rankMaterialNotes = Object.freeze({
  wood: 'walnut body, pale maple beveled frame, raised wood-colored shield; no jewel',
  stone: 'cool chiseled slate shield and pale stone edges; no jewel',
  iron: 'dark gunmetal and restrained icy blue raised metal facets',
  bronze: 'copper-orange plates and warm amber crystal',
  silver: 'platinum-silver frame and icy blue crystal',
  gold: 'yellow-gold segmented feathers and amber-gold crystal',
  diamond: 'cyan-blue metallic wings, silver-blue frame and violet crystal',
  emerald: 'silver-metal frame, green segmented wings and emerald crystal',
  champion: 'gold frame, ruby-red shield/crystal and raised single finial',
  master: 'lavender-platinum frame, amethyst crystal, four feather rows and three finials',
  grandmaster: 'gold-platinum frame, pale iridescent crystal, four feather rows and three-point crown',
});

const sourceBounds = async () => ({
  imageReferences: await Promise.all([
    ...Object.entries(rankSourcePaths).map(([rank, file]) => pngInfo(file, `rank badge source reference: ${rank}`)),
    pngInfo('assets/p21/art/trophy-source.png', 'gold trophy source reference'),
    pngInfo('assets/p21/art/currency/coin-source.png', 'existing coin source reference'),
    pngInfo('assets/p21/art/currency/crown-source.png', 'existing crown source reference'),
    pngInfo('docs/p21-web/evidence/41e74bf/home-desktop.png', 'current approved home render: Card 3 neon-board visual reference only'),
  ]),
  supportingFiles: await Promise.all([
    fileInfo('assets/p21/art/ranks/PROMPTS.json', 'rank source prompt inventory'),
    fileInfo('assets/p21/art/PROVENANCE.json', 'rank/trophy/art provenance and source-to-export map'),
    fileInfo('assets/p21/art/ranks/diamond.webp', 'existing approved Diamond rank raster output'),
    fileInfo('docs/p21-web/ASSET-REGISTRY.md', 'P21 source inventory and documented missing chest reference'),
    fileInfo('docs/p21-web/evidence/41e74bf/home-desktop.png', 'current website reference capture file proof'),
    fileInfo('apps/web/site.js', 'current Card 3 X/O pattern: siteMiniTheme cells 0, 4 and 8'),
    fileInfo('apps/web/styles.css', 'current Neon board plate dimensions, colors and grid styling'),
  ]),
});

await fs.mkdir(outDir, { recursive: true });
const assets = [];
for (const asset of assetNames) {
  for (const quality of qualityNames) {
    const root = createAsset(THREE, asset, quality);
    const sourceStats = geometryReport(root);
    if (!sourceStats.finite || sourceStats.meshCount !== sourceStats.normalAttributes || sourceStats.meshCount !== sourceStats.uvAttributes) {
      throw new Error(`${asset}-${quality}: source geometry must be finite and every mesh must have normals and UVs`);
    }
    if (!sourceStats.normalsUnit) throw new Error(`${asset}-${quality}: source geometry includes a non-unit normal`);
    if (!sourceStats.pivot || sourceStats.rootScale.some((n) => n !== 1)) throw new Error(`${asset}-${quality}: center pivot and unit scale are required`);
    if (sourceStats.meshCount < 1 || sourceStats.triangles < 1) throw new Error(`${asset}-${quality}: empty model`);

    const bytes = await exportBinary(root);
    const header = checkGlb(bytes, `${asset}-${quality}`);
    const destination = path.join(outDir, `${asset}-${quality}.glb`);
    await fs.writeFile(destination, bytes);
    const readback = await loadBack(bytes, `${asset}-${quality}`);
    const readbackStats = geometryReport(readback.scene);
    if (!readbackStats.finite || readbackStats.meshCount !== readbackStats.normalAttributes || readbackStats.meshCount !== readbackStats.uvAttributes) {
      throw new Error(`${asset}-${quality}: readback geometry must be finite and every mesh must retain normals and UVs`);
    }
    if (!readbackStats.normalsUnit) throw new Error(`${asset}-${quality}: readback geometry includes a non-unit normal`);
    if (readbackStats.meshCount !== sourceStats.meshCount || readbackStats.triangles !== sourceStats.triangles) {
      throw new Error(`${asset}-${quality}: GLB readback mesh/triangle counts differ from source`);
    }
    if (readbackStats.bounds.size.some((dimension) => dimension <= 0)) throw new Error(`${asset}-${quality}: GLB has degenerate bounds`);
    if (!readbackStats.pivot || readbackStats.pivot.some((n) => Math.abs(n) > 1e-6) || readbackStats.rootScale.some((n) => Math.abs(n - 1) > 1e-6)) {
      throw new Error(`${asset}-${quality}: GLB readback must preserve the centered pivot and unit root scale`);
    }
    const boundsMatch = ['min', 'max', 'size'].every((edge) => sourceStats.bounds[edge].every((n, i) => Math.abs(n - readbackStats.bounds[edge][i]) <= 1e-5));
    if (!boundsMatch) throw new Error(`${asset}-${quality}: GLB readback bounds differ from source`);
    assets.push({
      id: `P21-3D-${asset.toUpperCase()}-${quality.toUpperCase()}`,
      asset,
      quality,
      path: `assets/p21/three/exports/${asset}-${quality}.glb`,
      bytes: bytes.byteLength,
      sha256: digest(bytes),
      header: { magic: header.magic, version: header.version, length: header.length, chunks: header.chunks },
      embeddedTextures: header.json.images?.length ?? 0,
      externalUris: (header.json.buffers || []).filter((buffer) => buffer.uri).length,
      source: sourceStats,
      readback: readbackStats,
      readbackMatchesCountsAndBounds: boundsMatch,
    });
  }
}

const packageLicense = await readFile(path.join(dependencyDir, 'LICENSE'), 'utf8');
if (!/MIT License/i.test(packageLicense)) throw new Error('Three.js license metadata does not match the inspected package license');
async function directoryBytes(directory) {
  let total = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const p = path.join(directory, entry.name);
    total += entry.isDirectory() ? await directoryBytes(p) : (await fs.stat(p)).size;
  }
  return total;
}
const referenceInventory = await sourceBounds();
const observedSourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
const manifest = {
  status: 'FULL_FAMILY_PROCEDURAL_SOURCE_AND_GLBS_VALIDATED; VISUAL_REVIEW_PENDING; NOT_RUNTIME_ACTIVATED',
  generatedAt: new Date().toISOString(),
  sourceBase: {
    priorGlyphAndCurrencySliceStart: '576eb54da5700918941cd318b219faaf253d8748',
    fullFamilyExpansionPinnedRevision: '5fc3f957eb6268395b5aa9a2883d46a56b13b85c',
    assetExportRevisionObserved: observedSourceRevision,
    note: 'The source assets, exporters, and exports are uncommitted working-tree inputs. assetExportRevisionObserved records HEAD at export time only; the hashes below identify the actual working inputs and neither revision proves an app release or runtime integration.',
  },
  toolchain: {
    three: { name: threePackage.name, version: threePackage.version, license: 'MIT', path: '.artifacts/p21-three-tools/node_modules/three', productionDependency: false, installedBytes: await directoryBytes(dependencyDir), downloadArchiveBytes: (await fs.stat(path.join(repoRoot, '.artifacts/p21-three-tools/three-0.180.0.tgz'))).size },
    reconstructionGuidance: { name: 'img2threejs', repository: 'https://github.com/img2threejs/img2threejs', skillVersionRead: '2.0.0', license: 'Apache-2.0', use: 'procedural quality-gating approach consulted; no code copied and no host skill installed' },
  },
  sourceImages: referenceInventory.imageReferences,
  referenceFiles: referenceInventory.supportingFiles,
  sourceInventory: {
    rankBadgeCount: Object.keys(rankSourcePaths).length,
    canonicalRankOrder: Object.keys(rankSourcePaths),
    rankSourceMap: Object.entries(rankSourcePaths).map(([rank, sourcePath]) => ({ rank, sourcePath, approvedRasterPath: `assets/p21/art/ranks/${rank}.webp`, sourceNotes: rankMaterialNotes[rank] })),
    awardChest: {
      sourceStatus: 'MISSING_FROM_AVAILABLE_LOCAL_SOURCE_ART',
      searchedSources: ['assets/p21/art/**', 'assets/p21/reference/**', 'docs/p21-web/evidence/**', 'docs/p21-web/ASSET-REGISTRY.md'],
      sourceDerivedDesignLimit: 'The geometry is a provisional decorative black-and-gold closed chest interpretation; no product catalog, reward contents, or economy behavior are represented. It is not traced from owner-supplied chest artwork.',
    },
    currentNeonBoardCard: {
      visualReference: 'docs/p21-web/evidence/41e74bf/home-desktop.png',
      markupReference: 'apps/web/site.js:siteMiniTheme',
      styleReference: 'apps/web/styles.css:.mx-art-board and .mx-art-board.pink',
      markCells: [0, 4, 8],
      xColor: '#27ceff',
      oColor: '#fc75d9',
      xGridColor: '#236caa',
      oGridColor: '#77286c',
      plateBackground: '#031426dd',
      sourceScope: 'decorative standalone solid mesh study; no integration into the approved homepage raster/card or gameplay board',
    },
  },
  sourceCodeReferences: [
    { asset: 'X', path: 'apps/web/board.js', detail: 'X path M10 10 30 30M30 10 10 30; viewBox 0 0 40 40', colorPath: 'apps/web/board.css', color: '#39cfff' },
    { asset: 'O', path: 'apps/web/board.js', detail: 'O circle cx20 cy20 r13; viewBox 0 0 40 40', colorPath: 'apps/web/board.css', color: '#ff63b6' },
    { asset: 'Neon card X/O plates', path: 'apps/web/site.js', detail: 'siteMiniTheme places the selected mark in diagonal cells 0, 4 and 8', colorPath: 'apps/web/styles.css', detail2: '78x123 vertical boards; 3x3 grid; cyan X plate and pink O plate', color: '#27ceff / #fc75d9' },
  ],
  sourceNotes: {
    coin: 'Owner-provided 1254x1254 transparent gold coin reference: raised five-point star, inset face and stacked bright rim. Model uses geometry and PBR only; no exact raster parity claimed.',
    crown: 'Owner-provided 1254x1254 transparent purple crown reference: center and side tines, segmented base and bright tip gems. Model uses geometry and PBR only; no exact raster parity claimed.',
    neonGlyphs: 'Reconstructed as solid 3D counterparts of the existing browser SVG strokes; colors copied from current Mega XOXO Neon CSS. Glow is restrained emissive material, not a baked effect.',
    rankFamily: 'Eleven canonical raster rank designs were inventoried before modeling. SourcePNG prompts and material palettes are recorded in assets/p21/art/ranks/PROMPTS.json; Diamond uses the existing crystal-source.png and diamond.webp. Geometry shares the angular shield/segmented-wing silhouette while tier materials and finials stay distinct. It is not a pixel-exact raster trace.',
    trophy: 'Owner-provided transparent trophy source inspected: wide gold handled bowl, raised five-point star, laurel-like side ornaments, narrow neck and black/gold stepped pedestal. Model reconstructs the visible forms as genuine geometry; no exact raster parity claimed.',
    rewardChest: 'No owner-supplied reward-chest source image exists in the available asset registry; this is an explicitly provisional closed black-and-gold decorative chest geometry, with no visible contents or claimed economy meaning.',
    boardPlates: 'The approved home capture and current siteMiniTheme/CSS were inspected. Two independent vertical boards reproduce the three diagonal X or O mark positions and current Neon edge/grid palette as 3D mesh plates. They are decorative standalone studies, not replacements for the approved card render.',
    materialLimits: 'Materials use procedural MeshStandardMaterial PBR values only. There are no image textures, normal maps, roughness maps or metalness maps; wood grain, stone microtexture and iridescent fine detail remain open.',
  },
  authoredSourceFiles: [],
  detailInventory: {
    X: ['two independently editable rounded rectangular crossed extrusions'],
    O: ['one closed continuous torus with rounded cross-section'],
    Coin: ['solid coin blank', 'inset circular face', 'two front rim details', 'back edge bead', 'raised beveled five-point star'],
    Crown: ['three-point extruded shell', 'split tine facets', 'five separate raised band panels', 'two curved band rails', 'three faceted tip gems'],
    RankBadges: Object.fromEntries(Object.entries(rankMaterialNotes).map(([rank, detail]) => [rank, [
      'dark rear shield/backplate', 'raised material-specific shield frame', 'inset central relief plates',
      'three independently extruded feather segments per wing', ...(rank === 'master' || rank === 'grandmaster' ? ['fourth upper feather segment per wing'] : []),
      detail, ...(rank === 'champion' ? ['single raised ruby finial'] : []), ...(rank === 'master' || rank === 'grandmaster' ? ['three raised tier finials'] : []),
      ...(rank === 'wood' ? ['carved wood-color relief; no wood grain texture'] : []), ...(rank === 'stone' ? ['chiseled stone-color relief; no stone texture'] : []),
    ]])),
    Trophy: ['hollow lathed cup', 'separate curled tube handles', 'raised cup lip and five-point front star', 'ten modeled laurel leaves', 'lathed neck/collar/stem', 'black stepped pedestal and blank award plate'],
    RewardChest: ['closed black box body', 'curved extruded lid', 'raised front and top panels', 'paired gold straps and rivets', 'blank shield latch and keyhole', 'low plinth; no contents or catalog semantics'],
    BoardX: ['rounded extruded vertical backplate, perimeter and inset face', 'four raised 3x3 grid lines', 'three independent beveled X marks in diagonal cells'],
    BoardO: ['rounded extruded vertical backplate, perimeter and inset face', 'four raised 3x3 grid lines', 'three independent torus O marks in diagonal cells'],
  },
  preview: {
    status: 'NOT_RENDERED',
    files: ['assets/p21/three/preview.html', 'assets/p21/three/preview.mjs'],
    reason: 'CUA could not create an isolated Chrome browser tab (browser unavailable); selecting the separate Chrome-for-Testing app timed out. Existing Brave tabs were left untouched.',
  },
  outputRules: {
    materials: 'MeshStandardMaterial glTF metallic-roughness PBR; scalar and color values recorded per output',
    normalsAndUVs: 'required on every mesh and revalidated after GLTFLoader readback',
    texturePolicy: 'no image textures, no external buffer/image URIs',
    coordinates: 'front +Z, vertical +Y, named center Pivot, root unit scale 1',
  },
  assets,
  openAcceptance: [
    'Human visual comparison against original masters and owner art approval',
    'Device/browser performance and end-use scale review',
    'Lighting, transparent turntable PNG/WebP, mobile-safe texture/material budget; not in this slice',
    'Wood grain, stone microtexture and crystal normal/roughness/metalness map review; no texture maps are fabricated',
    'Award chest owner source/art direction is missing; review this provisional geometry before any use',
    'Cinematic board, remaining glyph/motion/icon assets outside this commissioned family',
  ],
};
for (const relativePath of [
  'assets/p21/three/factories.mjs',
  'assets/p21/three/preview.html',
  'assets/p21/three/preview.mjs',
  'assets/p21/three/README.md',
  'scripts/p21/export-three.mjs',
  'scripts/p21/three-qa.cjs',
]) {
  const source = await readFile(path.join(repoRoot, relativePath));
  manifest.authoredSourceFiles.push({ path: relativePath, bytes: source.byteLength, sha256: digest(source) });
}
await fs.writeFile(path.join(repoRoot, 'assets/p21/three/provenance.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ status: manifest.status, three: `${threePackage.name}@${threePackage.version}`, assets: assets.map(({ id, bytes, sha256, source, readbackMatchesCountsAndBounds }) => ({ id, bytes, sha256, source: { meshCount: source.meshCount, vertices: source.vertices, triangles: source.triangles, bounds: source.bounds }, readbackMatchesCountsAndBounds })), manifest: 'assets/p21/three/provenance.json' }, null, 2));
