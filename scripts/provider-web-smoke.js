'use strict';
const fs=require('node:fs');

function usage(){
 console.error('Usage: node scripts/provider-web-smoke.js https://HOST google|apple [google|apple]... [--basic-password-file /absolute/file]');
 process.exit(64);
}
function cookieFrom(headers){const raw=headers.getSetCookie?.()[0]||headers.get('set-cookie')||'';return raw.split(';')[0];}
async function main(args=process.argv.slice(2)){
 const origin=args.shift();if(!origin)usage();
 let u;try{u=new URL(origin);}catch{usage();}
 if(u.protocol!=='https:'||u.origin!==origin||u.pathname!=='/'||u.search||u.hash)throw Error('HTTPS_ORIGIN_REQUIRED');
 const providers=[];
 let basic='';
 while(args.length){
  const arg=args.shift();
  if(arg==='--basic-password-file'){
   const file=args.shift();if(!file||!file.startsWith('/')||!fs.statSync(file).isFile())throw Error('VALID_BASIC_PASSWORD_FILE_REQUIRED');
   const password=fs.readFileSync(file,'utf8').trim();if(!password)throw Error('EMPTY_BASIC_PASSWORD');
   basic='Basic '+Buffer.from('staging:'+password).toString('base64');
  }else if(['google','apple'].includes(arg)&&!providers.includes(arg))providers.push(arg);
  else usage();
 }
 if(!providers.length)usage();
 let cookie='',csrf='';
 const headers=()=>({Origin:origin,'Content-Type':'application/json',...(basic?{Authorization:basic}:{}),...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})});
 async function call(path,body){
  const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:headers(),body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)});
  const c=cookieFrom(response.headers);if(c)cookie=c;
  const text=await response.text();let data;try{data=JSON.parse(text);}catch{throw Error('NON_JSON_'+response.status);}
  if(data?.csrf)csrf=data.csrf;return {status:response.status,data};
 }
 const boot=await call('/api/account/session');if(boot.status!==200)throw Error('SESSION_FAILED_'+boot.status);
 for(const provider of providers){
  if(!boot.data?.providers?.[provider]?.web)throw Error(provider.toUpperCase()+'_WEB_NOT_ENABLED');
  const started=await call('/api/account/start',{provider,intent:'login'});
  if(started.status!==200||typeof started.data?.url!=='string')throw Error(provider.toUpperCase()+'_START_FAILED_'+started.status);
  const auth=new URL(started.data.url);
  const expectedHost=provider==='google'?'accounts.google.com':'appleid.apple.com';
  if(auth.hostname!==expectedHost||auth.protocol!=='https:')throw Error(provider.toUpperCase()+'_AUTHORITY_INVALID');
  if(auth.searchParams.get('redirect_uri')!==origin+'/auth/callback/'+provider)throw Error(provider.toUpperCase()+'_REDIRECT_INVALID');
  if(auth.searchParams.get('response_type')!=='code'||!auth.searchParams.get('state')||!auth.searchParams.get('nonce'))throw Error(provider.toUpperCase()+'_OAUTH_PARAMETERS_INVALID');
  if(provider==='google'){
   if(auth.searchParams.get('scope')!=='openid'||auth.searchParams.get('code_challenge_method')!=='S256'||!auth.searchParams.get('code_challenge'))throw Error('GOOGLE_PKCE_INVALID');
  }else if(auth.searchParams.get('response_mode')!=='query')throw Error('APPLE_RESPONSE_MODE_INVALID');
  console.log(provider+': authorization contract passed for '+origin+'/auth/callback/'+provider);
 }
 console.log(JSON.stringify({passed:true,origin,providers}));
}
if(require.main===module)main().catch(error=>{console.error('PROVIDER_WEB_SMOKE_FAILED: '+error.message);process.exitCode=1;});
module.exports={main};
