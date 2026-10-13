// Build-time rendering only: imports the shared pure views, never the browser
// controller, account transport or production authority.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';

const input=JSON.parse(fs.readFileSync(0,'utf8'));
const moduleAt=name=>import(pathToFileURL(path.join(input.root,'apps/web',name+'.js')).href);
const [site,pages,board,seo]=await Promise.all(['site','pages','board','seo'].map(moduleAt));
globalThis.MegaGame=createRequire(import.meta.url)(path.join(input.root,'src/game.js'));
const context={profile:null,sessionStatus:'loading',storeLinks:input.storeLinks,legalDocuments:Object.fromEntries(Object.entries(input.legalDocuments).map(([name,markup])=>['/'+name,markup]))};
const documents={},metadata={};
for(const route of input.routes){
 const main=route==='/'?site.renderHome(context):route==='/game'?board.renderGame():pages.renderPage(route,context);
 if(typeof main!=='string'||!main.trim())throw Error('P21_PRERENDER_REFUSED: missing view '+route);
 const html=input.template.replace('<!--SEO_HEAD-->',seo.seoHead(route))
  .replace('<body class="mx-web-shell">',`<body class="mx-web-shell" data-page="${route==='/'?'home':'inner'}">`)
  .replace('<header id="header" class="mx-header"></header>',`<header id="header" class="mx-header">${site.renderHeader(route,context)}</header>`)
  .replace('<main id="main" tabindex="-1"></main>',`<main id="main" tabindex="-1"${route==='/offline'?' data-offline-fallback':''}>${main}</main>`)
  .replace('<footer id="footer" class="mx-footer"></footer>',`<footer id="footer" class="mx-footer">${site.renderFooter()}</footer>`);
 documents[route]=html; metadata[route]=seo.metadataFor(route);
}
process.stdout.write(JSON.stringify({documents,metadata,publicRoutes:seo.publicRoutes,origin:seo.SITE_ORIGIN,robots:seo.robotsTxt(),sitemap:seo.sitemapXml()}));
