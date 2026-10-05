'use strict';
// Local test fixture only. There is no fixture-login endpoint in the production server.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {buildService}=require('../server/community-server'),{IdentityProviders}=require('../server/identity-provider'),{jwk,sign}=require('./helpers/identity-fixture');
const port=Number(process.argv[2]),origin='http://127.0.0.1:'+port,dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-browser-'));
const providers=new IdentityProviders({config:{google:{nativeAudiences:['test-native']},apple:{nativeAudiences:['test-native']}},keysForTest:()=>[jwk]});
const s=buildService({file:path.join(dir,'db.sqlite'),origin,providerInstance:providers,allowLocalHttp:true});
const original=s.request;
s.server.removeAllListeners('request');s.server.on('request',async(req,res)=>{if(req.url==='/__test__/token'&&req.method==='POST'){let text='';for await(const part of req)text+=part;const b=JSON.parse(text);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({idToken:sign(b.provider,b.subject,b.nonce)}));return;}return original(req,res);});
s.startWorkers();s.server.listen(port,'127.0.0.1',()=>console.log(origin));process.on('SIGTERM',()=>{s.close();fs.rmSync(dir,{recursive:true,force:true});process.exit(0);});
