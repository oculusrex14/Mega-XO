'use strict';
const crypto=require('node:crypto');

class AbuseGuard{
 constructor(db,{secret,now=Date.now,maxMemory=20000}={}){
  if(!db||typeof secret!=='string'||secret.length<32)throw Error('ABUSE_GUARD_CONFIG');
  this.db=db;this.secret=Buffer.from(secret);this.now=now;this.maxMemory=maxMemory;this.memoryBuckets=new Map();
 }
 subject(ip){return crypto.createHmac('sha256',this.secret).update(String(ip)).digest('hex').slice(0,32);}
 memory(ip,scope,limit,seconds=60){
  const now=this.now(),window=Math.floor(now/(seconds*1000)),key=scope+':'+this.subject(ip)+':'+window;
  let item=this.memoryBuckets.get(key);
  if(!item){
   if(this.memoryBuckets.size>=this.maxMemory){
    for(const [k,v] of this.memoryBuckets)if(v.expires<=now)this.memoryBuckets.delete(k);
    if(this.memoryBuckets.size>=this.maxMemory)return false;
   }
   item={hits:0,expires:(window+1)*seconds*1000};this.memoryBuckets.set(key,item);
  }
  item.hits++;return item.hits<=limit;
 }
 persistent(ip,scope,limit,seconds){
  const now=this.now(),window=Math.floor(now/(seconds*1000)),id='abuse:'+scope+':'+this.subject(ip)+':'+window;
  const row=this.db.prepare('INSERT INTO v4_limits(id,hits,expires) VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET hits=hits+1 RETURNING hits').get(id,(window+1)*seconds*1000);
  return row.hits<=limit;
 }
 coarse(ip,path,method){
  if(!this.memory(ip,'all',600,60))return false;
  if(path==='/api/account/session'&&method==='GET'&&!this.memory(ip,'guest-session',60,60))return false;
  if(path.startsWith('/api/account/')&&method==='POST'&&!this.memory(ip,'account-post',30,60))return false;
  if(path==='/api/community/search'&&!this.memory(ip,'search',120,60))return false;
  if(path==='/api/monetization/admob-ssv'&&!this.memory(ip,'ssv',120,60))return false;
  return true;
 }
 sensitive(ip,path,method,body){
  if(method!=='POST')return true;
  if(path==='/api/account/email'){
   switch(body?.action){
    case 'continue':return this.persistent(ip,'email-continue',12,300);
    case 'forgot':return this.persistent(ip,'email-forgot',12,3600);
    case 'verify':return this.persistent(ip,'email-verify',40,300);
    case 'reset':return this.persistent(ip,'email-reset',12,300);
    case 'reauth':return this.persistent(ip,'email-reauth',16,300);
    case 'link':return this.persistent(ip,'email-link',10,600);
    case 'change':return this.persistent(ip,'email-change',8,3600);
    default:return this.persistent(ip,'email-other',12,300);
   }
  }
  if(path==='/api/account/export')return this.persistent(ip,'data-export',12,86400);
  if(path==='/api/account/delete')return this.persistent(ip,'account-delete',4,86400);
  if(path==='/api/monetization/google-play-rtdn'||path==='/api/monetization/apple-notifications')return this.persistent(ip,'store-notification',240,60);
  if(path==='/api/account/start'||path==='/api/account/native/challenge'||path==='/api/account/native/finish')return this.persistent(ip,'provider-auth',30,300);
  if(path==='/api/community/report')return this.persistent(ip,'player-report',20,3600);
  if(path==='/api/community/friend'||path==='/api/v1/offer')return this.persistent(ip,'social-mutation',90,300);
  return true;
 }
 cleanup(){
  const now=this.now();for(const [k,v] of this.memoryBuckets)if(v.expires<=now)this.memoryBuckets.delete(k);
  this.db.prepare("DELETE FROM v4_limits WHERE id LIKE 'abuse:%' AND expires<?").run(now);
 }
}
module.exports={AbuseGuard};
