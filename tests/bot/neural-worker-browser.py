"""Actual pinned neural Worker/PUCT lifecycle, using non-shipped CI model/runtime fixtures."""
import json, os, shutil, threading
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2];OUT=ROOT/'.artifacts/v51'
RUNTIME=OUT/'ort/node_modules/onnxruntime-web/dist'
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*args): pass
 def translate_path(self,url):
  prefix='/src/bot/ort-1.23.2/'
  if url.startswith(prefix):
   name=url.split('?',1)[0][len(prefix):]
   if Path(name).name!=name: return str(OUT/'invalid-path')
   return str(RUNTIME/name)
  return super().translate_path(url)
server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
base=f'http://127.0.0.1:{server.server_port}'
pagefile=OUT/'neural-runtime-harness.html'
pagefile.write_text('<!doctype html><meta charset="utf-8"><title>Neural runtime validation</title>'+''.join('<script src="/src/'+f+'"></script>' for f in ['game.js','bot/contracts.js','bot/pack.js','bot/neural-runtime.js']))
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE') or shutil.which('chromium'),headless=True,args=['--no-sandbox'])
  page=browser.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(base) else r.abort())
  page.goto(base+'/.artifacts/v51/neural-runtime-harness.html')
  result=page.evaluate("""async()=>{
   const exported=await (await fetch('/.artifacts/v51/export/export-report.json')).json();
   const artifact=exported.artifacts.find(a=>a.file==='candidate.onnx');
   const bytes=new Uint8Array(await (await fetch('/.artifacts/v51/export/candidate.onnx')).arrayBuffer());
   const manifest={schemaVersion:1,version:'ci-unapproved',ruleset:MegaBotContract.RULESET,encodingVersion:'planes8-v1',sha256:artifact.sha256,bytes:artifact.bytes,gzipBytes:artifact.gzipBytes,url:'/game/ai/'+artifact.sha256+'.onnx',deploymentStatus:'UNAPPROVED'};
   let workers=0,initializations=0;const states=[],workerURLs=[],NativeWorker=window.Worker;
   window.Worker=class extends NativeWorker{
    constructor(url,...options){super(url,...options);workers++;workerURLs.push(String(url));}
    postMessage(job,...options){if(job.op==='initialize')initializations++;return super.postMessage(job,...options);}
   };
   const client=new MegaBotNeuralRuntime.Client({onState:s=>states.push(s.status)});
   await client.configure(manifest,bytes);
   let state=MegaGame.create();const turns=[];
   for(let i=0;i<4;i++){
    const started=performance.now(),r=await client.choose({state,gameId:'real-neural',revision:state.moves.length,modelHash:manifest.sha256,seed:51+i,budgetMs:80,simulations:16,maxNodes:512});
    MegaBotContract.accept({state,gameId:'real-neural',revision:state.moves.length},r);
    state=MegaGame.apply(state,r.move);turns.push({elapsedMs:performance.now()-started,...r.diagnostics});
   }
   if(workers!==1||initializations!==1)throw Error('MODEL_NOT_WARM');
   if(workerURLs[0]!==new URL('/src/bot/neural-worker.js',location.href).href)throw Error('WRONG_DEFAULT_WORKER_URL');
   const before=JSON.stringify(state),pending=client.choose({state,gameId:'cancel-test',revision:state.moves.length,modelHash:manifest.sha256,seed:81,budgetMs:1500,simulations:2048,maxNodes:2048});
   const outcome=pending.then(()=>({cancelled:false}),e=>({cancelled:e.name==='AbortError',code:e.code}));
   await new Promise(resolve=>setTimeout(resolve,15));client.cancel();const cancellation=await outcome;
   if(!cancellation.cancelled||JSON.stringify(state)!==before||client.loaded)throw Error('CANCEL_FENCE_FAILED');
   const recovery=await client.choose({state,gameId:'recovery',revision:state.moves.length,modelHash:manifest.sha256,seed:82,budgetMs:50,simulations:8});
   MegaBotContract.accept({state,gameId:'recovery',revision:state.moves.length},recovery);
   client.unload();if(client.bytes!==null||client.worker!==null)throw Error('UNLOAD_FAILED');
   window.Worker=NativeWorker;
   return {ok:true,modelHash:manifest.sha256,turns,initialWarmTurns:4,initializations,workers,workerURLs,defaultWorkerFactory:true,cancellation,recoveryProvider:recovery.diagnostics.provider,stateMovesPreserved:state.moves.length,states,unapprovedFixture:true,physicalDevice:false};
  }""")
  browser.close()
 if errors or not result['ok']:raise AssertionError({'result':result,'pageErrors':errors})
 result['pageErrors']=errors
 (OUT/'neural-worker-browser.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
finally:server.shutdown();server.server_close();pagefile.unlink(missing_ok=True)
