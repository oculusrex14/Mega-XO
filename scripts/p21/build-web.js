'use strict';

// Static packaging only. The positive allowlists are the release boundary.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const {validateStoreLinks} = require('../../apps/web/download-config.cjs');

const ROOT = path.resolve(__dirname, '../..');
const GENERATOR = 'scripts/p21/build-web.js';
const MANIFEST = 'web-build.manifest.json';
const WEB_FILES = ['index.html', 'app.js', 'styles.css', 'ui.js', 'pages.js', 'pages.css', 'board.js', 'board.css', 'site.js', 'seo.js', 'downloads.js'];
const OPTIONAL_WEB_FILES = ['data.js', 'game-runtime.js'];
const GAME_FILES = ['game.js', 'domain.js', 'monetization.js', 'lan-icons.js', 'icons.js', 'account-client.js', 'network.js', 'app.js', 'tournament.js', 'party-ui.js', 'community.js', 'monetization-ui.js', 'styles.css', 'party.css', 'community.css', 'monetization.css'];
const LEGAL_NAMES = ['privacy', 'terms', 'support', 'delete-account', 'privacy-choices'];
const WEBSITE_ROUTES = ['/', '/download', '/faq', '/press', '/play', '/game', '/casual', '/ranked', '/tournaments', '/season', '/friends', '/challenge', '/leaderboard', '/rewards', '/store', '/sponsors', '/ads', '/themes', '/profile', '/settings', '/account', '/how-to-play', '/support', '/about', '/privacy', '/terms', '/delete-account', '/privacy-choices', ...LEGAL_NAMES.map(name => '/legal/' + name), '/help', '/news', '/status', '/accessibility', '/offline', '/404'];
const routeFile = route => route==='/'?'index.html':route==='/404'?'404.html':'pages'+route+'.html';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const posix = value => value.split(path.sep).join('/');

function refuse(message) { throw new Error('P21_BUILD_REFUSED: ' + message); }

function readSource(root, relative) {
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(root + path.sep)) refuse('source escaped repository');
  const info = fs.lstatSync(absolute);
  if (!info.isFile() || info.isSymbolicLink() || fs.realpathSync(absolute) !== absolute) refuse('source must be a regular, unlinked file: ' + relative);
  return fs.readFileSync(absolute);
}

function filesIn(root, relative, allowed) {
  const directory = path.resolve(root, relative);
  if (!fs.existsSync(directory)) return [];
  if (!fs.lstatSync(directory).isDirectory() || fs.realpathSync(directory) !== directory) refuse('asset directory must be unlinked: ' + relative);
  return fs.readdirSync(directory).sort().filter(allowed).map(name => relative + '/' + name);
}

function rankFiles(root, relative = 'assets/p21/ranks') {
  const directory = path.resolve(root, relative);
  if (!fs.existsSync(directory)) return [];
  if (!fs.lstatSync(directory).isDirectory() || fs.realpathSync(directory) !== directory) refuse('rank directory must be unlinked: ' + relative);
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en')).flatMap(entry => {
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(entry.name)) return [];
    const source = relative + '/' + entry.name;
    if (entry.isSymbolicLink()) refuse('rank asset must be unlinked: ' + source);
    if (entry.isDirectory()) return rankFiles(root, source);
    return entry.isFile() && entry.name.endsWith('.webp') ? [source] : [];
  });
}

function legalMain(html, source) {
  const matches = [...html.matchAll(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/gi)];
  if (matches.length !== 1) refuse('legal source must contain exactly one main element: ' + source);
  const markup = matches[0][1];
  if (/<(?:script|style|link|meta|head|body|iframe|object|embed)\b|\bon\w+\s*=|(?:href|src)\s*=\s*["']\s*javascript:/i.test(markup)) refuse('legal main must contain document markup only: ' + source);
  return markup;
}

function safeOutput(root, requested) {
  const output = path.resolve(root, requested || '.artifacts/p21-web');
  const relative = posix(path.relative(root, output));
  if (!(relative.startsWith('.artifacts/') && relative !== '.artifacts/') && relative !== 'apps/web/dist') refuse('output must be a child of .artifacts or apps/web/dist');
  let ancestor = output;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (fs.realpathSync(ancestor) !== ancestor) refuse('output path traverses a symlink');
  if (fs.existsSync(output)) {
    if (!fs.lstatSync(output).isDirectory()) refuse('output is not a directory');
    let prior;
    try { prior = JSON.parse(fs.readFileSync(path.join(output, MANIFEST), 'utf8')); }
    catch { refuse('existing output is not a recognized generated bundle'); }
    if (prior.generator !== GENERATOR || !Array.isArray(prior.files)) refuse('existing output is not owned by this builder');
    const owned = new Set([MANIFEST, ...prior.files.map(file => file.path)]);
    const walk = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) refuse('existing output contains a symlink');
        if (entry.isDirectory()) walk(full);
        else if (!entry.isFile() || !owned.has(posix(path.relative(output, full)))) refuse('existing output contains an unrecognized file');
      }
    };
    walk(output);
  }
  return output;
}

function sourceCommit(root) {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

function createPlan(root) {
  const entries = [];
  const add = (source, destination, transform) => {
    if (entries.some(entry => entry.path === destination)) refuse('duplicate destination: ' + destination);
    const original = readSource(root, source);
    const bytes = transform ? Buffer.from(transform(original.toString('utf8'))) : original;
    entries.push({ source, path: destination, bytes, source_sha256: sha256(original), sha256: sha256(bytes), ...(transform ? { transformation: 'legal-stylesheet-url-only' } : {}) });
  };
  const template=readSource(root,'apps/web/index.html').toString('utf8');
  for(const marker of ['<!--SEO_HEAD-->','<header id="header" class="mx-header"></header>','<main id="main" tabindex="-1"></main>','<footer id="footer" class="mx-footer"></footer>']){
    if(template.split(marker).length!==2)refuse('template must contain each prerender marker exactly once');
  }
  for (const name of WEB_FILES.filter(name=>name!=='index.html')) add('apps/web/' + name, name);
  for (const name of OPTIONAL_WEB_FILES) if (fs.existsSync(path.join(root, 'apps/web', name))) add('apps/web/' + name, name);
  add('index.html', 'legacy-game/index.html');
  for (const name of GAME_FILES) add('src/' + name, 'legacy-game/src/' + name);
  for (const theme of ['vector', 'midnight', 'paperclub', 'afterhours']) {
    for (const kind of ['app', 'mark']) {
      const source = 'assets/p21/logos/mega-xoxo-' + theme + '-' + kind + '.webp';
      add(source, 'legacy-game/' + source);
    }
  }
  for (const name of LEGAL_NAMES) add('public/' + name + '.html', 'legal/' + name + '.html', html => html.replaceAll('/public/legal.css', '/legal/legal.css'));
  add('public/legal.css', 'legal/legal.css');
  const documents = {}, legalSources = [];
  for (const name of LEGAL_NAMES) {
    const source = 'public/' + name + '.html';
    const original = readSource(root, source);
    documents[name] = legalMain(original.toString('utf8'), source);
    legalSources.push({ source, bytes: original.length, source_sha256: sha256(original) });
  }
  const legalBytes = Buffer.from('// Generated from the retained public documents; wording and draft notices are unchanged.\nexport const legalDocuments = Object.freeze(' + JSON.stringify(documents, null, 2) + ');\n');
  entries.push({ source: null, sources: legalSources, path: 'legal-documents.js', bytes: legalBytes, sha256: sha256(legalBytes), transformation: 'trusted-main-inner-markup-to-es-module' });
  const configSource='apps/web/store-links.json';
  const storeLinks=validateStoreLinks(JSON.parse(readSource(root,configSource).toString('utf8')));
  const renderSources=[...WEB_FILES.map(name=>'apps/web/'+name),'src/game.js',configSource,...legalSources.map(row=>row.source)].map(source=>({source,source_sha256:sha256(readSource(root,source))}));
  const rendered=JSON.parse(execFileSync(process.execPath,[path.join(__dirname,'prerender-web.mjs')],{
    input:JSON.stringify({root,template,storeLinks,legalDocuments:documents,routes:WEBSITE_ROUTES}),encoding:'utf8',maxBuffer:12*1024*1024,
  }));
  const generated=(destination,text,sources=renderSources,transformation='shared-pure-view-prerender')=>{
    const bytes=Buffer.from(text);
    entries.push({source:null,sources,path:destination,bytes,sha256:sha256(bytes),transformation});
  };
  for(const route of WEBSITE_ROUTES)generated(routeFile(route),rendered.documents[route]);
  generated('robots.txt',rendered.robots,renderSources,'canonical-crawl-policy');
  generated('sitemap.xml',rendered.sitemap,renderSources,'canonical-public-route-sitemap');
  generated('store-links.js','// Generated from validated public store configuration.\nexport const storeLinks = Object.freeze('+JSON.stringify(storeLinks)+');\n',[{source:configSource,source_sha256:sha256(readSource(root,configSource))}],'validated-store-links-to-es-module');
  entries.seo={origin:rendered.origin,public_routes:rendered.publicRoutes,metadata:rendered.metadata};
  entries.storeLinks=storeLinks;
  const art = [...filesIn(root, 'assets/p21/art', name => /^[a-z0-9][a-z0-9.-]*\.webp$/.test(name)), ...rankFiles(root), ...rankFiles(root, 'assets/p21/art/ranks'), ...rankFiles(root, 'assets/p21/art/currency')];
  for (const source of art) {
    const bytes = readSource(root, source);
    if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') refuse('art is not a WebP export: ' + source);
    const destination = source.startsWith('assets/p21/ranks/') ? 'assets/art/ranks/' + source.slice('assets/p21/ranks/'.length) : 'assets/art/' + source.slice('assets/p21/art/'.length);
    add(source, destination);
  }
  for (const required of ['assets/art/header.webp', 'assets/art/mark.webp']) {
    if (!entries.some(entry => entry.path === required)) refuse('required optimized brand export is missing: ' + required);
  }
  for (const source of filesIn(root, 'assets/p21/fonts', name => /^[a-z0-9][a-z0-9._-]*\.(woff2?|css|txt)$/i.test(name) || /^LICENSE(?:\.[a-z]+)?$/.test(name))) add(source, 'assets/fonts/' + path.basename(source));
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return entries;
}

function buildWeb(options = {}) {
  const root = path.resolve(options.root || ROOT);
  if (fs.realpathSync(root) !== root) refuse('repository root must be unlinked');
  // Preflight every byte before replacing an existing generated bundle.
  const entries = createPlan(root);
  const output = safeOutput(root, options.output);
  const files = entries.map(({ bytes, ...entry }) => ({ ...entry, bytes: bytes.length }));
  const manifest = {
    schema_version: 1,
    generator: GENERATOR,
    source_commit: sourceCommit(root),
    source_commit_meaning: 'checkout HEAD; per-file source_sha256 records the exact packaged working-tree input',
    bundle_sha256: sha256(Buffer.from(files.map(file => file.path + '\0' + file.bytes + '\0' + file.sha256).join('\0'))),
    file_count: files.length,
    total_bytes: files.reduce((total, file) => total + file.bytes, 0),
    routes: Object.fromEntries([...WEBSITE_ROUTES.map(route => [route, routeFile(route)]), ['/game/', routeFile('/game')], ['/legacy-game/', 'legacy-game/index.html']]),
    seo: entries.seo,
    store_links: entries.storeLinks,
    download: {endpoint:'/api/download',configuration:'apps/web/store-links.json',authority:'official-store redirect only; no purchases, identity or economic writes'},
    api: { configured: false, authority: 'existing API / Game Core; static artifact has no backend, credentials or writers', preview_read_seam: 'explicit P21_READ_API_ORIGIN only; GET /api/v1/leaderboard; no credential forwarding' },
    files,
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const stage = fs.mkdtempSync(path.join(path.dirname(output), '.p21-web-build-'));
  try {
    for (const entry of entries) {
      const target = path.join(stage, entry.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.bytes);
    }
    fs.writeFileSync(path.join(stage, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
    if (fs.existsSync(output)) fs.rmSync(output, { recursive: true });
    fs.renameSync(stage, output);
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
  return { output, manifest };
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!['--output', '--root'].includes(arg) || !args[index + 1] || args[index + 1].startsWith('--')) refuse('usage: node scripts/p21/build-web.js [--output .artifacts/name | apps/web/dist] [--root repository]');
    options[arg.slice(2)] = args[++index];
  }
  return options;
}

if (require.main === module) {
  try {
    const result = buildWeb(parseArguments(process.argv.slice(2)));
    process.stdout.write(JSON.stringify({ output: result.output, source_commit: result.manifest.source_commit, bundle_sha256: result.manifest.bundle_sha256, files: result.manifest.file_count, bytes: result.manifest.total_bytes }) + '\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}

module.exports = { buildWeb, createPlan, legalMain, routeFile, ROOT, GENERATOR, MANIFEST, WEB_FILES, OPTIONAL_WEB_FILES, GAME_FILES, LEGAL_NAMES, WEBSITE_ROUTES };
