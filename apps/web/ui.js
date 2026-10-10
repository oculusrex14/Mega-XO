export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths = {
  'arrow-right':'M5 12h14m-6-6 6 6-6 6', 'arrow-left':'M19 12H5m6-6-6 6 6 6', 'chevron-right':'m9 5 7 7-7 7',
  trophy:'M8 3h8v7a4 4 0 0 1-8 0V3ZM8 5H4v3a4 4 0 0 0 4 4m8-7h4v3a4 4 0 0 1-4 4m-4 2v5m-4 2h8',
  cloud:'M7 18h11a4 4 0 0 0 0-8h-1A6 6 0 0 0 4 9a4.5 4.5 0 0 0 3 9Z',
  palette:'M12 3a9 9 0 0 0 0 18h1a2 2 0 0 0 2-2c0-1-1-1.5-1-2.5a1.5 1.5 0 0 1 1.5-1.5H18a4 4 0 0 0 3-4c0-4.5-4-8-9-8ZM7 9h.01m4-3h.01m5 2h.01M6 14h.01',
  swords:'m3 3 9 9m-9-9 1 5 12 12m5-17-9 9m9-9-1 5L8 20M5 15l4 4m6-14 4 4m-4 6 4 4M5 5l4 4',
  globe:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z',
  monitor:'M3 4h18v13H3V4Zm9 13v4m-5 0h10',
  apple:'M16 3c-2 0-3 2-3 3 2 0 3-1 3-3ZM12 8c-4-3-8 0-8 4 0 5 3 9 5 9 1 0 2-1 3-1s2 1 3 1c2 0 4-3 5-6-4-1-4-5-1-7-2-2-4-2-7 0Z',
  android:'m7 5-2-3m12 3 2-3M5 10h14v9H5v-9Zm0-2a7 7 0 0 1 14 0H5Zm-3 4v5m20-5v5M8 19v3m8-3v3m-7-16h.01m6 0h.01',
  user:'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2H4Z',
  coin:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-6-4 6h4v6l4-6h-4V6Z',
  crown:'m3 6 5 5 4-7 4 7 5-5-2 14H5L3 6Zm2 10h14',
  shield:'m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6',
  check:'m5 12 4 4L19 6',settings:'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8Zm-2-6h4l1 3 3 1 3-1 2 4-2 3 1 3-3 3-3-1-2 3h-4l-1-3-3-1-3 1-2-4 2-3-1-3 3-3 3 1 2-3Z',
  mail:'M3 5h18v14H3V5Zm0 0 9 7 9-7',help:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-12-3a3 3 0 0 1 6 0c0 2-3 2-3 5m0 3h.01',
  close:'m6 6 12 12M6 18 18 6',star:'m12 3 3 6 6 1-4.5 4.5L18 21l-6-3-6 3 1.5-6.5L3 10l6-1 3-6Z',
  people:'M14 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM3 21v-3a7 7 0 0 1 14 0v3m0-17a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v3',
  search:'M18 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Zm-2 6 5 5',clock:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-5v5l3 2',
  refresh:'M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5m-4 8a8 8 0 0 0 14 3l3-3m0 5v-5h-5',
  info:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-1v6m0-10h.01',download:'M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6',
  menu:'M4 6h16M4 12h16M4 18h16',plus:'M12 5v14M5 12h14'
};
export function icon(name, className='') {return `<svg class="mx-icon ${escapeHtml(className)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.star}"/></svg>`;}
export function button(label, href, kind='primary', iconName='') {return `<a class="mx-button ${escapeHtml(kind)}" href="${escapeHtml(href)}">${iconName?icon(iconName):''}<span>${escapeHtml(label)}</span></a>`;}
export function pageHeading(eyebrow, title, copy) {return `<header class="pg-heading"><p class="mx-eyebrow">${escapeHtml(eyebrow)}</p><h1>${escapeHtml(title)}</h1><p class="mx-muted">${escapeHtml(copy)}</p></header>`;}
export function rankEmblem(color='#53baff') {return `<svg class="mx-rank-art" viewBox="0 0 200 180" role="img" aria-label="Decorative crystal league emblem"><defs><linearGradient id="crystal" x1="0" x2=".7" y2="1"><stop stop-color="#c0f8ff"/><stop offset=".35" stop-color="${color}"/><stop offset=".65" stop-color="#383cfa"/><stop offset="1" stop-color="#b343ff"/></linearGradient><linearGradient id="crystal-dark" x1="0" x2="1" y2="1"><stop stop-color="#0b2660"/><stop offset="1" stop-color="#581ac9"/></linearGradient></defs><g stroke="#75ccff" stroke-width="1.8" stroke-linejoin="round"><path fill="url(#crystal)" d="m100 4 13 26-13 12-13-12L100 4ZM28 34l35 20-9 32-19-15-7-37Zm144 0-35 20 9 32 19-15 7-37ZM38 80l29 19-6 19-16-11-7-27Zm124 0-29 19 6 19 16-11 7-27ZM48 117l25 10 27 40 27-40 25-10-17 33-35 24-35-24-17-33Z"/><path fill="url(#crystal-dark)" d="m100 23 44 39-9 67-35 39-35-39-9-67 44-39Z"/><path fill="url(#crystal)" d="m100 38 31 29-7 54-24 29-24-29-7-54 31-29Z"/><path fill="#122760" d="m100 49 21 22-5 42-16 23-16-23-5-42 21-22Z"/><path fill="url(#crystal)" d="m100 53 21 28-21 50-21-50 21-28Z"/><path fill="#c6ffff" d="m100 53-21 28 21 10V53Z"/><path fill="#91adff" d="m100 53 21 28-21 10V53Z"/><path fill="#4b51f8" d="m79 81 21 50V91L79 81Z"/><path fill="#b966ff" d="m121 81-21 50V91l21-10Z"/></g></svg>`;}
