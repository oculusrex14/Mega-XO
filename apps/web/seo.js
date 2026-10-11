import {routes, faqEntries} from './pages.js';
import {escapeHtml} from './ui.js';

export const SITE_ORIGIN = 'https://megaxo.online';
const seoAliases = {'/help':'/support', '/ads':'/sponsors', ...Object.fromEntries(['privacy','terms','support','delete-account','privacy-choices'].map(name=>['/legal/'+name,'/'+name]))};
const seoPrivatePaths = new Set(['/game','/play','/legacy-game','/account','/profile','/friends','/settings','/challenge','/offline','/status','/404']);
const seoKnownPaths = new Set(['/', '/game', ...routes.map(route=>route.path)]);
const seoDescriptionSuffix = ' Explore Mega XOXO by Antimatter Innovations.';

export function metadataFor(path) {
  const clean = typeof path==='string' ? path.split(/[?#]/)[0].replace(/\/+$/,'')||'/' : '/404';
  const recognized = seoKnownPaths.has(clean) ? clean : '/404';
  const canonicalPath = seoAliases[recognized] || recognized;
  const route = routes.find(item=>item.path===canonicalPath);
  const description = canonicalPath==='/' ? 'Play Mega XOXO, the Ultimate Tic-tac-toe strategy game. Win the small boards to win the big one. Learn the rules, explore ranks and play in your browser.' : canonicalPath==='/game' ? 'Play Mega XOXO against Bot or a friend in your browser, with nine small boards, one bigger game and the default Neon appearance.' : (route?.description || 'Find your next move from the Mega XOXO homepage and game guide.') + seoDescriptionSuffix;
  return {
    path: recognized,
    title: canonicalPath==='/' ? 'Mega XOXO — Ultimate Tic-tac-toe. Think bigger.' : `${canonicalPath==='/game'?'Play in Browser':route?.title||'Page not found'} — Mega XOXO`,
    description,
    canonical: SITE_ORIGIN+(canonicalPath==='/'?'/':canonicalPath),
    indexable: !seoPrivatePaths.has(canonicalPath),
    robots: seoPrivatePaths.has(canonicalPath)?'noindex, follow':'index, follow, max-image-preview:large',
    image: SITE_ORIGIN+'/assets/art/hero-wide.webp',
  };
}

export const publicRoutes = ['/',...routes.map(route=>route.path)].filter(path=>metadataFor(path).indexable&&!seoAliases[path]);

export function structuredDataFor(path) {
  const meta = metadataFor(path), canonicalPath = new URL(meta.canonical).pathname;
  const publisher = {'@type':'Organization','@id':SITE_ORIGIN+'/#publisher',name:'Antimatter Innovations',url:SITE_ORIGIN+'/about'};
  const website = {'@type':'WebSite','@id':SITE_ORIGIN+'/#website',name:'Mega XOXO',url:SITE_ORIGIN+'/',publisher:{'@id':publisher['@id']},inLanguage:'en'};
  const page = {'@type':'WebPage','@id':meta.canonical+'#webpage',url:meta.canonical,name:meta.title,description:meta.description,isPartOf:{'@id':website['@id']},inLanguage:'en'};
  const graph = [publisher,website,page];
  if (canonicalPath!=='/') graph.push({'@type':'BreadcrumbList',itemListElement:[{'@type':'ListItem',position:1,name:'Mega XOXO',item:SITE_ORIGIN+'/'},{'@type':'ListItem',position:2,name:meta.title.replace(' — Mega XOXO',''),item:meta.canonical}]});
  if (['/','/about','/how-to-play'].includes(canonicalPath)) graph.push({'@type':'VideoGame','@id':SITE_ORIGIN+'/#game',name:'Mega XOXO',url:SITE_ORIGIN+'/',description:'An Ultimate Tic-tac-toe strategy game. Win three small boards in a row to win the big one. Each move sends the next player to the corresponding small board.',genre:'Strategy',gamePlatform:'Web browser',publisher:{'@id':publisher['@id']},image:meta.image});
  if (canonicalPath==='/faq') graph.push({'@type':'FAQPage','@id':meta.canonical+'#faq',url:meta.canonical,mainEntity:faqEntries.map(({question,answer})=>({'@type':'Question',name:question,acceptedAnswer:{'@type':'Answer',text:answer}}))});
  return {'@context':'https://schema.org','@graph':graph};
}

export function seoHead(path) {
  const meta=metadataFor(path), safe=escapeHtml;
  const tags=[`<title>${safe(meta.title)}</title>`,`<meta name="description" content="${safe(meta.description)}">`,`<meta name="robots" content="${safe(meta.robots)}">`,`<link rel="canonical" href="${safe(meta.canonical)}">`];
  for (const [key,value] of Object.entries({'og:type':'website','og:site_name':'Mega XOXO','og:title':meta.title,'og:description':meta.description,'og:url':meta.canonical,'og:image':meta.image,'og:image:alt':'Mega XOXO neon mountain landscape'})) tags.push(`<meta property="${key}" content="${safe(value)}">`);
  for (const [key,value] of Object.entries({'twitter:card':'summary_large_image','twitter:title':meta.title,'twitter:description':meta.description,'twitter:image':meta.image,'twitter:image:alt':'Mega XOXO neon mountain landscape'})) tags.push(`<meta name="${key}" content="${safe(value)}">`);
  tags.push(`<script id="mx-structured-data" type="application/ld+json">${JSON.stringify(structuredDataFor(path)).replaceAll('<','\\u003c')}</script>`);
  return tags.join('\n  ');
}

export function robotsTxt() {
  return 'User-agent: *\nAllow: /\n'+['/game','/play','/legacy-game','/api/','/pages/','/account','/profile','/friends','/settings','/challenge','/offline','/status','/404'].map(path=>'Disallow: '+path+'\n').join('')+'\nSitemap: '+SITE_ORIGIN+'/sitemap.xml\n';
}

export function sitemapXml() {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'+publicRoutes.map(path=>`  <url><loc>${escapeHtml(metadataFor(path).canonical)}</loc></url>`).join('\n')+'\n</urlset>\n';
}

/** Update the same metadata used by the static renderer after SPA navigation. */
export function updateSeo(path, document=globalThis.document) {
  if (!document) return;
  const meta=metadataFor(path); document.title=meta.title;
  const description=document.querySelector('meta[name="description"]'); if(description)description.content=meta.description;
  if (!document.head || !document.createElement) return;
  const ensure=(selector,tag,attributes)=>{
    let element=document.querySelector(selector);
    if(!element){element=document.createElement(tag);document.head.append(element);}
    for(const [name,value] of Object.entries(attributes))element.setAttribute(name,value);
  };
  ensure('meta[name="robots"]','meta',{name:'robots',content:meta.robots});
  ensure('link[rel="canonical"]','link',{rel:'canonical',href:meta.canonical});
  for(const [key,value] of Object.entries({'og:type':'website','og:site_name':'Mega XOXO','og:title':meta.title,'og:description':meta.description,'og:url':meta.canonical,'og:image':meta.image,'og:image:alt':'Mega XOXO neon mountain landscape'}))ensure(`meta[property="${key}"]`,'meta',{property:key,content:value});
  for(const [key,value] of Object.entries({'twitter:card':'summary_large_image','twitter:title':meta.title,'twitter:description':meta.description,'twitter:image':meta.image,'twitter:image:alt':'Mega XOXO neon mountain landscape'}))ensure(`meta[name="${key}"]`,'meta',{name:key,content:value});
  ensure('#mx-structured-data','script',{id:'mx-structured-data',type:'application/ld+json'});
  document.querySelector('#mx-structured-data').textContent=JSON.stringify(structuredDataFor(path));
}
