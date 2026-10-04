/* Invoke from the server worker. No browser can mint weekly rewards or run these jobs. */
'use strict';
const D=require('../src/domain.js');
function maintenance(store,now=Date.now()){
 const principal={actor:'maintenance',scope:'operator'},today=D.day(now);
 store.run(principal,'snapshot:'+today,{type:'snapshot'});
 const authority=store.read();
 const weeks=new Set([...authority.snapshots.keys()].map(date=>D.week(Date.parse(date+'T00:00:00Z'))));
 for(const week of weeks)if(D.weekStart(week)+7*D.DAY<=now)store.run(principal,'weekly:'+week+':'+today,{type:'weekly',week});
 for(const m of authority.matches.values()){
  if(m.status==='OFFERED'&&now>=m.expires)try{store.run(principal,'expire:'+m.id,{type:'expire',id:m.id});}catch{}
  if(m.status==='PLAYING'&&m.deadline!==null&&now>=m.deadline)try{store.run(principal,'timeout:'+m.id+':'+m.revision,{type:'timeout',id:m.id});}catch{}
 }
}
function startMaintenance(store,{intervalMs=15000,onError=console.error}={}){
 const run=()=>{try{maintenance(store);}catch(e){onError(e);}};run();const timer=setInterval(run,intervalMs);timer.unref();return ()=>clearInterval(timer);
}
module.exports={maintenance,startMaintenance};
