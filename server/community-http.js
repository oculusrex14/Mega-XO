/* Same-origin authenticated entrypoint. This router sits in front of the existing
 * economy and party handlers; provider credentials never enter the browser. */
'use strict';
const {createHandler}=require('./http.js');
const D=require('../src/domain.js');
const C=require('../packages/contracts');
const safeError=e=>C.guards.publicCode(e.message);
const key=C.guards.operationKey;
const send=(res,status,value)=>C.guards.writeJson(res,status,value,{noReferrer:true});
const readBody=(req,limit=300000)=>C.guards.readJsonBody(req,limit);
const cookies=C.guards.cookies;
function createCommunityHandler({community,providers,emailer,store,matchmaker,origin,allowLocalHttp=false,networkContext=()=>({})}){
 const url=new URL(origin),secure=url.protocol==='https:';if(!secure&&(!allowLocalHttp||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw Error('HTTPS_REQUIRED');
 const cookieName=secure?'__Host-mega_session':'mega_dev_session',token=req=>C.guards.sessionToken(req,cookieName);
 const setCookie=(res,value,age)=>res.setHeader('Set-Cookie',cookieName+'='+value+'; Path=/; HttpOnly; SameSite=Lax; Max-Age='+age+(secure?'; Secure':''));
 const authenticate=async req=>{const s=community.session(token(req));return s?.actor?{id:s.actor}:null;};
 const base=createHandler({store,authenticate,origin,matchmaker});
 const mine=req=>community.requireLinked(token(req));
 const display=(m,actor)=>{
  if(m.status==='OFFERED'&&m.terms.source==='queue')return {id:m.id,status:m.status,termsHash:m.termsHash,created:m.created,expires:m.expires,players:[actor],accepted:m.accepted.includes(actor)?[actor]:[],opponentHidden:true,quote:m.quote,terms:{source:'queue',kind:m.terms.kind,rated:m.terms.rated,turnSeconds:m.terms.turnSeconds},serverNow:community.now()};
  return {...m,playerNames:Object.fromEntries(m.players.map(id=>[id,community.profileRow(id)?.display_name||'Player'])),challengerName:community.profileRow(m.players[0])?.display_name||'Player',serverNow:community.now()};
 };
 async function handler(req,res){
  const path=new URL(req.url,origin).pathname,q=new URL(req.url,origin).searchParams;
  if(path.startsWith('/auth/callback/')){
   try{if(req.method!=='GET')throw Error('INVALID_CALLBACK');const p=path.slice('/auth/callback/'.length);const attempt=community.consume(token(req),q.get('state'),p,'web');if(q.has('error'))throw Error('SIGNIN_CANCELLED');const identity=await providers.exchange(p,q.get('code'),attempt,origin+'/auth/callback/'+p);const logged=community.finishVerified(token(req),attempt,identity);setCookie(res,logged.token,14*86400);res.writeHead(303,{Location:'/?account=linked','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end();}
   catch(e){res.writeHead(303,{Location:'/?authError='+encodeURIComponent(safeError(e)),'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end();}return true;
  }
  if(!path.startsWith('/api/account')&&!path.startsWith('/api/community')&&!path.startsWith('/api/v1'))return false;
  try{
   if(!['GET','POST'].includes(req.method))return send(res,405,{error:'METHOD_NOT_ALLOWED'}),true;
   if(req.method==='POST'){C.guards.requireSameOriginJson(req,origin);community.csrf(token(req),req.headers['x-csrf-token']);}
   if(path==='/api/account/session'&&req.method==='GET'){const boot=community.bootstrap(token(req));if(boot.token)setCookie(res,boot.token,boot.actor?14*86400:86400);return send(res,200,{linked:!!boot.actor,csrf:boot.csrf,providers:{...providers.capabilities(),email:{web:true,native:false}},profile:boot.actor?community.profile(boot.actor,boot.actor):null}),true;}
   if(req.method==='GET'){
    const s=mine(req),actor=s.actor;
    if(path==='/api/account/save')return send(res,200,community.restore(actor)),true;
    if(path==='/api/account/sessions')return send(res,200,{sessions:community.sessions(token(req))}),true;
    if(path==='/api/account/deletion')return send(res,200,community.deletionStatus(token(req))),true;
    if(path==='/api/community/friends')return send(res,200,community.friends(actor)),true;
    if(path==='/api/community/search')return send(res,200,community.search(actor,q.get('q')||'')),true;
    if(path.startsWith('/api/community/profile/')){const id=community.resolve(decodeURIComponent(path.slice('/api/community/profile/'.length)));return send(res,200,community.profile(actor,id)),true;}
    if(path==='/api/v1/profile'){
     const a=store.read(),account=a.account(actor),p=community.profile(actor,actor),friends=community.friends(actor);
     return send(res,200,{...p,tag:p.tag,friendCode:p.tag,wallet:{coins:account.coins,crowns:account.crowns,reservedCoins:account.reservedCoins,reservedCrowns:account.reservedCrowns,owned:account.owned,ledger:a.journal.filter(e=>e.actor===actor).slice(-40)},records:account.history,daily:account.daily[D.day(a.now())]||{},friends:friends.friends.map(f=>({...f,online:f.presence.online})),friendRequests:friends.incoming.map(f=>f.id),wealthPublic:account.wealthPublic}),true;
    }
    if(path==='/api/v1/invitations'){const a=store.read();return send(res,200,[...a.matches.values()].filter(m=>m.players.includes(actor)&&!m.accepted.includes(actor)&&m.status==='OFFERED'&&m.expires>community.now()).map(m=>display(a.view(m.id),actor))),true;}
    if(path==='/api/community/challenges'){const a=store.read();return send(res,200,[...a.matches.values()].filter(m=>m.players.includes(actor)&&m.status==='OFFERED'&&m.expires>community.now()&&m.terms.source!=='queue').map(m=>display(a.view(m.id),actor))),true;}
    if(path==='/api/v1/queue'){matchmaker.tick();return send(res,200,matchmaker.status(actor)),true;}
    if(path.startsWith('/api/v1/match/')){let a=store.read(),m=a.view(decodeURIComponent(path.slice('/api/v1/match/'.length)));if(!m.players.includes(actor))throw Error('NOT_PARTICIPANT');
     if(m.status==='OFFERED'&&m.expires<=community.now())try{store.run({actor:'clock',scope:'matchmaker'},'expire:'+m.id,{type:'expire',id:m.id});}catch{}
     if(m.status==='PLAYING'&&m.deadline!==null&&m.deadline<=community.now())try{store.run({actor:'clock',scope:'matchmaker'},'timeout:'+m.id+':'+m.revision,{type:'timeout',id:m.id});}catch{}
     return send(res,200,display(store.read().view(m.id),actor)),true;
    }
    if(path.startsWith('/api/v1')){await base(req,res);return true;}return send(res,404,{error:'NOT_FOUND'}),true;
   }
   // Bodies are parsed exactly once. Known base mutations are reconstructed below.
   const b=await readBody(req),session=community.requireSession(token(req));
   if(path==='/api/account/email'){
    const action=b.action;
    if(action==='continue'){
     const result=community.emailContinue(token(req),b.email,b.password);
     if(result.verificationRequired){if(!emailer?.enabled?.())throw Error('EMAIL_DELIVERY_NOT_CONFIGURED');await emailer.sendOtp(result.delivery);const {delivery,...publicResult}=result;return send(res,200,{linked:false,...publicResult}),true;}
     setCookie(res,result.token,14*86400);return send(res,200,{linked:true,csrf:result.csrf,profile:result.profile,created:result.created}),true;
    }
    if(action==='verify'){
     const result=community.emailVerify(token(req),b.challengeId,b.code);
     if(result.emailChanged){for(const to of [result.oldEmail,result.newEmail])emailer?.sendSecurityNotice?.({to,event:'email_changed',detail:'The email address used to sign in to your Mega XO profile was changed.',idempotencyKey:'mega-xo/email-changed/'+b.challengeId+'/'+to}).catch(()=>{});delete result.oldEmail;delete result.newEmail;}
     if(result.token){setCookie(res,result.token,14*86400);return send(res,200,{linked:true,csrf:result.csrf,profile:result.profile,created:result.created,verified:true}),true;}
     return send(res,200,result),true;
    }
    if(action==='link'){
     if(!emailer?.enabled?.())throw Error('EMAIL_DELIVERY_NOT_CONFIGURED');const result=community.emailLinkStart(token(req),b.email,b.password);await emailer.sendOtp(result.delivery);const {delivery,...publicResult}=result;return send(res,200,publicResult),true;
    }
    if(action==='forgot'){
     if(!emailer?.enabled?.())throw Error('EMAIL_DELIVERY_NOT_CONFIGURED');const started=community.emailResetStart(token(req),b.email),delivery=started.delivery;const minimum=new Promise(r=>setTimeout(r,350));if(delivery)await Promise.all([emailer.sendOtp(delivery),minimum]);else await minimum;const {delivery:_,...publicResult}=started;return send(res,200,{...publicResult,message:'If this email has a Mega XO account, a reset code has been sent.'}),true;
    }
    if(action==='reset'){
     const result=community.emailResetComplete(token(req),b.challengeId,b.password);setCookie(res,result.token,14*86400);emailer?.sendPasswordChanged?.({to:result.passwordChangedEmail,idempotencyKey:'mega-xo/password-changed/'+b.challengeId}).catch(()=>{});return send(res,200,{linked:true,csrf:result.csrf,profile:result.profile,passwordChanged:true}),true;
    }
    if(action==='reauth')return send(res,200,community.emailReauth(token(req),b.email,b.password)),true;
    throw Error('INVALID_AUTH_REQUEST');
   }
   if(path==='/api/account/start'){
    const p=b.provider;if(!providers.enabled(p))throw Error('PROVIDER_NOT_CONFIGURED');const attempt=community.start(token(req),p,b.intent||'login','web');return send(res,200,{url:providers.authorization(p,attempt,origin+'/auth/callback/'+p)}),true;
   }
   if(path==='/api/account/native/challenge'){if(!providers.capabilities()[b.provider]?.native)throw Error('PROVIDER_NOT_CONFIGURED');const attempt=community.start(token(req),b.provider,b.intent||'login','native');return send(res,200,{state:attempt.state,nonce:attempt.nonce,expires:attempt.expires}),true;}
   if(path==='/api/account/native/finish'){const attempt=community.consume(token(req),b.state,b.provider,'native'),identity=await providers.verify(b.provider,b.idToken,attempt.nonce,'native'),logged=community.finishVerified(token(req),attempt,identity);setCookie(res,logged.token,14*86400);return send(res,200,{linked:true,csrf:logged.csrf,profile:logged.profile,created:logged.created}),true;}
   if(path==='/api/account/logout'){const result=community.logout(token(req),b.allDevices===true);setCookie(res,'',0);return send(res,200,result),true;}
   if(path==='/api/account/sessions/revoke')return send(res,200,b.allOthers===true?community.revokeOtherSessions(token(req)):community.revokeSession(token(req),b.id)),true;
   const actor=mine(req).actor;
   if(path==='/api/account/export')return send(res,200,community.exportData(token(req))),true;
   if(path==='/api/account/delete'){const result=community.deleteAccount(token(req),b.confirmation);setCookie(res,'',0);return send(res,200,result),true;}
   if(path==='/api/account/unlink')return send(res,200,community.unlink(token(req),b.provider)),true;
   if(path==='/api/account/profile')return send(res,200,community.edit(actor,b)),true;
   if(path==='/api/account/save')return send(res,200,community.save(actor,b.revision,b.practice)),true;
   if(path==='/api/community/presence')return send(res,200,community.heartbeat(token(req),b.foreground)),true;
   if(path==='/api/community/friend')return send(res,200,community.social(actor,key(req),b.action,b.target)),true;
   if(path==='/api/community/report')return send(res,200,community.report(actor,b.target,b.category,b.detail||'')),true;
   if(path==='/api/v1/friend')return send(res,200,community.social(actor,key(req),'request',b.target)),true;
   if(path==='/api/v1/accept-friend')return send(res,200,community.social(actor,key(req),'accept',b.from)),true;
   if(path==='/api/v1/queue')return send(res,200,matchmaker.enqueue(actor,b.mode,key(req),await networkContext(req,actor))),true;
   if(path==='/api/v1/cancel-queue')return send(res,200,matchmaker.cancel(actor,key(req))),true;
   let cmd;switch(path){
    case '/api/v1/offer':{
     const target=community.resolve(b.opponent);if(b.terms?.kind==='friend'&&community.relation(actor,target)!=='friend')throw Error('FRIENDSHIP_REQUIRED');
     if(matchmaker.busy(actor)||matchmaker.busy(target))throw Error('ALREADY_QUEUED');
     community.rate(actor,'challenges',20,3600);cmd=C.commands.offer(b,target);break;
    }
    case '/api/v1/accept':{const m=store.read().view(b.id);if(m.terms.kind==='friend'&&community.relation(...m.players)!=='friend')throw Error('FRIENDSHIP_REQUIRED');cmd=C.commands.accept(b);break;}
    case '/api/v1/decline':cmd=C.commands.decline(b);break;
    case '/api/v1/cancel':cmd=C.commands.cancel(b);break;
    case '/api/v1/move':cmd=C.commands.move(b);break;
    case '/api/v1/resign':cmd=C.commands.resign(b);break;
    case '/api/v1/convert':cmd=C.commands.convert(b);break;
    case '/api/v1/quest':cmd=C.commands.quest(b);break;
    case '/api/v1/preferences':cmd=C.commands.preferences(b);break;
    case '/api/v1/cosmetic':cmd=C.commands.cosmetic(b);break;
    case '/api/v1/purchase':cmd=C.commands.purchase(b);break;
    default:return send(res,404,{error:'NOT_FOUND'}),true;
   }
   const result=store.run({actor,scope:'player'},key(req),cmd);return send(res,200,result?.players?display(result,actor):result),true;
  }catch(e){return send(res,C.guards.accountStatus(e.message),{error:safeError(e)}),true;}
 }
 handler.authenticate=authenticate;handler.token=token;handler.guard=req=>{if(req.method==='POST'){C.guards.requireExactOrigin(req,origin);community.csrf(token(req),req.headers['x-csrf-token']);}};return handler;
}
module.exports={createCommunityHandler,readBody,cookies};
