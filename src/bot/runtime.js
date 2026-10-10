/* One isolated worker, one in-flight request, explicit cancellation and fencing. */
(function(root,factory){const api=factory(root,typeof module==='object'?require('../game.js'):root.MegaGame,typeof module==='object'?require('./contracts.js'):root.MegaBotContract);if(typeof module==='object')module.exports=api;else root.MegaBotRuntime=api;})(globalThis,(root,G,C)=>{
'use strict';
const VERSION='bot-runtime-v1';
const scriptURL=typeof document!=='undefined'?document.currentScript?.src:null;
const workerURL=scriptURL?new URL('worker.js',scriptURL).href:null;
function error(code,abort=false){const e=new Error(code);e.code=code;if(abort)e.name='AbortError';return e;}
function startInfo(saved,practice=false){if(saved?.version===VERSION&&['legacy','experimental'].includes(saved.engine)&&Number.isInteger(saved.seed)&&saved.seed>=0&&saved.seed<=4294967295)return {...saved,engine:practice?'legacy':saved.engine};
 let seed;try{seed=root.crypto.getRandomValues(new Uint32Array(1))[0];}catch{seed=Math.floor(Math.random()*4294967296);}
 let engine='legacy';try{if(!practice&&root.localStorage?.getItem('mega_v51_search')==='experimental')engine='experimental';}catch{}
 return {version:VERSION,ruleset:C.RULESET,engine,seed};
}
class Client {
 constructor({workerFactory,timeoutMs=1800}={}){this.factory=workerFactory||(()=>{if(!workerURL||!root.Worker)throw error('BOT_WORKER_UNAVAILABLE');return new root.Worker(workerURL);});this.timeoutMs=timeoutMs;this.worker=null;this.pending=null;this.serial=0;}
 cancel(code='BOT_CANCELLED',abort=true){const pending=this.pending;this.pending=null;if(this.worker){this.worker.terminate();this.worker=null;}if(pending){clearTimeout(pending.timer);pending.signal?.removeEventListener('abort',pending.abort);pending.reject(error(code,abort));}}
 choose(job,{signal}={}){
  this.cancel();if(signal?.aborted)return Promise.reject(error('BOT_CANCELLED',true));
  if(!job||!['legacy','experimental','uct'].includes(job.engine)||!G.LEVELS.includes(job.difficulty)||typeof job.gameId!=='string'||job.revision!==job.state?.moves?.length)return Promise.reject(error('BOT_INVALID_REQUEST'));
  return new Promise((resolve,reject)=>{const id=++this.serial;let worker;try{worker=this.factory();this.worker=worker;}catch{reject(error('BOT_WORKER_UNAVAILABLE'));return;}
   const snapshot=JSON.parse(JSON.stringify(job.state));const pending={id,job:{...job,state:snapshot},resolve,reject,signal,abort:()=>this.cancel()};this.pending=pending;
   pending.timer=setTimeout(()=>{if(this.pending===pending)this.cancel('BOT_WORKER_TIMEOUT',false);},Math.max(100,Math.min(5000,this.timeoutMs)));
   signal?.addEventListener('abort',pending.abort,{once:true});
   worker.onerror=()=>{if(this.worker===worker)this.cancel('BOT_WORKER_FAILURE',false);};
   worker.onmessage=event=>{if(this.worker!==worker||this.pending!==pending||event.data?.requestId!==id)return;const data=event.data;
    if(data.error){this.cancel('BOT_WORKER_FAILURE',false);return;}
    try{C.accept({state:snapshot,gameId:job.gameId,revision:job.revision},data);}catch{this.cancel('BOT_INVALID_RESULT',false);return;}
    this.pending=null;clearTimeout(pending.timer);signal?.removeEventListener('abort',pending.abort);worker.terminate();this.worker=null;resolve(data);
   };
   try{worker.postMessage({...job,state:snapshot,op:'choose',requestId:id});}catch{this.cancel('BOT_WORKER_FAILURE',false);}
  });
 }
}
return {VERSION,Client,startInfo};
});
