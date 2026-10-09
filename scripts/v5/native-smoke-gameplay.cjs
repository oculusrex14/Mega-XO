#!/usr/bin/env node
'use strict';
// Emulator-only CDP exercise: guest -> bot match -> genuine X move.
// No production instrumentation endpoint, new JS bridge or game UI edit.
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
const EXPECTED='https://appassets.androidplatform.net/assets/mega/bundle-index.html';
function ensure(condition,message) {
  if(!condition) throw new Error('NATIVE_GAMEPLAY_SMOKE: '+message);
}
async function connect(){
  let target;
  for(let i=0;i<30;i++){
    try{
      const r=await fetch('http://127.0.0.1:9222/json/list',
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
  const socket=new WebSocket(address.toString());
  await Promise.race([
    new Promise((resolve,reject)=>{
      socket.addEventListener('open',resolve,{once:true});
      socket.addEventListener('error',()=>reject(new Error('CDP_CONNECTION_FAILED')),{once:true});
    }),
    sleep(7000).then(()=>{throw Error('CDP_CONNECTION_TIMEOUT');})
  ]);
  const pending=new Map();let id=0;
  socket.addEventListener('message', event=>{
    let data;
    try { data=JSON.parse(String(event.data)); } catch {return;}
    const done=pending.get(data.id);
    if(done){pending.delete(data.id);done(data);}
  });
  async function evaluate(expression){
    const requestId=++id;
    const result=await Promise.race([
      new Promise(resolve=>{
        pending.set(requestId,resolve);
        socket.send(JSON.stringify({id:requestId,method:'Runtime.evaluate',
          params:{expression,returnByValue:true,awaitPromise:true}}));
      }),
      sleep(6000).then(()=>{throw Error('CDP_COMMAND_TIMEOUT');})
    ]);
    ensure(!result.error && !result.result?.exceptionDetails,'game action failed');
    return result.result?.result?.value;
  }
  return {evaluate,close:()=>socket.close()};
}
async function until(evaluate,code,message) {
  for(let i=0;i<30;i++){
    if(await evaluate(code))return;
    await sleep(200);
  }
  ensure(false,message);
}
async function main(){
  const remote=await connect();
  const {evaluate}=remote;
  try {
    await until(evaluate,
      "!!document.querySelector('#page .home-hero') && document.querySelectorAll('#navigation .nav-button').length === 5",
      'home screen did not render');
    const guest=await evaluate("(function(){const button=document.querySelector('#identityScreen [data-c=guest]');if(button){button.click();return true;}return !document.querySelector('#identityScreen');})()");
    ensure(guest,'guest onboarding action missing');
    await until(evaluate,"!document.querySelector('#identityScreen')",
      'guest action did not dismiss onboarding');
    const started=await evaluate("(function(){const select=document.querySelector('[data-action=mode][data-value=bot]');if(!select)return false;select.click();const first=document.querySelector('[data-action=first][data-value=X]');if(first)first.click();const button=document.querySelector('[data-action=start]');if(!button)return false;button.click();return true;})()");
    ensure(started,'offline bot match start unavailable');
    await until(evaluate,
      "!document.querySelector('#gameScreen').hidden && document.querySelectorAll('#board .cell').length === 81",
      '9x9 board did not start');
    const moved=await evaluate("(function(){const cell=document.querySelector('#board .cell:not([disabled])');if(!cell)return false;cell.click();return true;})()");
    ensure(moved,'no legal offline move available');
    await until(evaluate,
      "[...document.querySelectorAll('#board .cell')].some(cell=>cell.dataset.mark === 'X')",
      'offline game did not commit X move');
    console.log('P20_OFFLINE_GAMEPLAY_PASS: guest; bot; 81 cells; committed X move');
  } finally {
    remote.close();
  }
}
main().catch(error=>{
  console.error(error.message?.startsWith('NATIVE_GAMEPLAY_SMOKE:')?error.message:
    'NATIVE_GAMEPLAY_SMOKE: debugger command or gameplay failed');
  process.exitCode=1;
});
