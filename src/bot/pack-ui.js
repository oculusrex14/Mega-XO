/* Optional static-data manager. Empty reviewed catalog means no playable Impossible claim. */
(function(root){
'use strict';
const P=root.MegaBotPack;
let defaultCatalog=null;
function create({host=()=>root.MegaApp,catalog=null,store=null,baseURL=root.location?.href}={}){
 let panel=null,info=null,consent=false;
 const appSession=host()?.getLocalSession?.();
 if(store&&appSession)appSession.store=store;
 if(catalog&&appSession)appSession.setCatalog(catalog);
 const resolvedCatalog=catalog||appSession?.getCatalog?.()||defaultCatalog||root.MegaLocalSession?.getTrustedCatalog?.()||P.APPROVED_CATALOG;
 const supported=()=>['https:','http:'].includes(new URL(baseURL).protocol)&&new URL(baseURL).hostname!=='appassets.androidplatform.net';
 const manager=store||appSession?.getStore?.()||new P.Store({baseURL,catalog:resolvedCatalog,onState:update});
 if(store||appSession)manager.onState=update;
 const mb=n=>(n/1024/1024).toFixed(2)+' MiB';
 function active(){return panel?.isConnected&&host()?.getContext().sheetKind==='ai-pack';}
 function message(code){return ({PACK_HASH_MISMATCH:'The model checksum does not match. Remove it and download again.',PACK_SIZE_MISMATCH:'The download has an unexpected size. Retry the complete download.',PACK_STORAGE_UNSUPPORTED:'This browser cannot retain the optional pack. Your normal offline bots are unchanged.',PACK_DOWNLOAD_CANCELLED:'Download paused. Retry starts a fresh verified download.',PACK_BUSY:'A cache operation is finishing. Try again.',PACK_CONSENT_REQUIRED:'Please confirm this optional download first.'})[code]||'The pack is unavailable. Check storage or connectivity, then retry.';}
 function update(state=manager.state){if(!active())return;const status=panel.querySelector('[data-pack-status]'),progress=panel.querySelector('progress'),details=panel.querySelector('[data-pack-progress]');
  const names={unavailable:'Not downloaded',downloading:'Downloading model data',paused:'Download paused',ready:'Model data verified and cached',corrupt:'Model data is corrupt'};
  status.textContent=state.error?message(state.error):names[state.status]||'Not available';
  if(progress){progress.max=state.totalBytes||info?.bytes||1;progress.value=state.receivedBytes||0;progress.hidden=state.status!=='downloading';details.textContent=state.status==='downloading'?mb(state.receivedBytes||0)+' / '+mb(state.totalBytes||info.bytes):'';}
  const busy=state.status==='downloading';panel.querySelector('[data-pack-action="download"]')?.toggleAttribute('disabled',!consent||!supported()||busy||manager.removing);
  panel.querySelector('[data-pack-action="pause"]')?.toggleAttribute('disabled',!busy);
  panel.querySelector('[data-pack-action="remove"]')?.toggleAttribute('disabled',manager.removing||!['ready','corrupt','paused'].includes(state.status));
  panel.querySelector('[data-pack-action="start"]')?.toggleAttribute('disabled',state.status!=='ready');
 }
 async function launch(){if(!active()||manager.state.status!=='ready'||!info)return;const api=host();if(!api)return;api.close();try{await api.startImpossible?.(info);}catch(e){api.notify?.(e?.message||'Impossible launch failed.');}}
 async function action(kind){if(!active()||!info)return;try{if(kind==='download')await manager.download(info,{consent});else if(kind==='pause')manager.pause();else if(kind==='remove')await manager.remove(info);else if(kind==='start')await launch();}catch(e){if(active()){panel.querySelector('[data-pack-status]').textContent=message(e.code);host().notify(message(e.code));}}finally{update();}}
 function show(){const api=host();if(!api)return;consent=false;info=null;const latest=resolvedCatalog.filter(x=>x.deploymentStatus==='APPROVED'||x.deploymentStatus==='RESEARCH').at(-1);
  api.open('Impossible AI pack','<section class="ai-pack-panel" id="aiPackPanel" aria-label="Optional on-device AI pack"></section>','ai-pack');panel=document.getElementById('aiPackPanel');
  const paragraph=text=>{const p=document.createElement('p');p.textContent=text;panel.append(p);return p;};
  paragraph('Optional on-device AI. No per-move cloud requests, Coins, Crowns, Elo or official leaderboard rewards. The five existing offline bots are unchanged.');
  const status=paragraph('');status.dataset.packStatus='';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  if(!latest){status.textContent='No approved Impossible model is available yet.';paragraph('Training, strength and device validation must pass before a model becomes playable. Nothing is downloaded when you open this screen.');return;}
  try{info=P.manifest(latest,baseURL);}catch{status.textContent='The published pack metadata is incompatible with this app.';return;}
  paragraph('Model '+info.version+': '+mb(info.gzipBytes)+' compressed; '+mb(info.bytes)+' stored. Runtime code and browser memory are additional and are not included in this model size.');
  const fingerprint=paragraph('Model identifier: '+info.sha256.slice(0,12));fingerprint.className='caption';
  if(!supported())paragraph('Optional downloads are not enabled in this native build. Its existing offline permissions remain unchanged.');
  const label=document.createElement('label');label.className='ai-pack-consent';const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.id='aiPackConsent';checkbox.disabled=!supported();label.append(checkbox,document.createTextNode('I agree to download this optional model, including on mobile data.'));panel.append(label);checkbox.addEventListener('change',()=>{consent=checkbox.checked;update();});
  const progress=document.createElement('progress');progress.setAttribute('aria-label','Optional model download');progress.hidden=true;const details=document.createElement('p');details.dataset.packProgress='';details.className='caption';panel.append(progress,details);
  const buttons=document.createElement('div');buttons.className='ai-pack-controls';for(const [text,kind] of [['Download / retry','download'],['Pause download','pause'],['Remove pack','remove'],['Play Impossible match','start']]){const b=document.createElement('button');b.type='button';b.className='button quiet';b.dataset.packAction=kind;b.textContent=text;b.addEventListener('click',()=>action(kind));buttons.append(b);}panel.append(buttons);
  paragraph('Retry restarts the download; partial bytes are never treated as a valid model. Removal affects cached model data, not your saved human moves.');
  paragraph('Playable Impossible also requires the approved inference runtime and game integration. A verified file alone does not enable the mode.');
  update();manager.read(info).catch(e=>{if(active()){status.textContent=message(e.code);update();}});
 }
 return Object.freeze({show,getState:()=>({...manager.state}),pause:()=>manager.pause()});
}
let defaultUI=null;root.MegaAiPack=Object.freeze({create,setTrustedCatalog:c=>{defaultCatalog=c;defaultUI=null;},show:opts=>{if(opts?.catalog||opts?.store||defaultCatalog)defaultUI=create(opts||{});else defaultUI=defaultUI||create();defaultUI.show();}});
})(globalThis);
