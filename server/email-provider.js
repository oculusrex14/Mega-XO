'use strict';
const crypto=require('node:crypto');

const DEFAULT_FROM='Mega XOXO by Antimatter Innovations <contact@antimatterinnovations.com>';
const BRAND='Mega XOXO',DEVELOPER='Antimatter Innovations';
const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

class TransactionalEmail {
 constructor({apiKey=process.env.RESEND_API_KEY,from=process.env.MEGA_EMAIL_FROM||DEFAULT_FROM,fetcher=global.fetch}={}){
  this.apiKey=apiKey||'';this.from=from;this.fetcher=fetcher;
 }
 enabled(){return !!this.apiKey&&typeof this.fetcher==='function';}
 async sendOtp({to,code,purpose,idempotencyKey}){
  if(!this.enabled())throw Error('EMAIL_DELIVERY_NOT_CONFIGURED');
  const reset=purpose==='reset',subject=reset?'Reset your Mega XOXO password':'Verify your Mega XOXO email';
  const action=reset?'password reset':'email verification';
  const text=`${BRAND} ${action} code: ${code}\n\nThis code expires in 10 minutes and can be used once. If you did not request this, ignore this email.\n\n${BRAND} is developed by ${DEVELOPER}.\n`;
  const html=`<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:auto;padding:28px"><p style="font-size:12px;letter-spacing:.12em;text-transform:uppercase">${DEVELOPER}</p><h1 style="font-size:24px">${BRAND}</h1><p>Use this one-time code for ${esc(action)}:</p><p style="font-size:34px;font-weight:700;letter-spacing:.18em;margin:24px 0">${esc(code)}</p><p>This code expires in <strong>10 minutes</strong> and can be used once.</p><p style="color:#666">If you did not request this, you can ignore this email.</p><hr style="border:0;border-top:1px solid #ddd;margin:28px 0"><p style="font-size:12px;color:#666">${BRAND} is developed by ${DEVELOPER}.</p></div>`;
  return this._send({to,subject,text,html,idempotencyKey});
 }
 async sendSecurityNotice({to,event,detail='',idempotencyKey}){
  if(!this.enabled())return {skipped:true};
  const labels={
   email_changed:'Your Mega XOXO email was changed',
   provider_linked:'A sign-in method was linked to your Mega XOXO profile',
   provider_unlinked:'A sign-in method was removed from your Mega XOXO profile',
   session_revoked:'A Mega XOXO session was signed out',
   other_sessions_revoked:'Other Mega XOXO sessions were signed out',
   incident_sessions_revoked:'Mega XOXO signed out all sessions for security'
  };
  const subject=labels[event]||'Mega XOXO security notice';
  const safeDetail=String(detail||'').slice(0,240);
  const text=`${subject}.\n\n${safeDetail?safeDetail+'\n\n':''}If you did not make this change, contact Antimatter Innovations at contact@antimatterinnovations.com.\n\nMega XO is developed by Antimatter Innovations.\n`;
  const html=`<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:auto;padding:28px"><p style="font-size:12px;letter-spacing:.12em;text-transform:uppercase">${DEVELOPER}</p><h1 style="font-size:24px">${BRAND}</h1><p><strong>${esc(subject)}</strong></p>${safeDetail?'<p>'+esc(safeDetail)+'</p>':''}<p>If you did not make this change, contact <a href="mailto:contact@antimatterinnovations.com">contact@antimatterinnovations.com</a>.</p></div>`;
  return this._send({to,subject,text,html,idempotencyKey});
 }
 async sendPasswordChanged({to,idempotencyKey}){
  if(!this.enabled())return {skipped:true};
  const subject='Your Mega XOXO password was changed';
  const text=`Your Mega XOXO password was changed. If this was not you, contact Antimatter Innovations at contact@antimatterinnovations.com immediately.\n\nMega XO is developed by Antimatter Innovations.\n`;
  const html=`<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:auto;padding:28px"><p style="font-size:12px;letter-spacing:.12em;text-transform:uppercase">${DEVELOPER}</p><h1 style="font-size:24px">${BRAND}</h1><p>Your password was changed successfully.</p><p>If this was not you, contact <a href="mailto:contact@antimatterinnovations.com">contact@antimatterinnovations.com</a> immediately.</p><p style="font-size:12px;color:#666">${BRAND} is developed by ${DEVELOPER}.</p></div>`;
  return this._send({to,subject,text,html,idempotencyKey});
 }
 async _send({to,subject,text,html,idempotencyKey}){
  const response=await this.fetcher('https://api.resend.com/emails',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+this.apiKey,...(idempotencyKey?{'Idempotency-Key':idempotencyKey}:{})},body:JSON.stringify({from:this.from,to:[to],subject,text,html})});
  let body={};try{body=await response.json();}catch{}
  if(!response.ok)throw Error('EMAIL_DELIVERY_FAILED');
  return body;
 }
}
module.exports={TransactionalEmail,DEFAULT_FROM,BRAND,DEVELOPER};
