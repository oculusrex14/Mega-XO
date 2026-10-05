/* V3.2.3 UI icon adapter.
   Uses the exact Lucide family/names from the supplied V3.1 reference.
   Rank emblems remain Mega XO originals. */
(function(root){
const names={
 board:'grid-3x3',
 bot:'bot',
 users:'users',
 usersRound:'users-round',
 userPlus:'user-plus',
 search:'search',
 copy:'copy',
 trophy:'trophy',
 swords:'swords',
 chart:'chart-no-axes-column-increasing',
 coin:'coins',
 crown:'crown',
 settings:'settings-2',
 sliders:'sliders-horizontal',
 play:'play',
 arrow:'chevron-right',
 back:'chevron-left',
 close:'x',
 help:'circle-help',
 tutorial:'graduation-cap',
 quest:'clipboard-check',
 link:'link-2',
 route:'route',
 globe:'globe-2',
 lock:'lock-keyhole',
 clock:'timer',
 refresh:'rotate-ccw',
 volume:'volume-2',
 check:'check',
 shield:'shield',
 palette:'palette',
 bell:'bell',
 bellRing:'bell-ring'
};
function icon(name,cls=''){
 const n=names[name]||names.board;
 return '<i data-lucide="'+n+'" class="icon '+cls+'" aria-hidden="true"></i>';
}
function refresh(){
 if(root.lucide?.createIcons)root.lucide.createIcons({attrs:{"stroke-width":2}});
}
root.MegaIcons={icon,refresh,badge(t,large=false){
 const i=t.index||0;let outer=i<2?'<rect x="14" y="14" width="36" height="36" rx="10"/>':i<5?'<path d="m32 7 22 11v20L32 57 10 38V18z"/>':i<8?'<path d="m32 4 25 28-25 28L7 32z"/>':'<path d="m32 4 21 12 5 23-26 21L6 39l5-23z"/>';
 const glyphs=[
 '<path d="M23 24h18M21 32h20M23 40h18m-10-18-3 20"/>',
 '<path d="m20 34 6-12 15 3 4 14-16 5-9-10zm6-12 6 13 13 4M20 34l12 1-3 9"/>',
 '<path d="M20 24h24l-5 8H28v7h11v4H24V32l-4-8z"/>',
 '<circle cx="32" cy="30" r="10"/><path d="m25 39-3 8 10-3 10 3-3-8m-13-17 6-5 6 5"/>',
 '<path d="m32 20 10 15-10 9-10-9 10-15zm-9 3-7 8 6 7m19-15 7 8-6 7"/>',
 '<path d="m20 24 7 6 5-12 5 12 7-6-4 19H24l-4-19zm6 13h12"/>',
 '<path d="m24 23 16 0 7 10-15 15-15-15 7-10zm-7 10h30M24 23l8 25 8-25"/>',
 '<path d="m24 19 16 0 7 10-4 15-11 6-11-6-4-15 7-10zm1 6h14l3 6-3 9-7 4-7-4-3-9 3-6z"/>',
 '<path d="m32 21 4 8 9 2-7 6 1 9-7-4-7 4 1-9-7-6 9-2 4-8z"/>',
 '<path d="m32 19 10 13-10 13-10-13 10-13zM15 25l-3 10 8 8m29-18 3 10-8 8M27 13h10"/>',
 '<path d="m18 27 8 5 6-12 6 12 8-5-4 17H22zM25 49h14"/>'
 ];
 const centre=glyphs[i];
 const extras=i>=9?'<path d="M6 20 2 31l5 14m51-25 4 11-5 14"/>':'';
 return '<svg class="rank-badge '+(large?'large':'')+'" viewBox="0 0 64 64" role="img" aria-label="'+t.name+' emblem"><g fill="var(--badge-bg)" stroke="var(--badge-ink)" stroke-width="2" stroke-linejoin="round">'+outer+'</g><g fill="none" stroke="var(--badge-ink)" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">'+centre+extras+'</g>'+(i===10?'<circle cx="32" cy="12" r="3" fill="var(--badge-ink)"/>':'')+'</svg>';
}};
})(globalThis);