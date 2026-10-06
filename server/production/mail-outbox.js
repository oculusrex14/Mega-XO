'use strict';
const crypto=require('node:crypto');
const {TransactionalEmail}=require('../email-provider');
const DAY=86400000;
function hit(db,secret,label,subject,limit,seconds,now=Date.now()) {
 const window=Math.floor(now/(seconds*1000));
 const id=label+':'+crypto.createHmac('sha256',secret).update(subject).digest('hex')+':'+window;
 const result=db.prepare('INSERT INTO v4_limits(id,hits,expires) VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET hits=hits+1 RETURNING hits').get(id,(window+1)*seconds*1000);
 if(result.hits>limit) throw Error('RATE_LIMITED');
}
class MailOutbox {
 constructor(community,{secret,daily=80,monthly=2400,email={},transport,now=Date.now,log=()=>{}}) {
  Object.assign(this,{c:community,db:community.db,secret,daily,monthly,now,log});this.active=false;this.closed=false;
  this.key=Buffer.from(crypto.hkdfSync('sha256',Buffer.from(secret),Buffer.alloc(0),'mega-xo-v4-mail',32));
  this.transport=transport||new TransactionalEmail({...email,fetcher:async(url,options)=>{
   const response=await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(6000)});
   const text=await response.text();if(Buffer.byteLength(text)>65536) throw Error('EMAIL_DELIVERY_FAILED');
   return new Response(text,{status:response.status,headers:{'Content-Type':'application/json'}});
  }});
 }
 enabled(){return this.transport.enabled()===true;}
 seal(value) {
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',this.key,iv);
  const data=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
  return [iv,cipher.getAuthTag(),data].map(x=>x.toString('base64url')).join('.');
 }
 open(value) {
  const [iv,tag,data]=value.split('.').map(x=>Buffer.from(x,'base64url'));
  const decipher=crypto.createDecipheriv('aes-256-gcm',this.key,iv);decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(data),decipher.final()]).toString('utf8'));
 }
 budget() {
  const now=this.now(),day=new Date(now).toISOString().slice(0,10),month=day.slice(0,7);
  // Caller owns a short transaction. Budget counts requests conservatively,
  // including retries, so a crash cannot reset the allowance.
  for(const [period,limit] of [[day,this.daily],[month,this.monthly]]) {
   const row=this.db.prepare('INSERT INTO v4_limits VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET hits=hits+1 RETURNING hits').get('mail-budget:'+period,now+40*DAY);
   if(row.hits>limit) throw Error('EMAIL_BUDGET_EXCEEDED');
  }
 }
 enqueue(id,message,expires,kind='otp') {
  if(!this.enabled()) throw Error('EMAIL_DELIVERY_NOT_CONFIGURED');
  if(this.db.prepare("SELECT count(*) n FROM v4_outbox WHERE state IN ('queued','sending')").get().n>=200) throw Error('EMAIL_QUEUE_FULL');
  this.budget();
  this.db.prepare('INSERT INTO v4_outbox(id,payload,kind,state,created,expires,next_at) VALUES(?,?,?,?,?,?,?)').run(id,this.seal({...message,idempotencyKey:'mega-xo/v4/'+id}),kind,'queued',this.now(),expires,this.now());
 }
 async tick() {
  if(this.closed||this.active||!this.enabled()) return;
  this.active=true;
  try {
   const row=this.c.tx(()=>{
    const now=this.now();
    this.db.prepare("UPDATE v4_outbox SET state='expired',payload=NULL WHERE expires<=? AND state IN ('queued','sending')").run(now);
    const item=this.db.prepare("SELECT * FROM v4_outbox WHERE expires>? AND attempts<3 AND ((state='queued' AND next_at<=?) OR (state='sending' AND lease_until<=?)) ORDER BY created LIMIT 1").get(now,now,now);
    if(!item)return null;
    if(item.attempts>0)this.budget();
    this.db.prepare("UPDATE v4_outbox SET state='sending',attempts=attempts+1,lease_until=? WHERE id=?").run(now+15000,item.id);
    return item;
   });
   if(!row)return;
   try {
    const message=this.open(row.payload);
    if(row.kind==='changed')await this.transport.sendPasswordChanged(message);else await this.transport.sendOtp(message);
    this.db.prepare("UPDATE v4_outbox SET state='sent',payload=NULL,lease_until=0 WHERE id=?").run(row.id);
    this.log({event:'mail_sent'});
   } catch {
    const exhausted=row.attempts+1>=3;
    this.db.prepare('UPDATE v4_outbox SET state=?,payload=CASE WHEN ? THEN NULL ELSE payload END,next_at=?,lease_until=0 WHERE id=?').run(exhausted?'failed':'queued',exhausted?1:0,this.now()+15000*(row.attempts+1),row.id);
    this.log({event:'mail_delivery_failed'});
   }
  } catch {this.log({event:'mail_worker_unavailable'});}
  finally {this.active=false;}
 }
 close(){this.closed=true;}
 cleanup(){this.db.prepare('DELETE FROM v4_limits WHERE expires<?').run(this.now());this.db.prepare("DELETE FROM v4_outbox WHERE created<? AND state NOT IN ('queued','sending')").run(this.now()-7*DAY);}
}
module.exports={MailOutbox,hit};
