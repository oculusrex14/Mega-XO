/* Test-only loopback service. Not shipped as an authentication implementation. */
const http=require('node:http'),{RoomStore}=require('../server/rooms.js'),{createPartyHandler}=require('../server/party-http.js');
const store=new RoomStore(':memory:',{lanOnly:true}),handler=createPartyHandler({store,origin:'http://mega.test'});
const server=http.createServer(async(req,res)=>{if(!await handler(req,res)){res.writeHead(404);res.end();}});
setInterval(()=>store.tick(),200).unref();server.listen(0,'127.0.0.1',()=>console.log(server.address().port));
