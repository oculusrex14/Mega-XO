/* C7/APP-021: voluntary Sponsors destination for the retained app.
 * Guests and members can open it; Mega Pass and Remove Ads users keep automatic ads off but may
 * still browse. The page renders the packaged catalog (an honest empty state until real approved
 * sponsors exist), optional local interests saved only after explicit agreement (same storage
 * contract as the website), a real report-and-hide flow keyed by stable creative identity with
 * durable ticket delivery when the API is reachable, and the fixed Advertise-with-us composer.
 * This is a destination, not an ad wall: provider policy prohibits ad-only screens, so no
 * network inventory is requested here. No fake advertisers, rates or audience statistics. */
(function(){
'use strict';
const APP=window.MegaApp,API=window.MegaAccount;
if(!APP)return;
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const HIDDEN_KEY='mega_sponsor_hidden_v1',INTERESTS_KEY='mega-xoxo-sponsor-interests';
const TOPICS=['Strategy games','Technology','Creative tools','Learning','Gaming gear','Entertainment'];
const SUPPORT_EMAIL='contact@antimatterinnovations.com';
const MAIL_BODY='Hello Mega XOXO team,\n\nI\'d like to discuss a direct sponsorship for Mega XOXO.\n\nBrand or project:\nWebsite:\nProduct or service:\nPreferred dates:\nTarget audience or regions (optional):\nBudget range (optional):\nContact name:\n\nPlease share available placements and the next steps.';
const MAILTO='mailto:'+SUPPORT_EMAIL+'?subject='+encodeURIComponent('Mega XOXO sponsorship enquiry')+'&body='+encodeURIComponent(MAIL_BODY);
let catalog=null,catalogFailed=false,reportBusy=false,lastReport=null;
let catalogLoaded=false;
function readJSON(key){try{return JSON.parse(localStorage.getItem(key)||'null');}catch{return null;}}
function writeJSON(key,value){try{localStorage.setItem(key,JSON.stringify(value));return true;}catch{return false;}}
function hiddenSet(){return new Set((readJSON(HIDDEN_KEY)||[]).slice(-200));}
function rememberHidden(set){try{localStorage.setItem(HIDDEN_KEY,JSON.stringify([...set].slice(-200)));}catch{}}
function interestsState(){const v=readJSON(INTERESTS_KEY);return v&&v.consent===true&&Array.isArray(v.interests)?v.interests.filter(x=>TOPICS.includes(x)):[];}
function creativeKey(s){return s.campaignId+'+'+s.creativeId+'+'+s.revision;}
function validSponsor(s){return s&&typeof s.campaignId==='string'&&typeof s.creativeId==='string'&&Number.isFinite(s.revision)&&typeof s.title==='string'&&typeof s.landingUrl==='string'&&/^https:\/\//.test(s.landingUrl)&&(s.image===undefined||typeof s.image==='string')&&typeof s.advertiser==='string';}
async function loadCatalog(){if(catalogLoaded)return;catalogLoaded=true;try{const res=await fetch('assets/sponsors/catalog.json');if(!res.ok)throw Error('CATALOG_UNAVAILABLE');const data=await res.json();if(!data||!Array.isArray(data.sponsors))throw Error('CATALOG_MALFORMED');catalog=data.sponsors.filter(validSponsor);catalogFailed=false;}catch{catalog=[];catalogFailed=true;}}
function mailBlock(){return '<div class="sponsor-enquiry"><h3>Advertise with us</h3><p>Reach Mega XOXO players with a clearly labeled sponsorship. This opens an email draft; nothing is sent automatically and no account data is attached.</p><a class="button" href="'+MAILTO+'">Open email draft</a><button type="button" class="button quiet" data-sponsor-action="copy-email">Copy email</button><p class="caption">'+SUPPORT_EMAIL+'</p></div>';}
function card(s){
 const hidden=hiddenSet().has(creativeKey(s));
 if(hidden)return '<article class="sponsor-card sponsor-hidden" data-sponsor="'+esc(creativeKey(s))+'"><p class="sponsor-hidden-note">Ad hidden. Thanks for the feedback.</p><button type="button" class="button quiet" data-sponsor-action="unhide" data-sponsor-key="'+esc(creativeKey(s))+'">Undo</button></article>';
 return '<article class="sponsor-card" data-sponsor="'+esc(creativeKey(s))+'">'+
  '<span class="sponsor-label">Sponsored</span>'+
  '<h3>'+esc(s.title)+'</h3>'+
  '<p class="sponsor-advertiser">'+esc(s.advertiser)+'</p>'+
  (s.description?'<p class="sponsor-description">'+esc(s.description)+'</p>':'')+
  '<div class="sponsor-actions"><a class="button quiet" href="'+esc(s.landingUrl)+'" target="_blank" rel="noopener noreferrer sponsored">Visit sponsor</a>'+
  '<button type="button" class="button quiet" data-sponsor-action="report" data-sponsor-key="'+esc(creativeKey(s))+'">Report ad</button></div>'+
  '</article>';
}
function visibleSponsors(){
 const list=catalog||[],saved=interestsState();
 const ranked=list.filter(s=>!hiddenSet().has(creativeKey(s)));
 if(!saved.length)return ranked;
 const matching=ranked.filter(s=>(s.topics||[]).some(t=>saved.includes(t)));
 const rest=ranked.filter(s=>!matching.includes(s));
 return matching.concat(rest);
}
function sponsorsPage(){
 const list=visibleSponsors(),saved=interestsState();
 const cards=list.length?list.map(card).join(''):'<div class="sponsor-empty"><p>No active sponsors right now. When we partner with brands we believe fit, their clearly labeled cards will appear here.</p></div>';
 const catalogNote=catalogFailed?'<p class="caption">The sponsor catalog could not be loaded. Your report and interest choices are still saved on this device.</p>':'';
 return '<div class="sponsor-page">'+
  '<header class="sponsor-head"><button type="button" class="button quiet" data-action="nav" data-value="play">Back to Play</button><p class="sponsor-kicker">SPONSORS</p><h2>Support the game</h2>'+
  '<p>Help support our game so we can keep bringing you new and better experiences. Visiting a sponsor is always optional, never changes gameplay, and does not turn on tracking.</p></header>'+
  '<section class="sponsor-interests"><h3>Choose what interests you <small>(optional)</small></h3><p class="caption">Saved only in this browser or app after you agree. They never enable third-party tracking and never change gameplay.</p>'+
  '<div class="sponsor-topic-grid">'+TOPICS.map(t=>'<label class="sponsor-topic"><input type="checkbox" data-sponsor-topic value="'+t+'" '+(saved.includes(t)?'checked':'')+(saved.length?'':' disabled')+'> '+t+'</label>').join('')+'</div>'+
  '<div class="sponsor-interest-actions">'+(saved.length?'<button type="button" class="button quiet" data-sponsor-action="save-interests">Save choices</button><button type="button" class="button quiet" data-sponsor-action="clear-interests">Clear saved choices</button>':'<label class="sponsor-agree"><input type="checkbox" data-sponsor-agree> I agree to save these optional preferences on this device.</label><button type="button" class="button quiet" data-sponsor-action="save-interests" disabled>Save choices</button>')+'</div></section>'+
  '<section class="sponsor-feed" aria-label="Sponsor cards">'+cards+'</section>'+catalogNote+
  mailBlock()+
  '</div>';
}
function refresh(){if(APP.getContext().page==='sponsors')APP.render();}
async function deliverReport(entry){
 const user=API?.peek?.()?.profile?.id||null;
 try{await API.request('/api/sponsors/report',{reportId:entry.reportId,creativeId:entry.creativeId,campaignId:entry.campaignId,revision:entry.revision,reason:entry.reason,note:entry.note||''});entry.delivered=true;writeJSON('mega_sponsor_report_'+entry.reportId,entry);}
 catch{entry.delivered=false;writeJSON('mega_sponsor_report_'+entry.reportId,entry);}
}
document.addEventListener('click',async e=>{
 const node=e.target.closest('[data-sponsor-action]');if(!node||node.disabled)return;
 const action=node.dataset.sponsorAction;
 if(action==='copy-email'){try{await navigator.clipboard.writeText(SUPPORT_EMAIL);APP.notify('Email address copied.');}catch{APP.notify(SUPPORT_EMAIL);}return;}
 if(action==='save-interests'){
  const agree=document.querySelector('[data-sponsor-agree]');
  const chosen=[...document.querySelectorAll('[data-sponsor-topic]:checked')].map(x=>x.value);
  if(agree&&!agree.checked){APP.notify('Tick the agreement to save your choices on this device.');return;}
  if(!agree&&chosen.length===0){try{localStorage.removeItem(INTERESTS_KEY);}catch{}APP.notify('Saved choices cleared.');refresh();return;}
  if(writeJSON(INTERESTS_KEY,{consent:true,interests:chosen}))APP.notify('Your choices are saved on this device.');else APP.notify('This device could not save your choices.');
  refresh();return;}
 if(action==='clear-interests'){try{localStorage.removeItem(INTERESTS_KEY);}catch{}refresh();return;}
 if(action==='unhide'){const key=node.dataset.sponsorKey;const set=hiddenSet();set.delete(key);rememberHidden(set);refresh();return;}
 if(action==='report'){
  if(reportBusy)return;const key=node.dataset.sponsorKey;const s=(catalog||[]).find(x=>creativeKey(x)===key);if(!s)return;
  reportBusy=true;
  APP.open('Report this ad','<div class="sponsor-report"><p>The ad will be hidden on this device immediately, and a report is sent so it can be reviewed.</p>'+
   '<div class="sponsor-report-reasons">'+['Misleading','Inappropriate','Broken link','Other'].map((r,i)=>'<label class="sponsor-report-reason"><input type="radio" name="sponsorReportReason" value="'+r+'" '+(i===0?'checked':'')+'> '+r+'</label>').join('')+'</div>'+
   '<label class="field">Optional note<input type="text" id="sponsorReportNote" maxlength="280" autocomplete="off"></label>'+
   '<button type="button" class="button" data-sponsor-action="report-confirm" data-sponsor-key="'+esc(key)+'">Report and hide</button>'+
   '<button type="button" class="button quiet" data-sponsor-action="close">Cancel</button></div>','sponsor-report');
  reportBusy=false;return;}
 if(action==='close'){APP.close();return;}
 if(action==='report-confirm'){
  const key=node.dataset.sponsorKey,s=(catalog||[]).find(x=>creativeKey(x)===key);if(!s)return;
  const reason=(document.querySelector('input[name="sponsorReportReason"]:checked')||{}).value||'Other';
  const note=($('#sponsorReportNote')||{}).value||'';
  const prior=readJSON('mega_sponsor_report_'+key);
  const reportId=prior?.reportId||('rep_'+Date.now().toString(36)+Math.random().toString(36).slice(2,8));
  const entry={reportId,creativeId:s.creativeId,campaignId:s.campaignId,revision:s.revision,reason,note};
  const set=hiddenSet();set.add(key);rememberHidden(set);
  writeJSON('mega_sponsor_report_'+key,entry);
  APP.close();refresh();
  APP.notify('Ad hidden on this device.');
  await deliverReport(entry);
  if(entry.delivered!==true)APP.notify('Report couldn\'t be sent. You can retry from the ad\'s card.');
  return;}
},true);
document.addEventListener('change',e=>{const agree=e.target.closest?.('[data-sponsor-agree]');if(!agree)return;const save=document.querySelector('[data-sponsor-action="save-interests"]');if(save)save.disabled=!agree.checked;});
window.MegaSponsors=Object.freeze({sponsorsPage,loadCatalog,version:'1.0.0'});
})();

