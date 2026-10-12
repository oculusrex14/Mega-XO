'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const P=require('../../src/bot/pack.js'),C=require('../../src/bot/contracts.js');
/* The pinned onnxruntime-web dist is gitignored (install is a documented, network-backed CI step of
 * the neural workflow). The staging tests below verify REAL sealed bytes, so they must SKIP with an
 * explicit reason rather than fail when that optional toolroot is absent — never silently pass. */
const ORT_DIST=require('node:path').resolve(__dirname,'../../.artifacts/v51/ort/node_modules/onnxruntime-web/dist');
const ORT_GATE=require('node:fs').existsSync(ORT_DIST)?false:'no pinned onnxruntime-web dist';
const bytes=new Uint8Array([1,2,3,4]),hash=crypto.createHash('sha256').update(bytes).digest('hex'),info={schemaVersion:1,version:'test-v1',ruleset:C.RULESET,encodingVersion:P.ENCODING,sha256:hash,url:'/game/ai/'+hash+'.onnx',bytes:4,gzipBytes:4,deploymentStatus:'APPROVED'};
function fixture(fetcher=async()=>new Response(bytes)){const data=new Map(),cache={async match(k){return data.get(k)?.clone();},async put(k,v){data.set(k,v.clone());},async delete(k){return data.delete(k);}};const states=[];return {data,states,store:new P.Store({baseURL:'https://game.example/game/index.html',cacheStorage:{open:async()=>cache},fetcher,catalog:[info],onState:s=>states.push(s)})};}
test('no network download without explicit consent; approved pin survives a new store and offline cache read',async()=>{let calls=0;const f=fixture(async()=>{calls++;return new Response(bytes);});await assert.rejects(f.store.download(info),/CONSENT/);assert.equal(calls,0);await f.store.download(info,{consent:true});const pin=f.store.pin(info);assert.equal(pin.modelHash,hash);const second=new P.Store({baseURL:f.store.baseURL,cacheStorage:f.store.caches,fetcher:async()=>{throw Error('offline');}});assert.deepEqual(await second.read(info),bytes);assert.equal(P.resolvePinned(pin,[info]),info);await second.remove(info);assert.equal(await second.read(info),null);});
test('corrupt, oversized and incompatible artifacts never become a ready pack',async()=>{for(const body of [new Uint8Array([9,2,3,4]),new Uint8Array(5)]){const f=fixture(async()=>new Response(body));await assert.rejects(f.store.download(info,{consent:true}));assert.equal(f.data.size,0);assert.equal(f.store.state.status,'corrupt');}assert.throws(()=>P.manifest({...info,url:'https://other.example/'+hash+'.onnx'},'https://game.example/'),/URL_INVALID/);assert.throws(()=>P.manifest({...info,encodingVersion:'other'},'https://game.example/'),/INCOMPATIBLE/);});
test('pause cancels pending bytes and late replies cannot mark a pack ready',async()=>{let reply;const f=fixture(()=>new Promise(resolve=>{reply=resolve;}));const pending=f.store.download(info,{consent:true});while(!reply)await new Promise(resolve=>setImmediate(resolve));f.store.pause();reply(new Response(bytes));await assert.rejects(pending,{name:'AbortError'});assert.equal(f.store.state.status,'paused');assert.equal(f.data.size,0);});
test('cached corruption is removed and an unapproved model is never labeled playable Impossible',async()=>{const f=fixture();await f.store.download(info,{consent:true});const key=[...f.data.keys()][0];f.data.set(key,new Response(new Uint8Array([0,0,0,0])));await assert.rejects(f.store.read(info),/HASH/);assert.equal(f.data.size,0);await f.store.download(info,{consent:true});assert.throws(()=>f.store.pin({...info,deploymentStatus:'UNAPPROVED'}),/NOT_APPROVED_READY/);assert.equal(P.APPROVED_CATALOG.length,0);});
test('remove waits for all old cache writes and cannot be undone by a late download',async()=>{
 const data=new Map(),writes=[];
 const cache={async match(k){return data.get(k)?.clone();},async delete(k){return data.delete(k);},async put(k,v){await new Promise(resolve=>writes.push(resolve));data.set(k,v.clone());}};
 const store=new P.Store({baseURL:'https://game.example/',cacheStorage:{open:async()=>cache},fetcher:async()=>new Response(bytes)});
 const first=store.download(info,{consent:true}),firstRejected=assert.rejects(first,{name:'AbortError'});
 while(writes.length<1)await new Promise(r=>setImmediate(r));
 const second=store.download(info,{consent:true}),secondRejected=assert.rejects(second,{name:'AbortError'});
 while(writes.length<2)await new Promise(r=>setImmediate(r));
 const removed=store.remove(info);await assert.rejects(store.download(info,{consent:true}),/PACK_BUSY/);
 writes[1]();writes[0]();await Promise.all([removed,firstRejected,secondRejected]);assert.equal(data.size,0);assert.equal(store.state.status,'unavailable');
});
test('a default catalog never approves arbitrary metadata or cached oversized content',async()=>{
 const f=fixture();await f.store.download(info,{consent:true});f.store.catalog=[];assert.throws(()=>f.store.pin(info),/NOT_APPROVED_READY/);
 const key=[...f.data.keys()][0];f.data.set(key,new Response(new Uint8Array(5)));await assert.rejects(f.store.read(info),/SIZE/);assert.equal(f.data.size,0);
});
test('private research data can be verified and cached but never pinned for playable Impossible',async()=>{
 const rBytes=new Uint8Array([5,6,7,8]),rHash=crypto.createHash('sha256').update(rBytes).digest('hex');
 const researchInfo={schemaVersion:1,version:'research-candidate-v1',ruleset:C.RULESET,encodingVersion:P.ENCODING,sha256:rHash,url:'/game/ai/'+rHash+'.onnx',bytes:4,gzipBytes:4,deploymentStatus:'RESEARCH'};
 const f=fixture(async()=>new Response(rBytes));
 f.store.setCatalog([researchInfo]);
 await f.store.download(researchInfo,{consent:true});
 const pin={packVersion:researchInfo.version,modelHash:rHash,ruleset:researchInfo.ruleset,encodingVersion:researchInfo.encodingVersion};
 assert.throws(()=>f.store.pin(researchInfo),/NOT_APPROVED_READY/);
 assert.equal(P.resolvePinned(pin,[researchInfo]),null);
 assert.equal(P.resolvePinned(pin,P.APPROVED_CATALOG),null);
 assert.equal(P.APPROVED_CATALOG.length,0);
 assert.throws(()=>P.manifest({...researchInfo,deploymentStatus:'INVALID_STATUS'},'https://game.example/'),/INCOMPATIBLE/);
});
test('recovery after corruption allows successful re-download and restores ready state',async()=>{
 const f=fixture();
 await f.store.download(info,{consent:true});
 const key=[...f.data.keys()][0];
 f.data.set(key,new Response(new Uint8Array([0,0,0,0])));
 await assert.rejects(f.store.read(info),/HASH/);
 assert.equal(f.store.state.status,'corrupt');
 assert.equal(f.data.size,0);
 await f.store.download(info,{consent:true});
 assert.equal(f.store.state.status,'ready');
 assert.equal(f.store.state.modelHash,hash);
 assert.equal(f.data.size,1);
});
test('stage-ai-runtime tool generates compliant immutable model manifests and research catalog',{skip:ORT_GATE},async()=>{
 const stageTool=require('../../scripts/v51/stage-ai-runtime.cjs');
 assert.equal(stageTool.PINNED_ORT_VERSION,'1.23.2');
 const dummyModelPath=require('node:path').resolve(__dirname,'../../.artifacts/v51/dummy-candidate.onnx');
 const dummyTargetDir=require('node:path').resolve(__dirname,'../../.artifacts/v51/staged-models/dummy');
 require('node:fs').mkdirSync(require('node:path').dirname(dummyModelPath),{recursive:true});
 require('node:fs').writeFileSync(dummyModelPath,new Uint8Array([1,2,3,4,5,6,7,8]));
 const staged=stageTool.stageCandidateModel({modelPath:dummyModelPath,targetDir:dummyTargetDir,version:'research-preview-v1',deploymentStatus:'RESEARCH'});
 assert.equal(staged.manifest.schemaVersion,1);
 assert.equal(staged.manifest.deploymentStatus,'RESEARCH');
 assert.equal(staged.manifest.ruleset,C.RULESET);
 assert.equal(staged.manifest.encodingVersion,P.ENCODING);
 assert.ok(staged.metrics.modelBytes===8);
 assert.ok(staged.metrics.gzipBytes>0);
 const catalog=stageTool.createResearchCatalog([staged.manifest]);
 assert.equal(catalog.length,1);
 assert.equal(catalog[0].deploymentStatus,'RESEARCH');
 assert.throws(()=>stageTool.createResearchCatalog([{...staged.manifest,deploymentStatus:'UNAPPROVED'}]),/RESEARCH/);
 const rtEntries=stageTool.runtimeEntries();
 assert.ok(rtEntries.length>=8);
 assert.ok(rtEntries.some(e=>e.relativePath.endsWith('ort.wasm.min.js')&&e.bytesBuffer&&e.sha256));
 assert.ok(rtEntries.some(e=>e.relativePath.endsWith('LICENSE')&&e.bytesBuffer));
 assert.ok(rtEntries.some(e=>e.relativePath.endsWith('ThirdPartyNotices.txt')&&e.bytesBuffer));
 const fs=require('node:fs'),path=require('node:path');
 for(const filename of ['LICENSE','ThirdPartyNotices.txt']){
  const entry=rtEntries.find(e=>e.relativePath.endsWith('/'+filename));
  const original=fs.readFileSync(path.resolve(__dirname,'../../scripts/v51/ort-1.23.2-'+filename));
  assert.deepEqual(entry.bytesBuffer,original);
  assert.equal(entry.sha256,stageTool.SEALED_LEGAL_FILES[filename].sha256);
  assert.equal(entry.bytes,stageTool.SEALED_LEGAL_FILES[filename].bytes);
  assert.match(entry.source,/a83fc4d58cb48eb68890dd689f94f28288cf2278/);
 }
 const runtimeTarget=path.resolve(__dirname,'../../.artifacts/v51/staged-runtime/unit-dry-run');
 const dry=stageTool.stageRuntime({targetDir:runtimeTarget,dryRun:true});
 assert.equal(dry.manifest.files.length,rtEntries.length);
 assert.equal(dry.manifest.summary.totalBytes,dry.manifest.files.reduce((n,f)=>n+f.bytes,0));
 assert.equal(dry.manifest.summary.totalGzipBytes,dry.manifest.files.reduce((n,f)=>n+f.gzipBytes,0));
 assert.ok(dry.manifest.files.some(f=>f.file==='ThirdPartyNotices.txt'&&f.sha256===stageTool.SEALED_LEGAL_FILES['ThirdPartyNotices.txt'].sha256));
 const mEntry=stageTool.modelCandidateEntries({modelPath:dummyModelPath});
 assert.equal(mEntry.manifest.deploymentStatus,'RESEARCH');
 assert.equal(mEntry.bytes,8);
 // Clean up temporary dummy files
 try{require('node:fs').rmSync(dummyTargetDir,{recursive:true,force:true});}catch{}
 try{require('node:fs').rmSync(dummyModelPath,{force:true});}catch{}
});

test('staging refuses sealed, unowned and linked output paths before mutating artifacts',{skip:ORT_GATE},()=>{
 const fs=require('node:fs'),path=require('node:path'),stage=require('../../scripts/v51/stage-ai-runtime.cjs');
 for(const targetDir of ['.artifacts','.artifacts/v51','.artifacts/p21-web','.artifacts/p21-web/legacy-game','.artifacts/v51/ort']){
  assert.throws(()=>stage.stageRuntime({targetDir}),/owned scratch|sealed builder/);
  assert.throws(()=>stage.stageCandidateModel({targetDir,modelPath:__filename}),/owned scratch|sealed builder/);
 }
 const scratch=path.resolve('.artifacts/v51/staged-runtime');
 fs.mkdirSync(scratch,{recursive:true});
 const target=fs.mkdtempSync(path.join(scratch,'unit-safety-'));
 const external=fs.mkdtempSync(path.resolve('.artifacts/v51/unit-external-'));
 try{
  fs.writeFileSync(path.join(target,'web-build.manifest.json'),'sealed');
  assert.throws(()=>stage.stageRuntime({targetDir:target}),/sealed builder/);
  assert.equal(fs.readFileSync(path.join(target,'web-build.manifest.json'),'utf8'),'sealed');
  fs.unlinkSync(path.join(target,'web-build.manifest.json'));
  fs.symlinkSync(external,path.join(target,'linked'));
  assert.throws(()=>stage.stageRuntime({targetDir:path.join(target,'linked','nested')}),/unlinked directories/);
  const protectedFile=path.join(external,'protected');
  fs.writeFileSync(protectedFile,'unchanged');
  fs.symlinkSync(protectedFile,path.join(target,'LICENSE'));
  assert.throws(()=>stage.stageRuntime({targetDir:target}),/unlinked regular file/);
  assert.equal(fs.readFileSync(protectedFile,'utf8'),'unchanged');
  fs.unlinkSync(path.join(target,'LICENSE'));
  fs.linkSync(protectedFile,path.join(target,'ort.wasm.min.js'));
  assert.throws(()=>stage.stageRuntime({targetDir:target}),/unlinked regular file/);
  assert.equal(fs.readFileSync(protectedFile,'utf8'),'unchanged');
 }finally{
  fs.rmSync(target,{recursive:true,force:true});
  fs.rmSync(external,{recursive:true,force:true});
 }
});
test('empty pack catalog opens its sheet before DOM append and performs no cache or network action',()=>{
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
 let panel=null,opened=0,reads=0,downloads=0;
 const store={state:{status:'unavailable'},read:()=>{reads++;},download:()=>{downloads++;}};
 const document={
  getElementById:id=>id==='aiPackPanel'?panel:null,
  createElement:tag=>({tag,dataset:{},setAttribute(){},textContent:''})
 };
 const api={open:(title,html,kind)=>{
  assert.equal(kind,'ai-pack');assert.match(html,/id="aiPackPanel"/);
  opened++;panel={children:[],append(node){this.children.push(node);}};
 }};
 const context={MegaBotPack:P,document,location:{href:'https://game.example/index.html'},URL};
 vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../../src/bot/pack-ui.js'),'utf8'),context);
 const ui=context.MegaAiPack.create({host:()=>api,catalog:[],store});
 ui.show();ui.show();
 assert.equal(opened,2);
 assert.ok(panel.children.some(p=>p.textContent==='No approved Impossible model is available yet.'));
 assert.ok(panel.children.some(p=>p.textContent.includes('Nothing is downloaded')));
 assert.equal(reads,0);assert.equal(downloads,0);
 assert.equal(P.APPROVED_CATALOG.length,0);
});
