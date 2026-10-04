/* Original line icon set: 24px canvas, 1.8px strokes. No runtime CDN dependency. */
(function(root){
const p={
 board:'<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M9 3v18m6-18v18M3 9h18M3 15h18"/>',
 bot:'<rect x="4" y="7" width="16" height="14" rx="4"/><path d="M12 3v4m-4 6h.01M16 13h.01M9 17h6M1 12v5m22-5v5"/>',
 users:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-17a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5v2"/>',
 trophy:'<path d="M7 3h10v7a5 5 0 0 1-10 0V3zm5 12v6m-4 0h8M7 5H3v3a4 4 0 0 0 4 4m10-7h4v3a4 4 0 0 1-4 4"/>',
 chart:'<path d="M4 3v17h17M8 16v-4m5 4V7m5 9V4"/>',
 coin:'<circle cx="12" cy="12" r="9"/><path d="m12 7 4 5-4 5-4-5 4-5z"/>',
 crown:'<path d="m3 6 5 4 4-7 4 7 5-4-2 13H5L3 6zm3 10h12"/>',
 settings:'<path d="M4 6h16M4 12h16M4 18h16"/><rect x="7" y="3" width="4" height="6" rx="1"/><rect x="14" y="9" width="4" height="6" rx="1"/><rect x="7" y="15" width="4" height="6" rx="1"/>',
 play:'<path d="m8 4 12 8-12 8V4z"/>',
 arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>',
 back:'<path d="m15 5-7 7 7 7"/>',
 close:'<path d="m6 6 12 12M18 6 6 18"/>',
 help:'<circle cx="12" cy="12" r="9"/><path d="M9.5 8a2.5 2.5 0 1 1 4 2c-1.5 1-1.5 1.5-1.5 3m0 3h.01"/>',
 quest:'<rect x="5" y="5" width="15" height="16" rx="3"/><path d="M9 5V3h7v2M8 12l2 2 3-4m2 3h2M8 18h9"/>',
 link:'<path d="m9 15 6-6m-5-3 2-2a5 5 0 0 1 7 7l-2 2m-3 5-2 2a5 5 0 0 1-7-7l2-2"/>',
 globe:'<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
 lock:'<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
 clock:'<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
 refresh:'<path d="M20 7a9 9 0 1 0 1 8M20 3v5h-5"/>',
 volume:'<path d="m11 4-6 5H2v6h3l6 5V4zm4 4a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
 check:'<path d="m4 12 5 5L20 6"/>',
 shield:'<path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6l9-4zM8 12l3 3 5-6"/>',
 palette:'<path d="M21 12a9 9 0 1 0-9 9h2a2 2 0 0 0 2-2c0-2-2-2-2-4s3-1 5-1a2 2 0 0 0 2-2z"/><path d="M7 8h.01M12 6h.01M17 9h.01M6 13h.01"/>'
};
root.MegaIcons={icon(name,cls=''){return '<svg class="icon '+cls+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+(p[name]||p.board)+'</svg>';},badge(t,large=false){
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
