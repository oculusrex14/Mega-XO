'use strict';
const {AsyncLocalStorage}=require('node:async_hooks');
// Request-local read reuse only. It is never a source of truth, shared mutable
// state between requests, or a cache used by financial write transactions.
class ReadContext {
 constructor(store){
  if(typeof store.db.isTransaction!=='boolean')throw Error('SQLITE_TRANSACTION_STATE_REQUIRED');
  this.store=store;this.local=new AsyncLocalStorage();this.original=store.read.bind(store);this.hits=0;this.misses=0;
  const changes=store.db.prepare('SELECT total_changes() AS value'),version=store.db.prepare('PRAGMA data_version');
  store.read=()=>{
   const context=this.local.getStore();
   if(!context||store.db.isTransaction)return this.original();
   // total_changes catches writes AND rolled-back writes on this connection;
   // data_version catches commits from the rooms/other database connection.
   const key=changes.get().value+':'+version.get().data_version;
   if(context.key===key&&context.value){this.hits++;return context.value;}
   this.misses++;context.key=key;context.value=this.original();return context.value;
  };
 }
 run(fn){return this.local.run({},fn);}
 close(){this.store.read=this.original;this.local.disable();}
}
module.exports={ReadContext};
