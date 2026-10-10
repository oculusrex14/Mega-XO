"""Real ORT WASM inference in a Chromium Worker; unapproved fixture model only."""
import json, os, shutil, threading
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2];OUT=ROOT/'.artifacts/v51';EXPORT=OUT/'export';RUNTIME=OUT/'ort/node_modules/onnxruntime-web/dist'
if not (EXPORT/'candidate.onnx').exists() or not (RUNTIME/'ort.wasm.min.js').exists():raise RuntimeError('NEURAL_CI_FIXTURES_MISSING')
class Quiet(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
worker=OUT/'neural-harness-worker.js';pagefile=OUT/'neural-harness.html'
worker.write_text("""importScripts('/.artifacts/v51/ort/node_modules/onnxruntime-web/dist/ort.wasm.min.js','/src/game.js','/src/bot/encoding.js','/src/bot/onnx.js');
ort.env.wasm.wasmPaths='/.artifacts/v51/ort/node_modules/onnxruntime-web/dist/';
self.onmessage=async()=>{let model;try{const bytes=new Uint8Array(await (await fetch('/.artifacts/v51/export/candidate.onnx')).arrayBuffer());const golden=await (await fetch('/.artifacts/v51/export/golden.json')).json();model=new MegaBotOnnx.Model(ort,bytes);await model.initialize();let maxPolicyError=0,maxValueError=0,illegalProbabilities=0;const times=[];
for(const row of golden){let state=MegaGame.create(row.first);for(const m of row.moves)state=MegaGame.apply(state,m);const start=performance.now();const r=await model.infer(state);times.push(performance.now()-start);for(let i=0;i<81;i++){maxPolicyError=Math.max(maxPolicyError,Math.abs(r.logits[i]-row.policy[i]));if(!row.legalMask[i]&&r.policy[i]!==0)illegalProbabilities++;}maxValueError=Math.max(maxValueError,Math.abs(r.value-row.value));}
times.sort((a,b)=>a-b);self.postMessage({ok:maxPolicyError<.0001&&maxValueError<.0001&&illegalProbabilities===0,states:golden.length,provider:model.provider,maxPolicyError,maxValueError,illegalProbabilities,p50InferenceMs:times[Math.floor(times.length*.5)],p95InferenceMs:times[Math.floor(times.length*.95)],physicalDevice:false});
}catch(e){self.postMessage({ok:false,error:String(e)});}finally{await model?.dispose();}};
""")
pagefile.write_text('<!doctype html><meta charset="utf-8"><title>Neural validation only</title><p>Fixture validation</p>')
server=ThreadingHTTPServer(('127.0.0.1',0),partial(Quiet,directory=str(ROOT)));threading.Thread(target=server.serve_forever,daemon=True).start();base=f'http://127.0.0.1:{server.server_port}'
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE') or shutil.which('chromium'),headless=True,args=['--no-sandbox']);page=browser.new_page();page.goto(base+'/.artifacts/v51/neural-harness.html');result=page.evaluate("""()=>new Promise((resolve,reject)=>{const w=new Worker('/.artifacts/v51/neural-harness-worker.js');const timer=setTimeout(()=>{w.terminate();reject(Error('NEURAL_BROWSER_TIMEOUT'));},120000);w.onmessage=e=>{clearTimeout(timer);w.terminate();resolve(e.data);};w.onerror=e=>{clearTimeout(timer);w.terminate();reject(Error(e.message));};w.postMessage({run:true});})""");browser.close()
 if not result.get('ok'):raise AssertionError(result)
 result['runtimeFiles']=[{'file':f.name,'bytes':f.stat().st_size} for f in sorted(RUNTIME.iterdir()) if f.suffix in ('.wasm','.mjs','.js') and (f.name.startswith('ort-wasm') or f.name=='ort.wasm.min.js')]
 result['sizeWarning']='Runtime distribution inventory, not all files are fetched. This is separate from model size; no library is shipped by this test.'
 (OUT/'neural-browser.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
finally:server.shutdown();server.server_close();worker.unlink(missing_ok=True);pagefile.unlink(missing_ok=True)
