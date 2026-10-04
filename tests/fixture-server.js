/* TEST ONLY. Loopback fixture identities must never be used as deployed authentication. */
'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {DurableStore}=require('../server/economy-store.js'),{createHandler}=require('../server/http.js');
const store=new DurableStore(':memory:',{paidEntryEnabled:true,eligibility:()=>true,random:()=>0});
for(const [id,rating] of [['alice',1500],['bob',1700]])store.run({actor:'fixture',scope:'operator'},'seed:'+id,{type:'provision',account:id,options:{coins:100,crowns:id==='alice'?100:0,rating,games:100,verified:true,region:'India',wealthPublic:true}});
let handler;const root=path.resolve(__dirname,'..');const server=http.createServer((req,res)=>{if(req.url.startsWith('/api/'))return handler(req,res);const pathname=new URL(req.url,'http://localhost').pathname;const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));if(!file.startsWith(root+path.sep)) {res.writeHead(403);res.end();return;}try{res.writeHead(200,{'Content-Type':file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html'});res.end(fs.readFileSync(file));}catch{res.writeHead(404);res.end();}});
server.listen(0,'127.0.0.1',()=>{const origin='http://127.0.0.1:'+server.address().port;handler=createHandler({store,origin,authenticate:req=>['alice','bob'].includes(req.headers['x-fixture-user'])?{id:req.headers['x-fixture-user']}:null});console.log(origin);});
process.on('SIGTERM',()=>server.close(()=>{store.close();process.exit(0);}));
