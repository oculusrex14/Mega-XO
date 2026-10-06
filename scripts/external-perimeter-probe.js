'use strict';
const net=require('node:net'),dns=require('node:dns').promises;

function usage(){console.error('Usage: node scripts/external-perimeter-probe.js play.antimatterinnovations.com [EXPECTED_IPV4]');process.exit(64);}
async function tcp(host,port,timeout=3500){
 return new Promise(resolve=>{
  const socket=net.createConnection({host,port});
  let done=false;
  const finish=open=>{if(done)return;done=true;socket.destroy();resolve(open);};
  socket.setTimeout(timeout,()=>finish(false));
  socket.once('connect',()=>finish(true));
  socket.once('error',()=>finish(false));
 });
}
async function main(args=process.argv.slice(2)){
 const host=args[0],expected=args[1]||'';if(!host||!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host))usage();
 if(expected&&!net.isIPv4(expected))throw Error('EXPECTED_IPV4_INVALID');
 const ips=await dns.resolve4(host);if(!ips.length)throw Error('NO_A_RECORD');
 if(expected&&!ips.includes(expected))throw Error('DNS_DOES_NOT_MATCH_EXPECTED_IPV4');
 console.log('DNS: '+host+' -> '+ips.join(', '));

 for(const port of [80,443]){
  if(!await tcp(host,port))throw Error('PUBLIC_PORT_'+port+'_UNREACHABLE');
  console.log('OPEN as expected: TCP '+port);
 }
 for(const port of [22,2375,2376,8080,9091]){
  if(await tcp(host,port))throw Error('FORBIDDEN_PUBLIC_PORT_'+port+'_OPEN');
  console.log('CLOSED as expected: TCP '+port);
 }

 const https='https://'+host;
 let response=await fetch(https+'/livez',{redirect:'error',signal:AbortSignal.timeout(10000)});
 if(response.status!==200)throw Error('LIVENESS_HTTP_'+response.status);
 if(response.headers.get('server'))throw Error('SERVER_FINGERPRINT_EXPOSED');
 const hsts=response.headers.get('strict-transport-security')||'';
 if(!/max-age=31536000/.test(hsts))throw Error('HSTS_MISSING');
 const csp=response.headers.get('content-security-policy')||'';
 if(!/frame-ancestors 'none'/.test(csp))throw Error('CSP_FRAME_ANCESTORS_MISSING');
 if((response.headers.get('x-frame-options')||'').toUpperCase()!=='DENY')throw Error('X_FRAME_OPTIONS_MISSING');
 console.log('HTTPS liveness and security headers passed');

 response=await fetch(https+'/opsz',{redirect:'error',signal:AbortSignal.timeout(10000)});
 if(response.status!==200)throw Error('OPERATIONAL_HEALTH_HTTP_'+response.status);
 const operational=await response.json();if(operational?.ok!==true||Object.keys(operational).length!==1)throw Error('OPERATIONAL_HEALTH_NOT_SANITIZED');
 console.log('Operational health is green and sanitized');

 for(const path of ['/metrics','/status','/server/production/main.js','/deploy/compose.yaml','/.git/config','/.env']){
  response=await fetch(https+path,{redirect:'error',signal:AbortSignal.timeout(10000)});
  if(response.status!==404)throw Error('PRIVATE_PATH_EXPOSED_'+path.replace(/[^a-z0-9]/gi,'_')+'_'+response.status);
 }
 console.log('Private paths are externally hidden');

 response=await fetch('http://'+host+'/livez',{redirect:'manual',signal:AbortSignal.timeout(10000)});
 if(![301,302,307,308].includes(response.status))throw Error('HTTP_NOT_REDIRECTED_'+response.status);
 const location=response.headers.get('location')||'';
 if(!location.startsWith('https://'+host+'/'))throw Error('HTTP_REDIRECT_TARGET_INVALID');
 console.log('HTTP redirects to HTTPS');

 console.log(JSON.stringify({passed:true,host,ipv4:ips,publicPorts:[80,443],blockedPorts:[22,2375,2376,8080,9091]}));
}
if(require.main===module)main().catch(error=>{console.error('EXTERNAL_PERIMETER_PROBE_FAILED: '+error.message);process.exitCode=1;});
module.exports={tcp,main};
