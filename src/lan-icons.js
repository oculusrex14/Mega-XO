/* Small embedded offline fallback; used only by the LAN server when the CDN is removed.
   No fonts or third-party network requests are needed to open a local room. */
(()=>{if(window.lucide)return;const paths={
 'grid-3x3':'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/>',
 'bot':'<path d="M12 8V4H8M2 12v6m20-6v6M9 13v2m6-2v2"/><rect x="4" y="8" width="16" height="12" rx="2"/>',
 'users':'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
 'trophy':'<path d="M8 21h8m-4-5v5M7 4H3v3a4 4 0 0 0 4 4m10-7h4v3a4 4 0 0 1-4 4"/><path d="M7 2h10v9a5 5 0 0 1-10 0z"/>',
 'swords':'<path d="m14.5 17.5 3 3L21 17l-3-3m-5.5-1.5L3 3v5l8 8M3 21l3-3m-3-3 6 6M15 3h6v6L9 21"/>',
 'settings-2':'<path d="M3 6h6m4 0h8M3 18h12m4 0h2"/><circle cx="11" cy="6" r="2"/><circle cx="17" cy="18" r="2"/>',
 'sliders-horizontal':'<path d="M21 4h-7m-4 0H3m18 8h-9m-4 0H3m18 8h-5m-4 0H3M14 2v4m-6 4v4m8 4v4"/>',
 'chevron-left':'<path d="m15 18-6-6 6-6"/>','chevron-right':'<path d="m9 18 6-6-6-6"/>','x':'<path d="m18 6-12 12M6 6l12 12"/>',
 'play':'<path d="m6 3 14 9-14 9z"/>','circle-help':'<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3m.1 4h.01"/>',
 'link-2':'<path d="M9 7H7a5 5 0 0 0 0 10h2m6-10h2a5 5 0 0 1 0 10h-2M8 12h8"/>',
 'clipboard-check':'<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2m-7 10 2 2 4-4"/>',
 'route':'<circle cx="6" cy="18" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9a3 3 0 0 1 0 6H6a3 3 0 0 0 0-6h6"/>',
 'chart-no-axes-column-increasing':'<path d="M8 21v-6m5 6V9m5 12V3"/>','coins':'<circle cx="8" cy="8" r="6"/><path d="M18 6a6 6 0 1 1-12 12M8 5v6m-2-2h4"/>',
 'graduation-cap':'<path d="m2 9 10-5 10 5-10 5-10-5zm4 2v6c4 3 8 3 12 0v-6m4-2v7"/>',
 'rotate-ccw':'<path d="M3 11a9 9 0 1 1 2 7M3 3v8h8"/>'};
 window.lucide={createIcons(){document.querySelectorAll('i[data-lucide]').forEach(el=>{const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');for(const attr of el.attributes)svg.setAttribute(attr.name,attr.value);svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('width','24');svg.setAttribute('height','24');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','2');svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');svg.innerHTML=paths[el.dataset.lucide]||paths['grid-3x3'];el.replaceWith(svg);});}};
})();
