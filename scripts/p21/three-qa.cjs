'use strict';

// Strict local Chromium matrix for the P21 source-mesh GLBs. This server has an
// explicit path allowlist; it never serves a directory or contacts an origin.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const ASSET_DIR = path.join(ROOT, 'assets/p21/three');
const OUT_DIR = path.join(ASSET_DIR, 'stills');
const TURNTABLE_DIR = path.join(ASSET_DIR, 'turntables');
const TURNTABLE_WORK_DIR = path.join(ROOT, '.artifacts/p21-three-turntable-frames');
const MANIFEST_PATH = path.join(ASSET_DIR, 'provenance.json');
const EVIDENCE_PATH = path.join(ASSET_DIR, 'render-evidence.json');
const EXPECTED_COMMIT = '9df5e8e5cbc92a3832551c160cfef9d15763db45';
const ASSETS = [
  'x', 'o', 'coin', 'crown',
  'rank-wood', 'rank-stone', 'rank-iron', 'rank-bronze', 'rank-silver', 'rank-gold',
  'rank-diamond', 'rank-emerald', 'rank-champion', 'rank-master', 'rank-grandmaster',
  'trophy', 'reward-chest', 'board-x', 'board-o',
];
const QUALITIES = ['high', 'low'];
const VIEWS = ['front', 'quarter'];
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const rel = file => path.relative(ROOT, file).split(path.sep).join('/');

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function directoryBytes(directory) {
  return fs.readdirSync(directory, { withFileTypes:true }).reduce((total, entry) => {
    const absolute=path.join(directory,entry.name);
    return total+(entry.isDirectory()?directoryBytes(absolute):fs.statSync(absolute).size);
  },0);
}

function expectedSourceHash(manifest, file) {
  return manifest.authoredSourceFiles?.find(item => item.path === file)?.sha256;
}

function getInputSnapshot(manifest) {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (revision !== EXPECTED_COMMIT) throw new Error(`Source revision changed during this matrix: expected ${EXPECTED_COMMIT}, observed ${revision}`);
  const files = [
    'assets/p21/three/factories.mjs',
    'scripts/p21/export-three.mjs',
    ...ASSETS.flatMap(asset => QUALITIES.map(quality => `assets/p21/three/exports/${asset}-${quality}.glb`)),
  ].map(file => {
    const actual = sha256(fs.readFileSync(path.join(ROOT, file)));
    const expected = file.endsWith('.glb')
      ? manifest.assets?.find(item => item.path === file)?.sha256
      : expectedSourceHash(manifest, file);
    if (!expected || actual !== expected) throw new Error(`Input differs from recorded asset provenance: ${file}`);
    return { path: file, sha256: actual, bytes: fs.statSync(path.join(ROOT, file)).size };
  });
  return { expectedRevision: EXPECTED_COMMIT, observedRevision: revision, files };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function inspectPng(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!bytes.subarray(0, 8).equals(signature)) throw new Error('Renderer output does not have a PNG signature.');
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idats = [];
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idats.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (!width || !height || bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(`Unexpected PNG format: ${width}x${height}, bitDepth=${bitDepth}, colorType=${colorType}, interlace=${interlace}`);
  }
  const raw = zlib.inflateSync(Buffer.concat(idats));
  const stride = width * 4;
  const pixels = Buffer.alloc(height * stride);
  let sourceOffset = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[sourceOffset++];
    const rowStart = y * stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[sourceOffset++];
      const left = x >= 4 ? pixels[rowStart + x - 4] : 0;
      const above = y > 0 ? pixels[rowStart + x - stride] : 0;
      const upperLeft = y > 0 && x >= 4 ? pixels[rowStart + x - stride - 4] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = above;
      else if (filter === 3) predictor = Math.floor((left + above) / 2);
      else if (filter === 4) predictor = paeth(left, above, upperLeft);
      else if (filter !== 0) throw new Error(`Unsupported PNG row filter: ${filter}`);
      pixels[rowStart + x] = (value + predictor) & 255;
    }
  }
  let transparentPixels = 0, opaquePixels = 0, visiblePixels = 0;
  let minX = width, minY = height, maxX = -1, maxY = -1, alphaMin = 255, alphaMax = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const alpha = pixels[(y * width + x) * 4 + 3];
    if (alpha < alphaMin) alphaMin = alpha;
    if (alpha > alphaMax) alphaMax = alpha;
    if (alpha === 0) transparentPixels++;
    else {
      visiblePixels++;
      if (alpha === 255) opaquePixels++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return {
    width, height, colorType: 'RGBA8', visiblePixels, transparentPixels, opaquePixels,
    alphaMin, alphaMax,
    alphaCoverage: visiblePixels ? { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
    hasTransparentBackground: transparentPixels > 0 && visiblePixels > 0,
  };
}

function makeRenderHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=640,initial-scale=1"><link rel="icon" href="data:,"><style>html,body{margin:0;width:640px;height:640px;overflow:hidden;background:transparent}canvas{display:block;width:640px;height:640px}</style>
  <script type="importmap">{"imports":{"three":"/modules/three.module.js"}}</script></head><body><canvas id="stage" width="640" height="640"></canvas><script type="module">
  import * as THREE from '/modules/three.module.js';
  import { GLTFLoader } from '/modules/loaders/GLTFLoader.js';
  import { createAsset } from '/factories.mjs';
  const state = { ready:false, fatal:null, renderer:null, readbacks:{}, errors:[] };
  window.__assetQA = state;
  try {
    const canvas = document.querySelector('#stage');
    const renderer = new THREE.WebGLRenderer({canvas, antialias:true, alpha:true, preserveDrawingBuffer:true, powerPreference:'low-power'});
    renderer.setPixelRatio(1);
    renderer.setSize(640,640,false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.setClearColor(0x000000,0);
    const context = renderer.getContext();
    const glInfo = {
      webglVersion: context.getParameter(context.VERSION),
      shadingLanguageVersion: context.getParameter(context.SHADING_LANGUAGE_VERSION),
      renderer: context.getParameter(context.RENDERER),
      vendor: context.getParameter(context.VENDOR),
      alpha: context.getContextAttributes()?.alpha === true,
    };
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight('#d6eaff','#1a1024',2.15));
    const key = new THREE.DirectionalLight('#fff1d5',4.3); key.position.set(-3.6,5.4,7); scene.add(key);
    const rim = new THREE.DirectionalLight('#78a6ff',2.5); rim.position.set(3.5,2.4,-4); scene.add(rim);
    const fill = new THREE.PointLight('#b84cff',9,10,2); fill.position.set(0,2.7,2); scene.add(fill);
    state.renderer = glInfo;
    function takeErrors() {
      const codes=[];
      for(let i=0;i<64;i++){const code=context.getError();if(code===context.NO_ERROR)break;codes.push('0x'+code.toString(16));}
      return codes;
    }
    const loader = new GLTFLoader();
    state.readAsset = async (asset, quality) => {
      const file = asset+'-'+quality+'.glb';
      const gltf = await loader.loadAsync('/glb/'+file);
      const root = gltf.scene;
      root.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(root);
      const size = bounds.getSize(new THREE.Vector3());
      const counts = {meshCount:0,vertices:0,triangles:0,normalAttributes:0,uvAttributes:0,finite:true,normalsUnit:true};
      root.traverse(object=>{
        if(!object.isMesh)return;
        counts.meshCount++;
        const geometry=object.geometry;
        const p=geometry.getAttribute('position'),n=geometry.getAttribute('normal'),uv=geometry.getAttribute('uv');
        if(!p){counts.finite=false;return;}
        counts.vertices+=p.count;
        counts.triangles+=geometry.index?geometry.index.count/3:p.count/3;
        if(n&&n.itemSize>=3){counts.normalAttributes++;for(let i=0;i<n.count;i++){const l=Math.hypot(n.getX(i),n.getY(i),n.getZ(i));if(!Number.isFinite(l)||Math.abs(l-1)>1e-3)counts.normalsUnit=false;}}
        if(uv&&uv.itemSize>=2)counts.uvAttributes++;
        for(const a of [p,n,uv].filter(Boolean))for(const v of a.array)if(!Number.isFinite(v))counts.finite=false;
      });
      const pivot=root.getObjectByName('Pivot');
      const result={file,...counts,bounds:{min:[bounds.min.x,bounds.min.y,bounds.min.z],max:[bounds.max.x,bounds.max.y,bounds.max.z],size:[size.x,size.y,size.z]},pivot:pivot?pivot.position.toArray():null,rootScale:root.scale.toArray()};
      state.readbacks[file]=result;
      return result;
    };
    state.renderAsset = async (asset, quality, view, options={}) => {
      const width=options.width||640,height=options.height||640;
      renderer.setSize(width,height,false);
      const root=createAsset(THREE,asset,quality);
      const bounds=new THREE.Box3().setFromObject(root);
      const center=bounds.getCenter(new THREE.Vector3());
      const size=bounds.getSize(new THREE.Vector3());
      const frame=Math.max(size.x,size.y,size.z)*1.34;
      const camera=new THREE.OrthographicCamera(-frame/2,frame/2,frame/2,-frame/2,0.01,100);
      if(view==='front')camera.position.copy(center).add(new THREE.Vector3(0,0,5));
      else if(view==='turntable') {
        const angle=options.angle||0;
        const distance=Math.max(size.x,size.y,size.z)*3.2;
        camera.position.copy(center).add(new THREE.Vector3(Math.sin(angle)*distance,Math.max(size.x,size.y)*0.09,Math.cos(angle)*distance));
      } else camera.position.copy(center).add(new THREE.Vector3(3.1,1.65,4.1));
      camera.up.set(0,1,0);camera.lookAt(center);
      scene.add(root);renderer.info.reset();
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      renderer.render(scene,camera);
      const errors=takeErrors();
      const result={asset,quality,view,width,height,triangles:renderer.info.render.triangles,drawCalls:renderer.info.render.calls,webglErrors:errors,pngDataUrl:canvas.toDataURL('image/png'),canvasAlpha:renderer.getContextAttributes()?.alpha===true};
      scene.remove(root);
      root.traverse(object=>{if(object.isMesh){object.geometry.dispose();const list=Array.isArray(object.material)?object.material:[object.material];list.forEach(m=>m.dispose());}});
      return result;
    };
    // Drain initialization errors before the per-image error counter begins.
    state.initializationWebglErrors=takeErrors();
    state.ready=true;
  } catch(error) {
    state.fatal=String(error?.message||error).slice(0,500);
    state.ready=true;
  }
  </script></body></html>`;
}

function createAllowlistedServer(manifest, audit) {
  const files = new Map();
  const addFile = (urlPath, relativePath, contentType) => {
    const absolute = path.resolve(ROOT, relativePath);
    if (!absolute.startsWith(ROOT + path.sep)) throw new Error('Allowlist target escaped the checkout.');
    files.set(urlPath, { bytes: fs.readFileSync(absolute), contentType, source: relativePath });
  };
  files.set('/render.html', { bytes: Buffer.from(makeRenderHtml()), contentType: 'text/html; charset=utf-8', source: 'in-memory controlled harness' });
  addFile('/factories.mjs', 'assets/p21/three/factories.mjs', 'text/javascript; charset=utf-8');
  addFile('/modules/three.module.js', '.artifacts/p21-three-tools/node_modules/three/build/three.module.js', 'text/javascript; charset=utf-8');
  addFile('/modules/three.core.js', '.artifacts/p21-three-tools/node_modules/three/build/three.core.js', 'text/javascript; charset=utf-8');
  addFile('/modules/loaders/GLTFLoader.js', '.artifacts/p21-three-tools/node_modules/three/examples/jsm/loaders/GLTFLoader.js', 'text/javascript; charset=utf-8');
  addFile('/modules/utils/BufferGeometryUtils.js', '.artifacts/p21-three-tools/node_modules/three/examples/jsm/utils/BufferGeometryUtils.js', 'text/javascript; charset=utf-8');
  for (const asset of ASSETS) for (const quality of QUALITIES) {
    const name = `${asset}-${quality}.glb`;
    addFile(`/glb/${name}`, `assets/p21/three/exports/${name}`, 'model/gltf-binary');
  }
  audit.allowedPaths = [...files.keys()].sort();
  return http.createServer((req, res) => {
    if (req.method !== 'GET') {
      audit.disallowedRequests.push({ method:req.method, path:String(req.url).slice(0,180), status:405 });
      res.writeHead(405, { 'cache-control':'no-store', 'content-length':'0' }); res.end(); return;
    }
    let pathname;
    try { pathname = new URL(req.url, 'http://127.0.0.1').pathname; }
    catch { pathname = ''; }
    const file = files.get(pathname);
    if (!file) {
      audit.disallowedRequests.push({ method:req.method, path:String(pathname).slice(0,180), status:404 });
      res.writeHead(404, { 'cache-control':'no-store', 'content-length':'0' }); res.end(); return;
    }
    audit.servedPaths.push({ path:pathname, source:file.source, bytes:file.bytes.byteLength });
    res.writeHead(200, { 'content-type':file.contentType, 'content-length':file.bytes.byteLength, 'cache-control':'no-store', 'x-content-type-options':'nosniff' });
    res.end(file.bytes);
  });
}

async function main() {
  const manifest = readJson(MANIFEST_PATH);
  const inputs = getInputSnapshot(manifest);
  fs.mkdirSync(OUT_DIR, { recursive:true });
  const evidence = {
    schemaVersion:1,
    startedAt:new Date().toISOString(),
    status:'RUNNING',
    sourceCommit:inputs.observedRevision,
    sourceRevisionExpected:EXPECTED_COMMIT,
    inputs,
    framework:{ name:'Playwright', version:require('playwright/package.json').version, browserEngine:'Chromium', headless:true },
    execution:{
      context:'fresh unauthenticated headless BrowserContext; service workers blocked; no page scripts, cookies or local storage imported from user profiles',
      network:'ephemeral 127.0.0.1 listener with exact allowlist; Playwright route aborts every non-loopback origin before network; no external traffic permitted',
      server:{ allowedPaths:[], servedPaths:[], disallowedRequests:[], blockedExternalOrigins:[] },
      consoleErrors:[], pageErrors:[], renderer:null, initializationWebglErrors:[],
    },
    matrix:[],
    checks:[],
    failures:[],
    stillDirectory:'assets/p21/three/stills',
  };
  let playwright, browser, context, page, server, origin;
  const check = (id, passed, details={}) => {
    const item={id,result:passed?'PASS':'FAIL',...details};
    evidence.checks.push(item); if(!passed)evidence.failures.push(item); return passed;
  };
  try {
    playwright = require('playwright');
    const audit=evidence.execution.server;
    server=createAllowlistedServer(manifest,audit);
    server.listen(0,'127.0.0.1');
    await once(server,'listening');
    origin=`http://127.0.0.1:${server.address().port}`;
    browser=await playwright.chromium.launch({headless:true,args:['--enable-webgl','--enable-unsafe-swiftshader','--use-angle=swiftshader']});
    evidence.framework.browserVersion=browser.version();
    context=await browser.newContext({viewport:{width:640,height:640},deviceScaleFactor:1,serviceWorkers:'block',acceptDownloads:false});
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin===origin) return route.continue();
      audit.blockedExternalOrigins.push(url.origin);
      return route.abort('blockedbyclient');
    });
    page=await context.newPage();
    page.on('console',message=>{if(message.type()==='error')evidence.execution.consoleErrors.push(message.text().slice(0,500));});
    page.on('pageerror',error=>evidence.execution.pageErrors.push(String(error.message).slice(0,500)));
    await page.goto(origin+'/render.html',{waitUntil:'domcontentloaded',timeout:30000});
    await page.waitForFunction(()=>window.__assetQA?.ready===true,{timeout:30000});
    const initialized=await page.evaluate(()=>({fatal:window.__assetQA.fatal,renderer:window.__assetQA.renderer,initializationWebglErrors:window.__assetQA.initializationWebglErrors||[]}));
    evidence.execution.renderer=initialized.renderer;
    evidence.execution.initializationWebglErrors=initialized.initializationWebglErrors;
    if(initialized.fatal) throw new Error(`WebGL harness initialization failed: ${initialized.fatal}`);
    check('THREE-QA-WEBGL-CONTEXT',initialized.renderer?.alpha===true,{renderer:initialized.renderer});
    check('THREE-QA-INIT-WEBGL-ERRORS',initialized.initializationWebglErrors.length===0,{errors:initialized.initializationWebglErrors});

    const expectedByFile=new Map(manifest.assets.map(item=>[path.basename(item.path),item.readback]));
    for(const asset of ASSETS) for(const quality of QUALITIES) {
      const glbFile=`${asset}-${quality}.glb`;
      const readback=await page.evaluate(async ({asset,quality})=>window.__assetQA.readAsset(asset,quality),{asset,quality});
      const expected=expectedByFile.get(glbFile);
      const countsMatch=Boolean(expected)&&readback.meshCount===expected.meshCount&&readback.vertices===expected.vertices&&readback.triangles===expected.triangles;
      const attributesValid=readback.finite&&readback.normalsUnit&&readback.meshCount===readback.normalAttributes&&readback.meshCount===readback.uvAttributes;
      const pivotValid=Array.isArray(readback.pivot)&&readback.pivot.every(value=>Math.abs(value)<1e-6)&&readback.rootScale?.every(value=>Math.abs(value-1)<1e-6);
      check('THREE-QA-GLTF-READBACK',countsMatch&&attributesValid&&pivotValid,{file:glbFile,meshCount:readback.meshCount,vertices:readback.vertices,triangles:readback.triangles,normalAttributes:readback.normalAttributes,uvAttributes:readback.uvAttributes,finite:readback.finite,normalsUnit:readback.normalsUnit,pivot:readback.pivot,rootScale:readback.rootScale,bounds:readback.bounds});
      for(const view of VIEWS) {
        const rendered=await page.evaluate(async ({asset,quality,view})=>window.__assetQA.renderAsset(asset,quality,view),{asset,quality,view});
        const comma=rendered.pngDataUrl.indexOf(',');
        if(!rendered.pngDataUrl.startsWith('data:image/png;base64,')||comma<0) throw new Error(`Unexpected browser still format for ${glbFile} ${view}`);
        const png=Buffer.from(rendered.pngDataUrl.slice(comma+1),'base64');
        const pixel=inspectPng(png);
        const fileName=`${asset}-${quality}-${view}.png`;
        const destination=path.join(OUT_DIR,fileName);
        fs.writeFileSync(destination,png);
        const image={asset,quality,view,file:rel(destination),bytes:png.byteLength,sha256:sha256(png),pixel,renderTriangles:rendered.triangles,sourceTriangles:readback.triangles,drawCalls:rendered.drawCalls,canvasAlpha:rendered.canvasAlpha,webglErrors:rendered.webglErrors};
        evidence.matrix.push(image);
        check('THREE-QA-TRANSPARENT-STILL',pixel.width===640&&pixel.height===640&&pixel.visiblePixels>0&&pixel.hasTransparentBackground&&rendered.canvasAlpha===true,{file:image.file,width:pixel.width,height:pixel.height,visiblePixels:pixel.visiblePixels,transparentPixels:pixel.transparentPixels,alphaCoverage:pixel.alphaCoverage,canvasAlpha:rendered.canvasAlpha});
        check('THREE-QA-RENDER-TRIANGLES',rendered.triangles===readback.triangles&&rendered.triangles>0,{file:glbFile,view,renderTriangles:rendered.triangles,readbackTriangles:readback.triangles});
        check('THREE-QA-WEBGL-ERRORS',rendered.webglErrors.length===0,{file:glbFile,view,errors:rendered.webglErrors});
      }
    }

    const turntable={status:'PENDING',frameCountPerAsset:8,width:240,height:240,fps:8,codec:'VP9 WebM',transparentSourceFrames:true,items:[],failures:[]};
    fs.rmSync(TURNTABLE_DIR,{recursive:true,force:true});
    fs.rmSync(TURNTABLE_WORK_DIR,{recursive:true,force:true});
    fs.mkdirSync(TURNTABLE_DIR,{recursive:true});
    fs.mkdirSync(TURNTABLE_WORK_DIR,{recursive:true});
    try {
      for(const asset of ASSETS) {
        const frameDir=path.join(TURNTABLE_WORK_DIR,asset);
        fs.mkdirSync(frameDir,{recursive:true});
        const frames=[];
        for(let frameIndex=0;frameIndex<turntable.frameCountPerAsset;frameIndex++) {
          const angle=(Math.PI*2*frameIndex)/turntable.frameCountPerAsset;
          const rendered=await page.evaluate(async ({asset,quality,angle,width,height})=>window.__assetQA.renderAsset(asset,quality,'turntable',{angle,width,height}),{asset,quality:'high',angle,width:turntable.width,height:turntable.height});
          const comma=rendered.pngDataUrl.indexOf(',');
          if(!rendered.pngDataUrl.startsWith('data:image/png;base64,')||comma<0)throw new Error(`Unexpected turntable frame format for ${asset} #${frameIndex}`);
          const png=Buffer.from(rendered.pngDataUrl.slice(comma+1),'base64');
          const pixel=inspectPng(png);
          if(pixel.width!==turntable.width||pixel.height!==turntable.height||!pixel.hasTransparentBackground||!rendered.canvasAlpha||rendered.webglErrors.length)throw new Error(`Turntable frame checks failed for ${asset} #${frameIndex}`);
          const framePath=path.join(frameDir,`frame-${String(frameIndex).padStart(2,'0')}.png`);
          fs.writeFileSync(framePath,png);
          frames.push({index:frameIndex,angleRadians:Number(angle.toFixed(6)),bytes:png.byteLength,sha256:sha256(png),alpha:true,triangles:rendered.triangles});
        }
        const output=path.join(TURNTABLE_DIR,`${asset}-high-turntable.webm`);
        execFileSync('ffmpeg',['-y','-hide_banner','-loglevel','error','-framerate',String(turntable.fps),'-i',path.join(frameDir,'frame-%02d.png'),'-frames:v',String(turntable.frameCountPerAsset),'-an','-c:v','libvpx-vp9','-crf','45','-b:v','0','-pix_fmt','yuva420p','-auto-alt-ref','0','-deadline','good','-cpu-used','5',output],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
        const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-count_frames','-select_streams','v:0','-show_entries','stream=codec_name,width,height,pix_fmt,nb_read_frames','-of','json',output],{cwd:ROOT,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
        const stream=probe.streams?.[0];
        if(stream?.codec_name!=='vp9'||stream.width!==turntable.width||stream.height!==turntable.height||Number(stream.nb_read_frames)!==turntable.frameCountPerAsset)throw new Error(`Encoded turntable readback failed for ${asset}`);
        const video=fs.readFileSync(output);
        turntable.items.push({asset,file:rel(output),bytes:video.byteLength,sha256:sha256(video),stream:{codec:stream.codec_name,width:stream.width,height:stream.height,pixelFormat:stream.pix_fmt,frameCount:Number(stream.nb_read_frames)},source:'eight separate 3D factory mesh renders captured in isolated headless Chromium; PNG frames kept only in ignored scratch during encoding',frames});
      }
      const packBytes=directoryBytes(ASSET_DIR);
      if(packBytes>14880000)throw new Error(`Combined 3D asset pack with a 120,000-byte metadata safety margin would exceed the 15,000,000-byte ceiling (${packBytes} bytes before final evidence)`);
      turntable.totalBytes=turntable.items.reduce((sum,item)=>sum+item.bytes,0);
      turntable.assetTreeBytes=packBytes;
      turntable.status='PASS';
      check('THREE-QA-TURNTABLE-ENCODED',turntable.items.length===ASSETS.length,{count:turntable.items.length,totalBytes:turntable.totalBytes,assetTreeBytes:packBytes});
    } catch(error) {
      turntable.status='NOT_GENERATED_OR_REMOVED';
      turntable.failures.push(String(error?.message||error).slice(0,800));
      fs.rmSync(TURNTABLE_DIR,{recursive:true,force:true});
      turntable.items=[];
    } finally {
      fs.rmSync(TURNTABLE_WORK_DIR,{recursive:true,force:true});
    }
    evidence.turntables=turntable;
    check('THREE-QA-ALLOWLIST',audit.disallowedRequests.length===0&&audit.blockedExternalOrigins.length===0,{disallowedRequests:audit.disallowedRequests,blockedExternalOrigins:audit.blockedExternalOrigins,allowedPathCount:audit.allowedPaths.length});
    check('THREE-QA-BROWSER-ERRORS',evidence.execution.consoleErrors.length===0&&evidence.execution.pageErrors.length===0,{consoleErrors:evidence.execution.consoleErrors,pageErrors:evidence.execution.pageErrors});
  } catch(error) {
    evidence.failures.push({id:'THREE-QA-EXECUTION',result:'FAIL',message:String(error?.message||error).slice(0,800)});
  } finally {
    await context?.close().catch(()=>{});
    await browser?.close().catch(()=>{});
    if(server) await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
    evidence.completedAt=new Date().toISOString();
    evidence.status=evidence.failures.length===0&&evidence.matrix.length===ASSETS.length*QUALITIES.length*VIEWS.length?'PASS':'FAIL';
    evidence.renderedStillCount=evidence.matrix.length;
    evidence.totalStillBytes=evidence.matrix.reduce((sum,item)=>sum+item.bytes,0);
    evidence.execution.server.servedPathCount=evidence.execution.server.servedPaths.length;
    evidence.execution.server.restrictedToLoopback=true;
    evidence.execution.server.externalTrafficAllowed=false;
    evidence.checkSummary={passed:evidence.checks.filter(item=>item.result==='PASS').length,failed:evidence.failures.length,skipped:evidence.checks.filter(item=>item.result==='SKIP').length};
    fs.writeFileSync(EVIDENCE_PATH,JSON.stringify(evidence,null,2)+'\n');
    const updated=readJson(MANIFEST_PATH);
    const result=evidence.status==='PASS'?'RENDERED':'RENDER_FAILED_OR_INCOMPLETE';
    updated.preview={
      ...(updated.preview||{}),
      status:result,
      renderer:'headless Chromium via repository-installed Playwright 1.62.1; isolated WebGL context; source factory renders and GLBs read back in browser',
      evidencePath:rel(EVIDENCE_PATH),
      stillDirectory:rel(OUT_DIR),
      renderedStillCount:evidence.renderedStillCount,
      browserMatrixStatus:evidence.status,
      visualOwnerReview:'PENDING',
      ...(evidence.status==='PASS'?{reason:null}:{reason:evidence.failures[0]?.message||'One or more renderer, transparency, GLB readback, or browser checks failed.'}),
    };
    updated.turntables={
      status:evidence.turntables?.status||'NOT_GENERATED',
      format:'VP9 WebM',
      directory:evidence.turntables?.items?.length?rel(TURNTABLE_DIR):null,
      assetCount:evidence.turntables?.items?.length||0,
      perAssetFrameCount:evidence.turntables?.frameCountPerAsset||8,
      totalBytes:evidence.turntables?.totalBytes||0,
      assetTreeBytes:evidence.turntables?.assetTreeBytes||directoryBytes(ASSET_DIR),
      provenance:'Real separate frames rendered from high-detail editable factory meshes by isolated headless Chromium; FFmpeg encodes them; frame hashes, stream readback and video hashes are in render-evidence.json.',
      failures:evidence.turntables?.failures||[],
    };
    updated.status=evidence.status==='PASS'
      ?'COMMISSIONED_19_ASSET_SOURCE_AND_GLBS_VALIDATED; TRANSPARENT_STILLS_RENDERED; VISUAL_OWNER_REVIEW_PENDING; NOT_RUNTIME_ACTIVATED'
      :'COMMISSIONED_19_ASSET_SOURCE_AND_GLBS_VALIDATED; RASTER_PREVIEW_FAILED_OR_INCOMPLETE; VISUAL_OWNER_REVIEW_PENDING; NOT_RUNTIME_ACTIVATED';
    fs.writeFileSync(MANIFEST_PATH,JSON.stringify(updated,null,2)+'\n');
    let measuredAssetTreeBytes=directoryBytes(ASSET_DIR);
    if(measuredAssetTreeBytes>15000000&&evidence.turntables?.status==='PASS') {
      fs.rmSync(TURNTABLE_DIR,{recursive:true,force:true});
      evidence.turntables.status='NOT_GENERATED_OR_REMOVED';
      evidence.turntables.items=[];
      evidence.turntables.failures.push(`Generated videos were removed to preserve the 15,000,000-byte pack ceiling; final pre-removal size was ${measuredAssetTreeBytes} bytes.`);
      const turntableCheck=evidence.checks.find(item=>item.id==='THREE-QA-TURNTABLE-ENCODED');
      if(turntableCheck){turntableCheck.result='SKIP';turntableCheck.reason='Optional turntables exceeded the final pack-size ceiling and were removed.';}
      updated.turntables.status=evidence.turntables.status;
      updated.turntables.directory=null;
      updated.turntables.assetCount=0;
      updated.turntables.totalBytes=0;
      updated.turntables.failures=evidence.turntables.failures;
      evidence.checkSummary={passed:evidence.checks.filter(item=>item.result==='PASS').length,failed:evidence.failures.length,skipped:evidence.checks.filter(item=>item.result==='SKIP').length};
      fs.writeFileSync(EVIDENCE_PATH,JSON.stringify(evidence,null,2)+'\n');
      fs.writeFileSync(MANIFEST_PATH,JSON.stringify(updated,null,2)+'\n');
      measuredAssetTreeBytes=directoryBytes(ASSET_DIR);
    }
    updated.turntables.assetTreeBytes=measuredAssetTreeBytes;
    fs.writeFileSync(MANIFEST_PATH,JSON.stringify(updated,null,2)+'\n');
    measuredAssetTreeBytes=directoryBytes(ASSET_DIR);
    process.stdout.write(JSON.stringify({status:evidence.status,sourceCommit:evidence.sourceCommit,playwright:evidence.framework,renderer:evidence.execution.renderer,stills:evidence.renderedStillCount,bytes:evidence.totalStillBytes,assetTreeBytes:measuredAssetTreeBytes,turntables:{status:evidence.turntables?.status,count:evidence.turntables?.items?.length||0,bytes:evidence.turntables?.totalBytes||0,failures:evidence.turntables?.failures||[]},triangleCounts:evidence.matrix.map(item=>({asset:item.asset,quality:item.quality,view:item.view,triangles:item.sourceTriangles,bytes:item.bytes,alpha:item.pixel.hasTransparentBackground,webglErrors:item.webglErrors.length})),checks:evidence.checkSummary,evidence:rel(EVIDENCE_PATH),failures:evidence.failures.slice(0,5)},null,2)+'\n');
    if(evidence.status!=='PASS')process.exitCode=1;
  }
}

main().catch(error=>{process.stderr.write(String(error?.message||error)+'\n');process.exitCode=1;});
