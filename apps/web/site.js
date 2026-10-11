import {icon, button, escapeHtml, rankEmblem} from './ui.js';
import {renderPreview} from './board.js';

const siteNavigation=[['/','Play'],['/ranked','Ranked'],['/tournaments','Tournaments'],['/rewards','Rewards'],['/themes','Themes'],['/leaderboard','Leaderboard'],['/store','Store']];
const siteTierIds=['wood','stone','iron','bronze','silver','gold','diamond','emerald','champion','master','grandmaster'];
const siteBalance=value=>Number.isSafeInteger(value)&&value>=0?value.toLocaleString('en-US'):'—';

export function renderHeader(path,context={}) {
 const wallet=context.profile?.wallet;
 const coins=siteBalance(wallet?.coins),crowns=siteBalance(wallet?.crowns);
 return `<a class="mx-brand" href="/" aria-label="Mega XOXO home"><img src="/assets/art/header.webp" width="236" height="70" alt="Mega XOXO" fetchpriority="high"></a><nav class="mx-desktop-nav" aria-label="Main navigation">${siteNavigation.map(([href,label])=>`<a href="${href}" ${href===path?'aria-current="page"':''}>${label}</a>`).join('')}</nav><div class="mx-wallet"><a href="/store" class="mx-wallet-pill" aria-label="Coins ${coins}${wallet?'':' — sign in to see your balance'}">${icon('coin','mx-coin')}<b>${coins}</b>${icon('plus')}</a><a href="/store" class="mx-wallet-pill" aria-label="Crowns ${crowns}${wallet?'':' — sign in to see your balance'}">${icon('crown','mx-crown')}<b>${crowns}</b>${icon('plus')}</a><a class="mx-avatar" href="/account" aria-label="Your account">${icon('user')}</a><button class="mx-menu-button" aria-expanded="false" aria-controls="mobile-menu" aria-label="Open navigation">${icon('menu')}</button></div><nav id="mobile-menu" class="mx-mobile-nav" aria-label="Mobile navigation" hidden>${siteNavigation.map(([href,label])=>`<a href="${href}" ${href===path?'aria-current="page"':''}>${label}</a>`).join('')}<a href="/sponsors">Sponsors</a><a href="/friends">Friends</a><a href="/settings">Settings</a><a href="/support">Support</a></nav>`;
}

function sitePlatformStrip(){return `<div class="mx-platform-strip"><span class="mx-platform-icons">${icon('monitor')}${icon('apple')}${icon('android')}</span><span>Play on Browser, iOS, Android</span><span class="mx-platform-divider"></span><span>Same account. Anywhere.</span></div>`;}
function siteMiniTheme(mark='X') {return `<div class="mx-art-board ${mark==='O'?'pink':''}" aria-hidden="true">${Array.from({length:9},(_,i)=>`<span>${[0,4,8].includes(i)?mark:''}</span>`).join('')}</div>`;}
function siteDeviceArt(){return `<img class="mx-device-art mx-device-image" src="/assets/art/devices.webp" width="245" height="162" alt="" aria-hidden="true">`;}
function siteFeatures(){return `<section class="mx-features" aria-label="A bigger way to play"><a class="mx-feature trophy-feature" href="/ranked"><img class="mx-trophy-art" src="/assets/art/trophy.webp" width="220" height="240" alt="" loading="eager"><div class="mx-feature-copy"><h2>Ranked Matches</h2><p>Climb the ranks, prove your skill,<br>and compete in seasonal ladders.</p><div class="mx-season-chip"><span class="mx-status-dot"></span><div><b>Every move matters</b><small>Explore the Ranked leagues</small></div></div></div><span class="mx-feature-arrow">${icon('chevron-right')}</span></a><a class="mx-feature devices-feature" href="/about"><div class="mx-feature-icon">${icon('cloud')}</div><div class="mx-feature-copy"><h2>Cross-Platform Progress</h2><p>Play on web, iOS, and Android.<br>Your stats, rank, and rewards<br>sync with your linked account.</p></div>${siteDeviceArt()}</a><a class="mx-feature themes-feature" href="/themes"><div class="mx-feature-icon">${icon('palette')}</div><div class="mx-feature-copy"><h2>Themes &amp; Rewards</h2><p>Explore five themes, earn rewards,<br>and make every move your own.</p><div class="mx-reward-icons"><span>${icon('coin','mx-coin')}</span><span>${rankEmblem()}</span><span>${icon('crown','mx-crown')}</span><span>${icon('star')}</span></div></div><div class="mx-themes-art">${siteMiniTheme('X')}${siteMiniTheme('O')}</div><span class="mx-feature-arrow">${icon('chevron-right')}</span></a></section>`;}

export function renderRankPanel(context={},tab='ranked') {
 tab=['ranked','casual','friends'].includes(tab)?tab:'ranked';
 return `<aside class="mx-ranked mx-panel" aria-label="Online play"><div class="mx-mode-tabs" role="tablist" aria-label="Online mode">${['ranked','casual','friends'].map(mode=>`<button role="tab" id="tab-${mode}" aria-selected="${tab===mode}" aria-controls="mode-panel" tabindex="${tab===mode?0:-1}" data-mode="${mode}">${mode[0].toUpperCase()+mode.slice(1)}</button>`).join('')}</div><div id="mode-panel" role="tabpanel" aria-labelledby="tab-${tab}">${siteRankPanelContent(context,tab)}</div></aside>`;
}

function siteRankPanelContent(context,tab) {
 if(tab==='ranked'){
  const profile=context.sessionStatus==='linked'?context.profile:null;
  const tier=typeof profile?.tier==='string'&&siteTierIds.includes(profile.tier.toLowerCase())?profile.tier.toLowerCase():null;
  const name=tier?tier[0].toUpperCase()+tier.slice(1):'Your rank is unpublished';
  const art=profile?(tier?`<img class="mx-rank-art" src="/assets/art/ranks/${tier}.webp" width="171" height="154" alt="${escapeHtml(name)} league">`:icon('shield','mx-rank-art')):'<img class="mx-rank-art" src="/assets/art/ranks/diamond.webp" width="171" height="154" alt="Decorative crystal league emblem">';
  const rating=typeof profile?.rating==='number'&&Number.isFinite(profile.rating)?profile.rating.toLocaleString('en-US',{maximumFractionDigits:2}):'—';
  return `<div class="mx-rank-badge" data-rank-tier="${tier||''}">${art}</div><h2>${profile?name:'Climb the ranks'} <a href="/ranked" aria-label="Learn about Ranked">${icon('info')}</a></h2><p class="mx-rank-rating">${profile?`${rating} Rating`:'Your journey starts here'}</p><div class="mx-rank-track" aria-hidden="true"><span></span></div><p class="mx-rank-hint">${profile?(profile.season?.qualified?'Season qualified':'Complete your season qualification'):'Sign in to see your rating'}</p><a class="mx-season-card" href="/season">${icon('trophy')}<span><b>Quarterly seasons</b><small>New rivals. Bigger ambitions.</small></span><span class="mx-chip">Explore</span></a>${button(profile?'Find Ranked Match':'Sign in to play online',profile?'/game?online=ranked':'/account','blue','swords')}`;
 }
 if(tab==='casual')return `<div class="mx-rank-badge">${icon('globe')}</div><h2>Play your way</h2><p class="mx-rank-rating">All the strategy. No Elo at stake.</p><p class="mx-tab-description">Warm up in offline practice, or sign in for a Casual match.</p>${button('Start practice','/play?mode=practice','blue','arrow-right')}${button('Play Casual online','/game/','secondary','globe')}`;
 return `<div class="mx-rank-badge">${icon('people')}</div><h2>Better with a rival</h2><p class="mx-rank-rating">One friend. Nine boards.</p><p class="mx-tab-description">Link your account to find friends and send a direct challenge.</p>${button('Find your friends','/friends','blue','people')}${button('Try local practice','/play?mode=practice','secondary','swords')}`;
}

export function renderHome(context={},tab='ranked') {
 const download=button('Download Now','/api/download','secondary','download').replace('<a ','<a data-download-link ');
 return `<div class="mx-home"><section class="mx-hero" aria-labelledby="hero-title"><div class="mx-hero-copy"><p class="mx-eyebrow">BIGGER MOVES. BRIGHTER MINDS.</p><h1 id="hero-title">The Ultimate<br>Tic-tac-toe.<br><span class="mx-accent">Think bigger.</span></h1><p class="mx-hero-description">Win the small boards to win the big one.<br> Every move also decides where your opponent plays next.</p><div class="mx-hero-actions">${button('Play Now','/game','primary','chevron-right')}${download}</div>${sitePlatformStrip()}</div><div class="mx-preview" data-board-host>${renderPreview()}</div>${renderRankPanel(context,tab)}</section>${siteFeatures()}</div>`;
}

export function renderFooter() {
 return `<div class="mx-footer-brand"><img src="/assets/art/mark.webp" width="40" height="40" alt=""><span>Mega XOXO <small>by Antimatter Innovations</small></span></div><nav aria-label="Footer navigation"><a href="/how-to-play">How to play</a><a href="/download">Download</a><a href="/friends">Friends</a><a href="/store">Store</a><a href="/sponsors">Sponsors</a><a href="/about">About</a><a href="/faq">FAQ</a><a href="/press">Media kit</a><a href="/support">Support</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/settings">Settings</a></nav><span class="mx-footer-note">Nine small boards. One bigger game.</span>`;
}
