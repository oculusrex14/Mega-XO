'use strict';
const fs=require('node:fs'),crypto=require('node:crypto'),readline=require('node:readline/promises');

function usage(){
 console.error('Usage: node scripts/live-email-acceptance.js https://HOST TEST_EMAIL [--basic-password-file /absolute/file]');
 process.exit(64);
}
function mask(email){const [a,b]=email.split('@');return (a?.slice(0,1)||'*')+'***@'+b;}
function strongPassword(){return 'Mx9_'+crypto.randomBytes(24).toString('base64url');}
function cookieFrom(headers){const raw=headers.getSetCookie?.()[0]||headers.get('set-cookie')||'';return raw.split(';')[0];}
async function promptCode(label){
 const rl=readline.createInterface({input:process.stdin,output:process.stdout});
 try{
  const code=(await rl.question(label)).trim();
  if(!/^[0-9]{6}$/.test(code))throw Error('OTP_MUST_BE_6_DIGITS');
  return code;
 }finally{rl.close();}
}
function client(origin,basic){
 let cookie='',csrf='';
 const headers=()=>({
  Origin:origin,
  'Content-Type':'application/json',
  ...(cookie?{Cookie:cookie}:{}),
  ...(csrf?{'X-CSRF-Token':csrf}:{}),
  ...(basic?{Authorization:basic}:{})
 });
 return {
  reset(){cookie='';csrf='';},
  async call(path,body){
   const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:headers(),body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)});
   const next=cookieFrom(response.headers);if(next)cookie=next;
   const text=await response.text();let data;try{data=JSON.parse(text);}catch{throw Error('NON_JSON_RESPONSE_'+response.status);}
   if(data?.csrf)csrf=data.csrf;
   return {status:response.status,data};
  }
 };
}
async function main(args=process.argv.slice(2)){
 const origin=args.shift(),email=args.shift();if(!origin||!email)usage();
 let u;try{u=new URL(origin);}catch{usage();}
 if(u.protocol!=='https:'||u.origin!==origin||u.pathname!=='/'||u.search||u.hash)throw Error('HTTPS_ORIGIN_REQUIRED');
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)throw Error('VALID_TEST_EMAIL_REQUIRED');
 let basic='';
 while(args.length){
  const flag=args.shift();
  if(flag==='--basic-password-file'){
   const file=args.shift();if(!file||!file.startsWith('/')||!fs.statSync(file).isFile())throw Error('VALID_BASIC_PASSWORD_FILE_REQUIRED');
   const password=fs.readFileSync(file,'utf8').trim();if(!password)throw Error('EMPTY_BASIC_PASSWORD');
   basic='Basic '+Buffer.from('staging:'+password).toString('base64');continue;
  }
  usage();
 }
 const c=client(origin,basic),first=strongPassword(),second=strongPassword();
 console.log('Starting live email acceptance for '+mask(email)+'. No password or OTP value will be printed.');
 let r=await c.call('/api/account/session');if(r.status!==200)throw Error('SESSION_BOOTSTRAP_FAILED_'+r.status);
 r=await c.call('/api/account/email',{action:'continue',email,password:first});
 if(r.status!==200||!r.data?.verificationRequired||!r.data?.challengeId)throw Error('SIGNUP_OTP_NOT_STARTED_'+r.status+'_'+(r.data?.error||''));
 console.log('Signup OTP requested. Check the real mailbox now.');
 let code=await promptCode('Enter the 6-digit signup OTP: ');
 r=await c.call('/api/account/email',{action:'verify',challengeId:r.data.challengeId,code});code='';
 if(r.status!==200||!r.data?.linked||!r.data?.profile?.emailVerified)throw Error('SIGNUP_OTP_VERIFY_FAILED_'+r.status+'_'+(r.data?.error||''));
 const actor=r.data.profile.id,tag=r.data.profile.tag;
 console.log('Mailbox ownership verified and profile activated: '+tag);

 c.reset();r=await c.call('/api/account/session');if(r.status!==200)throw Error('RESET_SESSION_BOOTSTRAP_FAILED');
 r=await c.call('/api/account/email',{action:'forgot',email});
 if(r.status!==200||!r.data?.verificationRequired||!r.data?.challengeId)throw Error('RESET_OTP_NOT_STARTED_'+r.status+'_'+(r.data?.error||''));
 console.log('Password-reset OTP requested. Check the real mailbox now.');
 code=await promptCode('Enter the 6-digit reset OTP: ');
 const challenge=r.data.challengeId;
 r=await c.call('/api/account/email',{action:'verify',challengeId:challenge,code});code='';
 if(r.status!==200||!r.data?.resetReady)throw Error('RESET_OTP_VERIFY_FAILED_'+r.status+'_'+(r.data?.error||''));
 r=await c.call('/api/account/email',{action:'reset',challengeId:challenge,password:second});
 if(r.status!==200||!r.data?.linked||!r.data?.passwordChanged||r.data?.profile?.id!==actor)throw Error('PASSWORD_RESET_FAILED_'+r.status+'_'+(r.data?.error||''));
 console.log('Password reset completed and returned the same profile.');

 c.reset();r=await c.call('/api/account/session');if(r.status!==200)throw Error('OLD_PASSWORD_SESSION_FAILED');
 r=await c.call('/api/account/email',{action:'continue',email,password:first});
 if(r.status!==409||r.data?.error!=='INVALID_CREDENTIALS')throw Error('OLD_PASSWORD_STILL_ACCEPTED');

 c.reset();r=await c.call('/api/account/session');if(r.status!==200)throw Error('NEW_PASSWORD_SESSION_FAILED');
 r=await c.call('/api/account/email',{action:'continue',email,password:second});
 if(r.status!==200||!r.data?.linked||r.data?.profile?.id!==actor||r.data?.profile?.tag!==tag)throw Error('NEW_PASSWORD_SIGNIN_FAILED_'+r.status+'_'+(r.data?.error||''));

 console.log(JSON.stringify({passed:true,origin,email:mask(email),playerTag:tag,checks:['signup OTP delivered','mailbox ownership verified','reset OTP delivered','password changed','old password rejected','same profile restored']}));
}
if(require.main===module)main().catch(error=>{console.error('LIVE_EMAIL_ACCEPTANCE_FAILED: '+error.message);process.exitCode=1;});
module.exports={main,mask,strongPassword};
