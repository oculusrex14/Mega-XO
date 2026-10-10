'use strict';

/*
 * P08 post-gate protocol stress regression. Real loopback TCP/HTTP upgrade and
 * genuine client-masked RFC6455 text frames; no database or external provider.
 * A single legitimate peer must not enqueue unbounded Core work even when
 * each individual message is a small valid frozen-protocol envelope.
 */
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const http=require('node:http');
const net=require('node:net');
const {createRealtimeTransport}=require('../packages/services/realtime-transport');

function maskedTextFrame(text) {
  const body=Buffer.from(text,'utf8');
  assert.ok(body.length<126,'small envelope stays on RFC6455 short frame path');
  const mask=crypto.randomBytes(4);
  const result=Buffer.allocUnsafe(2+4+body.length);
  result[0]=0x81;result[1]=0x80|body.length;
  mask.copy(result,2);
  for(let i=0;i<body.length;i++)result[6+i]=body[i]^mask[i&3];
  return result;
}
async function createHost(t){
  const server=http.createServer((req,res)=>{res.writeHead(404);res.end()});
  const transport=createRealtimeTransport({
    server,pool:{withTransaction:async()=>{throw Error('DB_FORBIDDEN_IN_PROTOCOL_STRESS')}},
    core:{readMatch:async()=>{throw Error('READ_FORBIDDEN')},
      run:async()=>{throw Error('COMMAND_FORBIDDEN')}},
    authTimeoutMs:5000,
  });
  await new Promise((resolve,reject)=>{
    server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
  });
  const clients=new Set();
  t.after(async()=>{
    clients.forEach(c=>c.destroy());
    await transport.close();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
  });
  return {port:server.address().port,clients,transport};
}
async function upgrade(port,clients){
  const socket=net.connect({host:'127.0.0.1',port});
  clients.add(socket);
  await new Promise((resolve,reject)=>{
    socket.once('connect',resolve);socket.once('error',reject);
  });
  const key=crypto.randomBytes(16).toString('base64');
  const headers=[
    'GET /realtime/v1 HTTP/1.1',
    'Host: 127.0.0.1',
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: '+key,'','',
  ].join('\r\n');
  let content=Buffer.alloc(0);
  const upgraded=new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('HANDSHAKE_TIMEOUT')),3000);
    const got=chunk=>{
      content=Buffer.concat([content,chunk]);
      if(content.includes(Buffer.from('\r\n\r\n'))){
        clearTimeout(timeout);socket.off('data',got);
        if(!content.toString('latin1').startsWith('HTTP/1.1 101 ')){
          reject(Error('HANDSHAKE_NOT_UPGRADED'));return;
        }
        resolve();
      }
    };
    socket.on('data',got);
  });
  socket.write(headers);
  await upgraded;
  return socket;
}

test('one masked-message burst cannot accumulate unbounded pending asynchronous frame work',async t=>{
  const s=await createHost(t);
  const socket=await upgrade(s.port,s.clients);
  const ping=JSON.stringify({protocol:'realtime/v1',operation:'ping'});
  const batch=Buffer.concat(Array.from({length:96},()=>maskedTextFrame(ping)));
  /* One TCP write guarantees all frames are parsed before Promise microtasks
   * are serviced, even if a normal DB or Core task were to hang indefinitely. */
  const closure=new Promise((resolve,reject)=>{
    const parts=[];
    let settled=false;
    const finish=(error,data)=>{
      if(settled)return;
      settled=true;
      clearTimeout(limit);
      if(error)reject(error);else resolve(data);
    };
    const limit=setTimeout(()=>finish(Error('PENDING_QUEUE_LIMIT_MISSING')),3000);
    socket.on('data',chunk=>{
      parts.push(chunk);
      const data=Buffer.concat(parts);
      if(data.includes(Buffer.from([0x88,0x02,0x03,0xf0])))finish(null,data);
    });
    socket.on('close',()=>finish(Error('SOCKET_CLOSED_WITHOUT_POLICY_1008')));
    socket.on('error',err=>finish(err));
  });
  socket.write(batch);
  const result=await closure;
  assert.ok(result.includes(Buffer.from([0x88,0x02,0x03,0xf0])),
    'WebSocket policy code 1008 signals excess pending work; no frame enters PG');
});
