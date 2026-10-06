'use strict';
const fs=require('node:fs');
const bytes=file=>{try{return fs.statSync(file).size;}catch{return 0;}};
const pragma=(db,name)=>{try{return Number(db.prepare('PRAGMA '+name).get()?.[name]||0);}catch{return 0;}};
function storageSnapshot(db,file,limits={}){
 const pageSize=pragma(db,'page_size'),pageCount=pragma(db,'page_count'),freelistPages=pragma(db,'freelist_count');
 let stateBytes=0,commandRows=0;
 try{stateBytes=Number(db.prepare('SELECT length(CAST(json AS BLOB)) AS n FROM state WHERE id=1').get()?.n||0);}catch{}
 try{commandRows=Number(db.prepare('SELECT count(*) AS n FROM commands').get()?.n||0);}catch{}
 const dbBytes=bytes(file),walBytes=bytes(file+'-wal'),shmBytes=bytes(file+'-shm'),logicalBytes=pageSize*pageCount,freeBytes=pageSize*freelistPages,warnings=[];
 if(limits.dbWarnBytes&&dbBytes>=limits.dbWarnBytes)warnings.push('database_size');
 if(limits.walWarnBytes&&walBytes>=limits.walWarnBytes)warnings.push('wal_size');
 if(limits.stateWarnBytes&&stateBytes>=limits.stateWarnBytes)warnings.push('aggregate_state_size');
 return {dbBytes,walBytes,shmBytes,pageSize,pageCount,freelistPages,logicalBytes,freeBytes,stateBytes,commandRows,warnings};
}
module.exports={storageSnapshot};
