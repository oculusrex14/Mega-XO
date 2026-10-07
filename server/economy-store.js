/* Durable serialized reference service (Node >=22.13, node:sqlite).
 * Connect a real authentication/receipt layer before exposing any command to a network.
 * `principal` is supplied by that layer, NOT read from request JSON.
 * A single state row + BEGIN IMMEDIATE makes all monetary/rating writes atomic, including
 * concurrent processes. This deliberately trades throughput for an auditable first service.
 * P01: DurableStore.run is implemented on the shared unit of work (packages/db) and adopts
 * the frozen packages/contracts invocation validator and packages/domain command executor.
 */
'use strict';
const {DatabaseSync}=require('node:sqlite'),crypto=require('node:crypto');
const {Authority}=require('../src/authority.js');
const {executeCommand}=require('../packages/domain');
const {validateInvocation}=require('../packages/contracts');
const {createSqliteUnitOfWork}=require('../packages/db');
const {getRepositories}=require('../packages/db/context');
const {COMMANDS}=require('../packages/db/scopes');
class DurableStore {
 constructor(path,options={}){
  this.options=options;this.db=new DatabaseSync(path);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  this.db.exec('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, actor TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT NOT NULL);');
  this.uow=createSqliteUnitOfWork(this.db,options);
  this.db.prepare('INSERT OR IGNORE INTO state(id,json) VALUES(1,?)').run(JSON.stringify(new Authority(options).export()));
 }
 read(){return new Authority({...this.options,state:JSON.parse(this.db.prepare('SELECT json FROM state WHERE id=1').get().json)});}
 /* Live repositories bound to this connection's unit of work. */
 repositories(){return getRepositories(this.db,this.options);}
 /* All externally reachable commands must pass through this transaction boundary. */
 run(principal,key,cmd){
  validateInvocation(principal,key,cmd);
  const id=JSON.stringify([principal.actor,key]),fingerprint=crypto.createHash('sha256').update(JSON.stringify({principal,cmd})).digest('hex');
  return this.uow.run(tx=>{
   const repositories=tx.repositories;
   const previous=repositories.outcomes.find(COMMANDS,id);
   if(previous){if(previous.fingerprint!==fingerprint)throw Error('IDEMPOTENCY_CONFLICT');return JSON.parse(previous.response);}
   const graph=repositories.domain(),actor=principal.actor;
   let result=executeCommand(graph.authority,principal,key,cmd);
   result=result??{ok:true};const response=JSON.stringify(result);
   repositories.commitDomain();
   repositories.outcomes.save(COMMANDS,id,actor,fingerprint,response);
   return JSON.parse(response);
  });
 }
 close(){this.uow.close();this.db.close();}
}
module.exports={DurableStore};
