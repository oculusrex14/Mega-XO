'use strict';
const crypto = require('node:crypto');
const {promisify} = require('node:util');
const scrypt=promisify(crypto.scrypt);
function validate(password) {
 if(typeof password!=='string'||password.length<10||password.length>128||!/[A-Za-z]/.test(password)||!/[0-9]/.test(password)) throw Error('PASSWORD_WEAK');
 return password;
}
function equal(a,b) {
 const x=Buffer.from(a),y=Buffer.from(b);
 return x.length===y.length && crypto.timingSafeEqual(x,y);
}
class Passwords {
 constructor({concurrency=2,maxQueue=16,queueMs=3000}={}) {
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>4) throw Error('INVALID_AUTH_CONCURRENCY');
  this.concurrency=concurrency;this.maxQueue=maxQueue;this.queueMs=queueMs;this.active=0;this.waiting=[];this.closed=false;
 }
 run(work) {
  if(this.closed||this.waiting.length>=this.maxQueue) return Promise.reject(Error('AUTH_BUSY'));
  return new Promise((resolve,reject)=>{
   const task={work,resolve,reject};
   task.timer=setTimeout(()=>{const i=this.waiting.indexOf(task);if(i>=0){this.waiting.splice(i,1);reject(Error('AUTH_BUSY'));}},this.queueMs);
   this.waiting.push(task);this.pump();
  });
 }
 pump() {
  while(!this.closed&&this.active<this.concurrency&&this.waiting.length) {
   const task=this.waiting.shift();clearTimeout(task.timer);this.active++;
   Promise.resolve().then(task.work).then(task.resolve,()=>task.reject(Error('PASSWORD_PROCESSING_FAILED'))).finally(()=>{this.active--;this.pump();});
  }
 }
 async hash(password) {
  validate(password);const salt=crypto.randomBytes(16).toString('base64url');
  const key=await this.run(()=>scrypt(password,Buffer.from(salt,'base64url'),32,{N:131072,r:8,p:1,maxmem:192*1024*1024}));
  return {salt,password_hash:'scrypt-v1$'+key.toString('base64url')};
 }
 async verify(password,salt,stored) {
  try {validate(password);} catch {return false;}
  if(typeof salt!=='string'||typeof stored!=='string') return false;
  const modern=stored.startsWith('scrypt-v1$'),encoded=modern?stored.slice(10):stored;
  if(!/^[A-Za-z0-9_-]{43}$/.test(encoded)) return false;
  const key=await this.run(()=>scrypt(password,Buffer.from(salt,'base64url'),32,{N:modern?131072:16384,r:8,p:1,maxmem:192*1024*1024}));
  return equal(key,Buffer.from(encoded,'base64url'));
 }
 close() {this.closed=true;for(const t of this.waiting){clearTimeout(t.timer);t.reject(Error('AUTH_BUSY'));}this.waiting=[];}
}
module.exports={Passwords,validate,equal};
