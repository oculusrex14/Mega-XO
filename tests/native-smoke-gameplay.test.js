'use strict';
// Pure protocol/timer doubles only. Never opens a browser, socket, device or CDP connection.
const test=require('node:test'),assert=require('node:assert/strict');
const {bounded,resultValue,formatFailure,connect,main,EXPECTED}=require('../scripts/v5/native-smoke-gameplay.cjs');
function timers(){
  let id=0;const active=new Map(),cleared=[];
  return {active,cleared,set(fn,ms){active.set(++id,{fn,ms});return id;},clear(key){active.delete(key);cleared.push(key);},
    expire(){const [key,value]=active.entries().next().value;active.delete(key);value.fn();}};
}
function socketType({open=true,onSend=()=>{},failOpen=false}={}){
  return class Socket{
    static instances=[];
    constructor(address){this.address=address;this.listeners=new Map();this.closed=0;this.constructor.instances.push(this);
      queueMicrotask(()=>{if(failOpen)this.emit('error');else if(open)this.emit('open');});}
    addEventListener(type,fn,options={}){const list=this.listeners.get(type)||[];list.push({fn,once:options.once});this.listeners.set(type,list);}
    emit(type,fields={}){for(const entry of [...(this.listeners.get(type)||[])]){entry.fn(fields);if(entry.once)this.listeners.set(type,(this.listeners.get(type)||[]).filter(e=>e!==entry));}}
    send(text){return onSend.call(this,JSON.parse(text));}
    close(){this.closed++;this.emit('close');}
  };
}
const discovery=async()=>({json:async()=>[{type:'page',url:EXPECTED,webSocketDebuggerUrl:'ws://localhost:12345/devtools/page/synthetic-target'}]});
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('deadlines are cleared after both successful and rejected work',async()=>{
  const clock=timers();
  assert.equal(await bounded(Promise.resolve(42),7000,'CDP_CONNECTION_TIMEOUT',clock),42);
  const error=Error('synthetic rejection');
  await assert.rejects(bounded(Promise.reject(error),6000,'CDP_COMMAND_TIMEOUT',clock),e=>e===error);
  assert.equal(clock.active.size,0);assert.equal(clock.cleared.length,2);
});

test('deadline failure retains its precise code without extending the original timeout',async()=>{
  const clock=timers(),pending=bounded(new Promise(()=>{}),6000,'CDP_COMMAND_TIMEOUT',clock);
  assert.equal([...clock.active.values()][0].ms,6000);
  clock.expire();await assert.rejects(pending,error=>error.code==='CDP_COMMAND_TIMEOUT');
  assert.equal(clock.active.size,0);
});

test('CDP values preserve false while protocol, runtime and malformed replies remain distinct failures',()=>{
  assert.equal(resultValue({result:{result:{value:false}}}),false);
  for(const [reply,code] of [[{error:{code:-32601,message:'private details'}},'CDP_PROTOCOL_ERROR'],
    [{result:{exceptionDetails:{text:'private trace'}}},'CDP_RUNTIME_EXCEPTION'],[{},'CDP_RESPONSE_INVALID']]){
    assert.throws(()=>resultValue(reply),error=>error.code===code);
  }
});

test('diagnostics show only the phase and allowlisted failure, never arbitrary debugger payloads',()=>{
  const error=Error('private bearer and arbitrary trace');error.code='CDP_RUNTIME_EXCEPTION';error.smokePhase='start-bot';
  assert.equal(formatFailure(error),'NATIVE_GAMEPLAY_SMOKE: phase=start-bot; CDP_RUNTIME_EXCEPTION');
  assert.equal(formatFailure(Error('private data')),'NATIVE_GAMEPLAY_SMOKE: phase=unknown; UNEXPECTED_HARNESS_FAILURE');
});

test('mocked connection and evaluation keep target validation, request correlation and original deadlines',async()=>{
  const clock=timers(),phases=[],sent=[];
  const Socket=socketType({onSend(request){sent.push(request);this.emit('message',{data:JSON.stringify({id:request.id-1,result:{result:{value:'stale'}}})});
    this.emit('message',{data:JSON.stringify({id:request.id,result:{result:{value:true}}})});}});
  const remote=await connect({fetcher:discovery,Socket,timers:clock,onPhase:phase=>phases.push(phase)});
  assert.deepEqual(phases,['discover','connect']);
  assert.match(Socket.instances[0].address,/^ws:\/\/127\.0\.0\.1:9222\/devtools\/page\//);
  assert.equal(await remote.evaluate('synthetic expression'),true);
  assert.equal(sent[0].method,'Runtime.evaluate');
  assert.equal(sent[0].params.awaitPromise,true);assert.equal(sent[0].params.returnByValue,true);
  assert.equal(clock.active.size,0);remote.close();
});

test('a failed WebSocket opening closes the connection and reports connection failure',async()=>{
  const clock=timers(),Socket=socketType({failOpen:true});
  await assert.rejects(connect({fetcher:discovery,Socket,timers:clock}),error=>error.code==='CDP_CONNECTION_FAILED');
  assert.equal(Socket.instances[0].closed,1);assert.equal(clock.active.size,0);
});

test('WebSocket opening timeout remains seven seconds and closes a pending connection',async()=>{
  const clock=timers(),Socket=socketType({open:false});
  const pending=connect({fetcher:discovery,Socket,timers:clock});await tick();
  assert.equal([...clock.active.values()][0].ms,7000);clock.expire();
  await assert.rejects(pending,error=>error.code==='CDP_CONNECTION_TIMEOUT');
  assert.equal(Socket.instances[0].closed,1);assert.equal(clock.active.size,0);
});

test('a WebSocket close during a command fails immediately instead of waiting for the command deadline',async()=>{
  const clock=timers(),Socket=socketType({onSend(){queueMicrotask(()=>this.emit('close'));}});
  const remote=await connect({fetcher:discovery,Socket,timers:clock});
  await assert.rejects(remote.evaluate('synthetic expression'),error=>error.code==='CDP_SOCKET_CLOSED');
  assert.equal(clock.active.size,0);remote.close();
});

test('protocol and JavaScript exceptions from evaluation stay distinguishable without printing descriptions',async()=>{
  for(const [reply,code] of [[{error:{code:-32601,message:'private method detail'}},'CDP_PROTOCOL_ERROR'],
    [{result:{exceptionDetails:{text:'private page detail'}}},'CDP_RUNTIME_EXCEPTION']]){
    const clock=timers(),Socket=socketType({onSend(request){this.emit('message',{data:JSON.stringify({id:request.id,...reply})});}});
    const remote=await connect({fetcher:discovery,Socket,timers:clock});
    await assert.rejects(remote.evaluate('synthetic expression'),error=>error.code===code);
    assert.equal(clock.active.size,0);remote.close();
  }
});

test('a failed gameplay assertion reports its actual phase and still closes the mocked client',async()=>{
  let reads=0,closed=0;const logs=[];
  await assert.rejects(main({connector:async()=>({evaluate:async()=>++reads!==4,close:()=>closed++}),log:line=>logs.push(line)}),error=>{
    assert.equal(formatFailure(error),'NATIVE_GAMEPLAY_SMOKE: phase=start-bot; offline bot match start unavailable');return true;
  });
  assert.equal(closed,1);assert.deepEqual(logs,[]);
});

test('all seven original gameplay checkpoints are still required before the pass message',async()=>{
  let reads=0,closed=0;const logs=[];
  await main({connector:async()=>({evaluate:async()=>{reads++;return true;},close:()=>closed++}),log:line=>logs.push(line)});
  assert.equal(reads,7);assert.equal(closed,1);
  assert.deepEqual(logs,['P20_OFFLINE_GAMEPLAY_PASS: guest; bot; 81 cells; committed X move']);
});
