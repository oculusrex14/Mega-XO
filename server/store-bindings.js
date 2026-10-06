'use strict';
const crypto=require('node:crypto');

class StoreBindings{
 constructor(db,{now=Date.now}={}){if(!db)throw Error('STORE_BINDINGS_CONFIG');this.db=db;this.now=now;}
 get(actor){
  if(typeof actor!=='string'||!actor)throw Error('INVALID_ACCOUNT');
  let row=this.db.prepare('SELECT google_id,apple_token,created FROM v41_store_bindings WHERE actor=?').get(actor);
  if(row)return {googleAccountId:row.google_id,appleAppAccountToken:row.apple_token,created:row.created};
  for(let i=0;i<4;i++){
   const google=crypto.randomBytes(24).toString('base64url'),apple=crypto.randomUUID(),created=this.now();
   try{this.db.prepare('INSERT INTO v41_store_bindings(actor,google_id,apple_token,created) VALUES(?,?,?,?)').run(actor,google,apple,created);}
   catch(e){if(!String(e.message).includes('UNIQUE'))throw e;}
   row=this.db.prepare('SELECT google_id,apple_token,created FROM v41_store_bindings WHERE actor=?').get(actor);
   if(row)return {googleAccountId:row.google_id,appleAppAccountToken:row.apple_token,created:row.created};
  }
  throw Error('STORE_BINDING_FAILED');
 }
 delete(actor){this.db.prepare('DELETE FROM v41_store_bindings WHERE actor=?').run(actor);}
}
module.exports={StoreBindings};
