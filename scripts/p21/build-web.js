'use strict';

// Static packaging only. The positive allowlists are the release boundary.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const GENERATOR = 'scripts/p21/build-web.js';
const MANIFEST = 'web-build.manifest.json';
const WEB_FILES = ['index.html', 'app.js', 'styles.css', 'ui.js', 'pages.js', 'pages.css', 'board.js', 'board.css'];
const GAME_FILES = ['game.js', 'domain.js', 'monetization.js', 'lan-icons.js', 'icons.js', 'account-client.js', 'network.js', 'app.js', 'tournament.js', 'party-ui.js', 'community.js', 'monetization-ui.js', 'styles.css', 'party.css', 'community.css', 'monetization.css'];
const LEGAL_NAMES = ['privacy', 'terms', 'support', 'delete-account', 'privacy-choices'];
const WEBSITE_ROUTES = ['/', '/play', '/casual', '/ranked', '/tournaments', '/season', '/friends', '/challenge', '/leaderboard', '/rewards', '/themes', '/profile', '/settings', '/account', '/how-to-play', '/support', '/about', '/privacy', '/terms', '/delete-account', '/privacy-choices', '/help', '/news', '/status', '/accessibility', '/offline', '/404'];
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
  for (const name of WEB_FILES) add('apps/web/' + name, name);
  // Vercel's static-file 404 convention retains HTTP 404 for unknown routes.
  // The shared SPA document renders its existing page-not-found design.
  add('apps/web/index.html', '404.html');
  add('index.html', 'game/index.html');
  for (const name of GAME_FILES) add('src/' + name, 'game/src/' + name);
  for (const theme of ['vector', 'midnight', 'paperclub', 'afterhours']) {
    for (const kind of ['app', 'mark']) {
      const source = 'assets/p21/logos/mega-xoxo-' + theme + '-' + kind + '.webp';
      add(source, 'game/' + source);
    }
  }
  for (const name of LEGAL_NAMES) add('public/' + name + '.html', 'legal/' + name + '.html', html => html.replaceAll('/public/legal.css', '/legal/legal.css'));
  add('public/legal.css', 'legal/legal.css');
  const art = filesIn(root, 'assets/p21/art', name => /^[a-z0-9][a-z0-9.-]*\.webp$/.test(name));
  for (const source of art) {
    const bytes = readSource(root, source);
    if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') refuse('art is not a WebP export: ' + source);
    const name = path.basename(source);
    add(source, 'assets/art/' + name);
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
    routes: Object.fromEntries([...WEBSITE_ROUTES.map(route => [route, 'index.html']), ['/game/', 'game/index.html'], ...LEGAL_NAMES.map(name => ['/legal/' + name, 'legal/' + name + '.html'])]),
    api: { configured: false, authority: 'existing V5 API / Game Core; this artifact contains no backend or API proxy' },
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

module.exports = { buildWeb, createPlan, ROOT, GENERATOR, MANIFEST, WEB_FILES, GAME_FILES, LEGAL_NAMES, WEBSITE_ROUTES };
