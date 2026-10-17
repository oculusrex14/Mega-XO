#!/usr/bin/env node
'use strict';
// Emulator-only CDP exercise: guest -> bot match -> genuine X move.
// No production instrumentation endpoint, new JS bridge or game UI edit.
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
const EXPECTED='https://appassets.androidplatform.net/assets/mega/bundle-index.html';
const FAILURE_CODES=new Set(['CDP_CONNECTION_FAILED','CDP_CONNECTION_TIMEOUT','CDP_COMMAND_TIMEOUT',
  'CDP_SOCKET_CLOSED','CDP_SEND_FAILED','CDP_PROTOCOL_ERROR','CDP_RUNTIME_EXCEPTION','CDP_RESPONSE_INVALID']);
function failure(code){const error=new Error(code);error.code=code;return error;}
function bounded(promise,ms,code,timers={set:setTimeout,clear:clearTimeout}){
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{
    timer=timers.set(()=>reject(failure(code)),ms);
  })]).finally(()=>timers.clear(timer));
}
function resultValue(result){
  if(result.error)throw failure('CDP_PROTOCOL_ERROR');
  if(result.result?.exceptionDetails)throw failure('CDP_RUNTIME_EXCEPTION');
  if(!result.result?.result)throw failure('CDP_RESPONSE_INVALID');
  return result.result.result.value;
}
function formatFailure(error){
  // Never print debugger URLs, evaluated expressions, exception descriptions or arbitrary payloads.
  const phase=/^[a-z-]{1,32}$/.test(error?.smokePhase||'')?error.smokePhase:'unknown';
  const reason=FAILURE_CODES.has(error?.code)?error.code:
    error?.message?.startsWith('NATIVE_GAMEPLAY_SMOKE:')?error.message.slice('NATIVE_GAMEPLAY_SMOKE:'.length).trim():
    'UNEXPECTED_HARNESS_FAILURE';
  return 'NATIVE_GAMEPLAY_SMOKE: phase='+phase+'; '+reason;
}
function ensure(condition,message) {
  if(!condition) throw new Error('NATIVE_GAMEPLAY_SMOKE: '+message);
}
async function connect({fetcher=fetch,Socket=WebSocket,timers,onPhase=()=>{}}={}){
  onPhase('discover');
  let target;
  for(let i=0;i<30;i++){
    try{
      const r=await fetcher('http://127.0.0.1:9222/json/list',
        {signal:AbortSignal.timeout(1500)});
      const list=await r.json();
      target=list.find(x=>x.type==='page' && x.url===EXPECTED && x.webSocketDebuggerUrl);
      if(target)break;
    }catch{}
    await sleep(350);
  }
  ensure(target,'trusted game WebView debugger unavailable');
  const address=new URL(target.webSocketDebuggerUrl);
  ensure(address.protocol==='ws:' && address.pathname.startsWith('/devtools/page/'),
    'untrusted debugger endpoint');
  address.hostname='127.0.0.1';address.port='9222';
  onPhase('connect');
  const socket=new Socket(address.toString());
  try{
    await bounded(new Promise((resolve,reject)=>{
      socket.addEventListener('open',resolve,{once:true});
      socket.addEventListener('error',()=>reject(failure('CDP_CONNECTION_FAILED')),{once:true});
    }),7000,'CDP_CONNECTION_TIMEOUT',timers);
  }catch(error){socket.close();throw error;}
  const pending=new Map();let id=0;
  const rejectPending=code=>{for(const done of pending.values())done.reject(failure(code));pending.clear();};
  socket.addEventListener('close',()=>rejectPending('CDP_SOCKET_CLOSED'));
  socket.addEventListener('error',()=>rejectPending('CDP_CONNECTION_FAILED'));
  socket.addEventListener('message', event=>{
    let data;
    try { data=JSON.parse(String(event.data)); } catch {return;}
    const done=pending.get(data.id);
    if(done){pending.delete(data.id);done.resolve(data);}
  });
  async function evaluate(expression){
    const requestId=++id;
    try{
      const result=await bounded(new Promise((resolve,reject)=>{
        pending.set(requestId,{resolve,reject});
        try{socket.send(JSON.stringify({id:requestId,method:'Runtime.evaluate',
          params:{expression,returnByValue:true,awaitPromise:true}}));}
        catch{reject(failure('CDP_SEND_FAILED'));}
      /* MXA-CI-001: after the player commit, the offline bot thinks on the WebView main thread;
       * on a contended emulator that can hold Runtime.evaluate well past 6s. The command is
       * legitimate work, not a hang - give it a 20s ceiling instead of failing the lane. */
      }),20000,'CDP_COMMAND_TIMEOUT',timers);
      return resultValue(result);
    }finally{pending.delete(requestId);}
  }
  return {evaluate,close:()=>{rejectPending('CDP_SOCKET_CLOSED');socket.close();}};
}
async function until(evaluate,code,message,iterations=30) {
  for(let i=0;i<iterations;i++){
    if(await evaluate(code))return;
    await sleep(200);
  }
  ensure(false,message);
}
async function main({connector=connect,log=console.log}={}){
  let remote,phase='discover';
  try {
    remote=await connector({onPhase:value=>{phase=value;}});
    const {evaluate}=remote;
    phase='home';
    await until(evaluate,
      "!!document.querySelector('#page .home-hero') && document.querySelectorAll('#navigation .nav-button').length === 5",
      'home screen did not render');
    phase='guest';
    const guest=await evaluate("(function(){const button=document.querySelector('#identityScreen [data-c=guest]');if(button){button.click();return true;}return !document.querySelector('#identityScreen');})()");
    ensure(guest,'guest onboarding action missing');
    phase='guest-dismiss';
    await until(evaluate,"!document.querySelector('#identityScreen')",
      'guest action did not dismiss onboarding');
    phase='start-bot';
    const started=await evaluate("(function(){const select=document.querySelector('[data-action=mode][data-value=bot]');if(!select)return false;select.click();const first=document.querySelector('[data-action=first][data-value=X]');if(first)first.click();const button=document.querySelector('[data-action=start]');if(!button)return false;button.click();return true;})()");
    ensure(started,'offline bot match start unavailable');
    phase='board';
    await until(evaluate,
      "!document.querySelector('#gameScreen').hidden && document.querySelectorAll('#board .cell').length === 81",
      '9x9 board did not start');
    phase='move';
    const moved=await evaluate("(function(){const cell=document.querySelector('#board .cell:not([disabled])');if(!cell)return false;cell.click();return true;})()");
    ensure(moved,'no legal offline move available');
    phase='move-confirm';
    /* The bot reply can legitimately take longer than the default 6s poll window on a slow
     * emulator; give the commit confirmation 100 polls (20s+ of evaluate ceiling each). */
    await until(evaluate,
      "[...document.querySelectorAll('#board .cell')].some(cell=>cell.dataset.mark === 'X')",
      'offline game did not commit X move',100);
    log('P20_OFFLINE_GAMEPLAY_PASS: guest; bot; 81 cells; committed X move');
  }catch(error){
    error.smokePhase=phase;throw error;
  } finally {
    remote?.close();
  }
}
if(require.main===module)main().catch(error=>{
  console.error(formatFailure(error));
  process.exitCode=1;
});
module.exports={bounded,resultValue,formatFailure,connect,main,EXPECTED};
