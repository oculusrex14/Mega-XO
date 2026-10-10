import {icon, button, escapeHtml, rankEmblem} from './ui.js';
import {routes, renderPage} from './pages.js';
import {renderPreview, renderPractice, mountBoard} from './board.js';

const navigation=[['/','Play'],['/ranked','Ranked'],['/tournaments','Tournaments'],['/rewards','Rewards'],['/themes','Themes'],['/leaderboard','Leaderboard']];
let board=null;
let tab='ranked';
let toastTimer;
const main=document.querySelector('#main');
const context={profile:null, connection:'guest'};
function header(path) {
 document.querySelector('#header').innerHTML=`<a class="mx-brand" href="/" aria-label="Mega XOXO home"><img src="/assets/art/header.webp" width="236" height="70" alt="Mega XOXO" fetchpriority="high"></a><nav class="mx-desktop-nav" aria-label="Main navigation">${navigation.map(([href,label])=>`<a href="${href}" ${href===path?'aria-current="page"':''}>${label}</a>`).join('')}</nav><div class="mx-wallet"><a href="/rewards" class="mx-wallet-pill" aria-label="Coins — sign in to see your balance">${icon('coin','mx-coin')}<b>—</b>${icon('plus')}</a><a href="/rewards" class="mx-wallet-pill" aria-label="Crowns — sign in to see your balance">${icon('crown','mx-crown')}<b>—</b>${icon('plus')}</a><a class="mx-avatar" href="/account" aria-label="Your account">${icon('user')}</a><button class="mx-menu-button" aria-expanded="false" aria-controls="mobile-menu" aria-label="Open navigation">${icon('menu')}</button></div><nav id="mobile-menu" class="mx-mobile-nav" aria-label="Mobile navigation" hidden>${navigation.map(([href,label])=>`<a href="${href}" ${href===path?'aria-current="page"':''}>${label}</a>`).join('')}<a href="/friends">Friends</a><a href="/settings">Settings</a><a href="/support">Support</a></nav>`;
}
function platformStrip(){return `<div class="mx-platform-strip"><span class="mx-platform-icons">${icon('monitor')}${icon('apple')}${icon('android')}</span><span>Play on Browser, iOS, Android</span><span class="mx-platform-divider"></span><span>Same account. Anywhere.</span></div>`;}
function miniTheme(mark='X') {return `<div class="mx-art-board ${mark==='O'?'pink':''}" aria-hidden="true">${Array.from({length:9},(_,i)=>`<span>${[0,4,8].includes(i)?mark:''}</span>`).join('')}</div>`;}
function deviceArt(){return `<img class="mx-device-art mx-device-image" src="/assets/art/devices.webp" width="245" height="162" alt="" aria-hidden="true">`;}
function features(){return `<section class="mx-features" aria-label="A bigger way to play"><a class="mx-feature trophy-feature" href="/ranked"><img class="mx-trophy-art" src="/assets/art/trophy.webp" width="220" height="240" alt="" loading="eager"><div class="mx-feature-copy"><h2>Ranked Matches</h2><p>Climb the ranks, prove your skill,<br>and compete in seasonal ladders.</p><div class="mx-season-chip"><span class="mx-status-dot"></span><div><b>Every move matters</b><small>Explore the Ranked leagues</small></div></div></div><span class="mx-feature-arrow">${icon('chevron-right')}</span></a><a class="mx-feature devices-feature" href="/about"><div class="mx-feature-icon">${icon('cloud')}</div><div class="mx-feature-copy"><h2>Cross-Platform Progress</h2><p>Play on web, iOS, and Android.<br>Your stats, rank, and rewards<br>sync with your linked account.</p></div>${deviceArt()}</a><a class="mx-feature themes-feature" href="/themes"><div class="mx-feature-icon">${icon('palette')}</div><div class="mx-feature-copy"><h2>Themes &amp; Rewards</h2><p>Explore four themes, earn rewards,<br>and make every move your own.</p><div class="mx-reward-icons"><span>${icon('coin','mx-coin')}</span><span>${rankEmblem()}</span><span>${icon('crown','mx-crown')}</span><span>${icon('star')}</span></div></div><div class="mx-themes-art">${miniTheme('X')}${miniTheme('O')}</div><span class="mx-feature-arrow">${icon('chevron-right')}</span></a></section>`;}
function rankPanel(){return `<aside class="mx-ranked mx-panel" aria-label="Online play"><div class="mx-mode-tabs" role="tablist" aria-label="Online mode">${['ranked','casual','friends'].map(mode=>`<button role="tab" id="tab-${mode}" aria-selected="${tab===mode}" aria-controls="mode-panel" tabindex="${tab===mode?0:-1}" data-mode="${mode}">${mode[0].toUpperCase()+mode.slice(1)}</button>`).join('')}</div><div id="mode-panel" role="tabpanel" aria-labelledby="tab-${tab}">${rankPanelContent()}</div></aside>`;}
function rankPanelContent(){if(tab==='ranked')return `<div class="mx-rank-badge"><img class="mx-rank-art" src="/assets/art/crystal.webp" width="171" height="154" alt="Decorative crystal league emblem"></div><h2>Climb the ranks <a href="/ranked" aria-label="Learn about Ranked">${icon('info')}</a></h2><p class="mx-rank-rating">Your journey starts here</p><div class="mx-rank-track" aria-hidden="true"><span></span></div><p class="mx-rank-hint">Sign in to see your rating</p><a class="mx-season-card" href="/season">${icon('trophy')}<span><b>Quarterly seasons</b><small>New rivals. Bigger ambitions.</small></span><span class="mx-chip">Explore</span></a>${button('Sign in to play online','/game/','blue','swords')}`;
 if(tab==='casual')return `<div class="mx-rank-badge">${icon('globe')}</div><h2>Play your way</h2><p class="mx-rank-rating">All the strategy. No Elo at stake.</p><p class="mx-tab-description">Warm up in offline practice, or sign in for a Casual match.</p>${button('Start practice','/play?mode=practice','blue','arrow-right')}${button('Play Casual online','/game/','secondary','globe')}`;
 return `<div class="mx-rank-badge">${icon('people')}</div><h2>Better with a rival</h2><p class="mx-rank-rating">One friend. Nine boards.</p><p class="mx-tab-description">Link your account to find friends and send a direct challenge.</p>${button('Find your friends','/friends','blue','people')}${button('Try local practice','/play?mode=practice','secondary','swords')}`;}
function home(){return `<div class="mx-home"><section class="mx-hero" aria-labelledby="hero-title"><div class="mx-hero-copy"><p class="mx-eyebrow">BIGGER MOVES. BRIGHTER MINDS.</p><h1 id="hero-title">The Ultimate<br>Tic-tac-toe.<br><span class="mx-accent">Think bigger.</span></h1><p class="mx-hero-description">Win the small boards to win the big one.<br> Every move also decides where your opponent plays next.</p><div class="mx-hero-actions">${button('Play Now','/play?mode=practice','primary','chevron-right')}${button('Play in Browser','/game/','secondary','globe')}</div>${platformStrip()}</div><div class="mx-preview" data-board-host>${renderPreview()}</div>${rankPanel()}</section>${features()}</div>`;}
function footer(){document.querySelector('#footer').innerHTML=`<div class="mx-footer-brand"><img src="/assets/art/mark.webp" width="40" height="40" alt=""><span>Mega XOXO <small>by Antimatter Innovations</small></span></div><nav aria-label="Footer navigation"><a href="/how-to-play">How to play</a><a href="/friends">Friends</a><a href="/about">About</a><a href="/support">Support</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/settings">Settings</a></nav><span class="mx-footer-note">Nine small boards. One bigger game.</span>`;}
function normalizedPath(){return location.pathname.replace(/\/+$/,'')||'/';}
function render({focus=false}={}){
 board?.destroy();board=null;
 const path=normalizedPath();
 const route=routes.find(item=>item.path===path);
 document.body.dataset.page=path==='/'?'home':'inner';
 header(path);footer();
 main.innerHTML=path==='/'?home():path==='/play'&&new URLSearchParams(location.search).get('mode')==='practice'?renderPractice():renderPage(path,context)||renderPage('/404',context);
 document.title=path==='/'?'Mega XOXO — Think bigger.':`${route?.title||'Page not found'} — Mega XOXO`;
 const desc=document.querySelector('meta[name="description"]');if(desc)desc.content=route?.description||'The Ultimate Tic-tac-toe. Nine small boards. One bigger game.';
 document.querySelectorAll('[data-board-host]').forEach(host=>{board=mountBoard(host,{preview:host.dataset.boardPreview!=='false'&&path==='/'})});
 if(focus){main.focus({preventScroll:true});window.scrollTo(0,0);}
}
function navigate(href){history.pushState({},'',href);render({focus:true});}
function notify(message){const el=document.querySelector('#notification');el.textContent=message;el.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{el.hidden=true},4500);}
document.addEventListener('click',event=>{
 const menu=event.target.closest('.mx-menu-button');if(menu){const nav=document.querySelector('#mobile-menu');nav.hidden=!nav.hidden;menu.setAttribute('aria-expanded',String(!nav.hidden));return;}
 const mode=event.target.closest('[data-mode]');if(mode){tab=mode.dataset.mode;document.querySelector('.mx-ranked').outerHTML=rankPanel();document.querySelector(`#tab-${tab}`).focus();return;}
 const action=event.target.closest('[data-page-action]');if(action){const name=action.dataset.pageAction;
  if(name==='theme-preview'){document.querySelectorAll('[data-page-action="theme-preview"]').forEach(x=>x.setAttribute('aria-pressed',String(x===action)));const label=action.dataset.theme||action.dataset.previewTheme;const preview=document.querySelector('[data-theme-preview]');if(preview)preview.dataset.theme=label;notify('Theme preview selected. Open the game to change your play theme.');}
  if(name==='copy-support-info'){const info=`Mega XOXO website\nPage: ${normalizedPath()}\nBrowser: ${navigator.userAgent}`;navigator.clipboard?.writeText(info).then(()=>notify('Support details copied.')).catch(()=>notify('Copy unavailable. Include the page URL with your support request.'));}
  if(name==='reset-appearance')notify('Website appearance reset. Your game settings stay in the game.');
 }
 const anchor=event.target.closest('a[href]');if(!anchor||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||anchor.target||anchor.hasAttribute('download'))return;
 const url=new URL(anchor.href,location.href);if(url.origin!==location.origin||url.pathname.startsWith('/game')||url.pathname.startsWith('/legal')||url.hash)return;
 event.preventDefault();navigate(url.pathname+url.search);
});
document.addEventListener('keydown',event=>{
 const t=event.target.closest('[data-mode]');if(t&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const modes=['ranked','casual','friends'];const i=modes.indexOf(tab);tab=event.key==='Home'?modes[0]:event.key==='End'?modes[2]:modes[(i+(event.key==='ArrowRight'?1:2))%3];document.querySelector('.mx-ranked').outerHTML=rankPanel();document.querySelector(`#tab-${tab}`).focus();}
 if(event.key==='Escape'){const nav=document.querySelector('#mobile-menu');if(nav&&!nav.hidden){nav.hidden=true;document.querySelector('.mx-menu-button').setAttribute('aria-expanded','false');document.querySelector('.mx-menu-button').focus();}}
});
window.addEventListener('popstate',()=>render({focus:true}));
render();
