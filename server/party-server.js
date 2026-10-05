/* Free same-Wi-Fi server. This executable has NO paid-tournament activation flag. */
'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {RoomStore}=require('./rooms.js'),{createPartyHandler}=require('./party-http.js');
const root=path.resolve(__dirname,'..'),port=Number(process.env.PARTY_PORT||8081),folder=process.env.PARTY_DATA_DIR||path.join(os.homedir(),'.mega-xo');
fs.mkdirSync(folder,{recursive:true});const store=new RoomStore(path.join(folder,'party-lan.sqlite'),{lanOnly:true});store.recover();
const ips=Object.values(os.networkInterfaces()).flat().filter(x=>x&&x.family==='IPv4').map(x=>x.address),hosts=new Set(['localhost','127.0.0.1',...ips].map(x=>x+':'+port));
const handler=createPartyHandler({store,allowedHosts:hosts});
const allowed=new Set(['index.html','src/styles.css','src/party.css','src/game.js','src/domain.js','src/icons.js','src/network.js','src/app.js','src/tournament.js','src/party-ui.js','src/lan-icons.js']);
const server=http.createServer(async(req,res)=>{
 if(await handler(req,res))return;if(!hosts.has(req.headers.host)){res.writeHead(403);res.end();return;}
 let filename=new URL(req.url,'http://local').pathname.slice(1)||'index.html';if(!allowed.has(filename)){res.writeHead(404);res.end();return;}
 try{let data=fs.readFileSync(path.join(root,filename));if(filename==='index.html'){
  // No CDN dependency for a first visit on an internet-free LAN. Typography uses its authored fallbacks.
  let html=data.toString().replace(/<link[^>]+https:\/\/(fonts\.googleapis|fonts\.gstatic)[^>]*>/g,'').replace(/<script src="https:\/\/unpkg[^>]*><\/script>/g,'<script src="src/lan-icons.js"></script>');data=Buffer.from(html);
 }
 res.writeHead(200,{'Content-Type':filename.endsWith('.js')?'text/javascript; charset=utf-8':filename.endsWith('.css')?'text/css':'text/html; charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});res.end(data);
 }catch{res.writeHead(404);res.end();}
});
const timer=setInterval(()=>{try{store.tick();}catch(e){console.error('Room tick failed:',e.message);}},500);timer.unref();
server.listen(port,'0.0.0.0',()=>{console.log('Mega XO: FREE local-network rooms (no internet needed).');for(const ip of ips.filter(x=>x!=='127.0.0.1'))console.log('Open on every phone: http://'+ip+':'+port);console.log('Keep this host awake. Use trusted Wi-Fi; do not port-forward this HTTP service.');});
process.on('SIGINT',()=>{clearInterval(timer);server.close(()=>{store.close();process.exit(0);});});
