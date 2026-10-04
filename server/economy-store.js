/* Durable serialized reference service (Node >=22.13, node:sqlite).
 * Connect a real authentication/receipt layer before exposing any command to a network.
 * `principal` is supplied by that layer, NOT read from request JSON.
 * A single state row + BEGIN IMMEDIATE makes all monetary/rating writes atomic, including
 * concurrent processes. This deliberately trades throughput for an auditable first service.
 */
'use strict';
const {DatabaseSync}=require('node:sqlite'),crypto=require('node:crypto');
const {Authority}=require('../src/authority.js');
class DurableStore {
 constructor(path,options={}){
  this.options=options;this.db=new DatabaseSync(path);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  this.db.exec('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, actor TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT NOT NULL);');
  this.db.prepare('INSERT OR IGNORE INTO state(id,json) VALUES(1,?)').run(JSON.stringify(new Authority(options).export()));
 }
 read(){return new Authority({...this.options,state:JSON.parse(this.db.prepare('SELECT json FROM state WHERE id=1').get().json)});}
 /* All externally reachable commands must pass through this transaction boundary. */
 run(principal,key,cmd){
  if(!principal||typeof principal.actor!=='string'||!principal.actor||!['player','operator','matchmaker','store'].includes(principal.scope))throw Error('AUTH_REQUIRED');
  if(typeof key!=='string'||!key||key.length>160||!cmd||typeof cmd.type!=='string')throw Error('INVALID_COMMAND');
  const id=JSON.stringify([principal.actor,key]),fingerprint=crypto.createHash('sha256').update(JSON.stringify({principal,cmd})).digest('hex');
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const previous=this.db.prepare('SELECT fingerprint,response FROM commands WHERE id=?').get(id);
   if(previous){if(previous.fingerprint!==fingerprint)throw Error('IDEMPOTENCY_CONFLICT');this.db.exec('COMMIT');return JSON.parse(previous.response);}
   const a=this.read(),actor=principal.actor;let result;
   const role=(...roles)=>{if(!roles.includes(principal.scope))throw Error('FORBIDDEN');};
   switch(cmd.type){
    case 'preferences': result=a.preferences(actor,cmd.changes||{});break;
    case 'cosmetic': result=a.cosmetic(actor,cmd.name);break;
    case 'friend': result=a.requestFriend(actor,cmd.target);break;
    case 'acceptFriend': result=a.acceptFriend(actor,cmd.from);break;
    case 'convert': result=a.convert(actor,cmd.from,cmd.amount,key);break;
    case 'quest': result=a.claimQuest(actor,cmd.quest);break;
    case 'offer': result=a.offer(cmd.id,actor,cmd.opponent,cmd.terms);break;
    case 'accept': result=a.accept(cmd.id,actor,cmd.termsHash);break;
    case 'decline': result=a.decline(cmd.id,actor);break;
    case 'cancel': result=a.cancel(cmd.id,actor);break;
    case 'move': result=a.move(cmd.id,actor,cmd.revision,key,cmd.move);break;
    case 'resign': result=a.resign(cmd.id,actor);break;
    case 'purchase': result=a.purchase(actor,cmd.evidence);break;
    case 'provision': role('operator');result=a.addAccount(cmd.account,cmd.options);break;
    case 'queue': role('matchmaker');result=a.offerQueue(cmd.id,cmd.a,cmd.b);break;
    case 'timeout': role('operator','matchmaker');result=a.timeout(cmd.id);break;
    case 'expire': role('operator','matchmaker');result=a.expire(cmd.id);break;
    case 'void': role('operator');result=a.voidByOperator(cmd.id,cmd.reason);break;
    case 'snapshot': role('operator');result=a.snapshotDay();break;
    case 'weekly': role('operator');result=a.payoutWeek(cmd.week);break;
    case 'refund': role('store');result=a.refundPurchase(cmd.store,cmd.transactionId);break;
    default: throw Error('UNKNOWN_COMMAND');
   }
   result=result??{ok:true};const response=JSON.stringify(result);
   this.db.prepare('UPDATE state SET json=? WHERE id=1').run(JSON.stringify(a.export()));
   this.db.prepare('INSERT INTO commands(id,actor,fingerprint,response) VALUES(?,?,?,?)').run(id,actor,fingerprint,response);
   this.db.exec('COMMIT');return JSON.parse(response);
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 close(){this.db.close();}
}
module.exports={DurableStore};
