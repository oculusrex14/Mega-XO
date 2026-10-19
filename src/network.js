/* Same-origin API adapter. Account client supplies CSRF/session support; the
 * fallback keeps standalone/local builds and older integration fixtures working. */
(function(root){
'use strict';
const base='/api/v1';
// Retained native practice saves/settings use country names; the authoritative API uses ISO codes.
const countryCode=value=>({India:'IN',Australia:'AU','United States':'US','United Kingdom':'GB'}[value]||(/^[A-Z]{2}$/.test(value)?value:''));
const newId=()=>globalThis.crypto?.randomUUID?.()||Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');
async function request(path,body,key){
 // Legacy competitive routes are /api/v1/*; current Core monetization routes are
 // /api/monetization/*. A leading /api/ always denotes an internally-defined,
 // same-origin absolute API path, never a user-provided URL.
 const route=path.startsWith('/api/')?path:base+path;
 if(root.MegaAccount)return root.MegaAccount.request(route,body,key);
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
 try{const response=await fetch(route,{method:body===undefined?'GET':'POST',credentials:'same-origin',signal:controller.signal,headers:body===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':key||newId()},body:body===undefined?undefined:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw Error(result.error||'ONLINE_UNAVAILABLE');return result;}
 catch(e){throw Error(e.message&&/^[A-Z_]+$/.test(e.message)?e.message:'ONLINE_UNAVAILABLE');}finally{clearTimeout(timer);}
}
root.MegaNetwork=Object.freeze({
 profile:()=>request('/profile'),purchase:(evidence,key)=>request('/purchase',{evidence},key),leaderboard:options=>request('/leaderboard?'+new URLSearchParams({...options,region:options?.scope==='local'||options?.scope==='region'?countryCode(options.region):''})),invitations:()=>request('/invitations'),match:id=>request('/match/'+encodeURIComponent(id)),move:(id,revision,move,key)=>request('/move',{id,revision,move},key),resign:(id,key)=>request('/resign',{id},key),cancel:(id,key)=>request('/cancel',{id},key),offer:(opponent,terms,key)=>request('/offer',{id:newId(),opponent,terms},key),accept:(id,termsHash,key)=>request('/accept',{id,termsHash},key),decline:(id,key)=>request('/decline',{id},key),convert:(from,amount,key)=>request('/convert',{from,amount},key),queue:(mode,key)=>request('/queue',{mode},key),queueStatus:()=>request('/queue'),cancelQueue:key=>request('/cancel-queue',{},key),quest:(quest,key)=>request('/quest',{quest},key),friend:name=>request('/friend',{target:name}),acceptFriend:(from,key)=>request('/accept-friend',{from},key),preferences:(changes,key)=>request('/preferences',{changes:Object.hasOwn(changes,'region')?{...changes,region:countryCode(changes.region)}:changes},key),cosmetic:(name,key)=>request('/cosmetic',{name},key),powersSpend:(kind,key)=>request('/api/monetization/powers/spend',{itemId:kind},key)
});
})(globalThis);
