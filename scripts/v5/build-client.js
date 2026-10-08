'use strict';
// Deterministic client bundle builder (V5-01-05 / P01 deterministic client packaging seam).
//
//   node scripts/v5/build-client.js --output <directory> [--root <dir>] [--config <file>]
//                                   [--json] [--check]
//
// Builds an offline-capable client directory from an explicit allowlist:
//   * the approved web index, with external dependency URLs rewritten to exact local
//     allowlisted paths and internal site-absolute routes rewritten to bundled files
//   * the approved client scripts and stylesheets
//   * the legal pages and their stylesheet
//   * the pinned icon dependency (Lucide 0.468.0) and the pinned Google Font families/weights
//   * licence and provenance metadata for every vendored dependency
// and writes a JSON manifest of repository-relative source paths, bundle-relative paths, byte
// sizes, SHA256 digests, provenance and a deterministic bundle hash.
//
// The builder never copies a repository directory wholesale. Server authority, credentials,
// databases, tests, deployment tooling and repository metadata are not allowed inputs, and
// traversal, symlinks, non-regular files and out-of-root sources are rejected while building.
// It only reads repository inputs, so no server, account, provider or user object is created.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_CONFIG = 'native/client/bundle.config.json';
const VENDOR_ROOT_PREFIX = 'assets/vendor/';
const GENERATOR = 'scripts/v5/build-client.js';
const MANIFEST_ALGORITHM = 'sha256 of "\\0"-joined "<path>\\0<bytes>\\0<sha256>" rows for every file sorted by bundle path';

class BuildError extends Error {
  constructor(code, detail) {
    super(detail ? code + ': ' + detail : code);
    this.code = code;
    this.detail = detail || '';
  }
}

const usage = (detail) => new BuildError('USAGE', detail);
const refuse = (detail) => new BuildError('REFUSAL', detail);

// ------------------------------------------------------------------ helpers

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

function hashParts(parts) {
  const hash = crypto.createHash('sha256');
  for (const part of parts) hash.update(part).update('\u0000');
  return hash.digest('hex');
}

function readText(file, code) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new BuildError(code, file + ': ' + error.message);
  }
}

function readJson(file, code) {
  const text = readText(file, code);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new BuildError(code, file + ': invalid JSON: ' + error.message);
  }
}

const toPosix = (value) => value.split(path.sep).join('/');

// Normalize a bundle-relative destination, rejecting absolute paths, parent escapes, empty
// segments and backslashes so a crafted config cannot write outside the output tree.
function normalizeBundlePath(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw refuse(label + ' must be a non-empty string');
  if (value.includes('\\')) throw refuse(label + ' contains a backslash: ' + value);
  if (path.isAbsolute(value)) throw refuse(label + ' must be bundle-relative: ' + value);
  const normalized = toPosix(path.normalize(value));
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') throw refuse(label + ' has an empty or relative segment: ' + value);
  }
  return normalized;
}

// Resolve a repository-relative source to a real regular file inside the given root. Absolute
// inputs, parent escapes, symlinks and non-files are refused; the real path must stay in-root.
function resolveSource(root, relative, label) {
  if (typeof relative !== 'string' || relative.length === 0) throw refuse(label + ' must be a non-empty string');
  if (path.isAbsolute(relative)) throw refuse(label + ' must be repository-relative: ' + relative);
  const absolute = path.resolve(root, relative);
  if (absolute === root || !absolute.startsWith(root + path.sep)) {
    throw refuse(label + ' resolves outside the source root: ' + relative);
  }
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    throw refuse(label + ' is not readable: ' + relative);
  }
  if (stat.isSymbolicLink()) throw refuse(label + ' is a symlink and cannot be bundled: ' + relative);
  if (!stat.isFile()) throw refuse(label + ' is not a regular file: ' + relative);
  const real = fs.realpathSync(absolute);
  if (real !== absolute || !real.startsWith(root + path.sep)) {
    throw refuse(label + ' resolves through a link or escapes the source root: ' + relative);
  }
  return absolute;
}

const relativeTo = (root, absolute) => toPosix(path.relative(root, absolute));

function matchesPrefix(relative, prefixes) {
  return prefixes.some((prefix) => (prefix.endsWith('/') ? relative.startsWith(prefix) : relative === prefix));
}

// Approved-source gate: the union of forbidden names, forbidden prefixes and the explicit
// allowlist. Anything not positively allowlisted is refused rather than copied.
function assertAllowedSource(relative, config, label) {
  const forbiddenNames = new Set(config.forbidden_source_names || []);
  for (const segment of relative.split('/')) {
    if (forbiddenNames.has(segment)) throw refuse(label + ' names a forbidden source: ' + relative);
  }
  if (matchesPrefix(relative, config.forbidden_source_prefixes || [])) throw refuse(label + ' is a forbidden source: ' + relative);
  if (!matchesPrefix(relative, config.allowed_source_prefixes || [])) {
    throw refuse(label + ' is outside the approved source allowlist: ' + relative);
  }
  return relative;
}

const vendorDestination = (relative) => 'vendor/' + relative.slice(VENDOR_ROOT_PREFIX.length);
const vendorDestinationOrNull = (relative) => (relative.startsWith(VENDOR_ROOT_PREFIX) ? vendorDestination(relative) : null);

// ------------------------------------------------------------------ inputs

function loadConfig(root, configPath) {
  const absolute = path.isAbsolute(configPath) ? configPath : path.resolve(root, configPath);
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    throw refuse('bundle config is not readable: ' + configPath);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw refuse('bundle config must be a regular file: ' + configPath);
  const config = readJson(absolute, 'CONFIG_UNREADABLE');
  if (config.schema_version !== 1) throw refuse('unsupported bundle config schema_version: ' + String(config.schema_version));
  for (const key of ['bundle_index', 'manifest', 'web_index', 'vendor_root', 'vendor_font_css', 'vendor_font_css_url']) {
    if (typeof config[key] !== 'string' || config[key].length === 0) throw refuse('bundle config is missing ' + key);
  }
  for (const key of ['local_route_rewrites', 'index_dependency_links', 'client_scripts', 'client_styles', 'legal_pages', 'legal_styles', 'vendor_scripts', 'vendor_licenses', 'vendor_exclude', 'allowed_source_prefixes', 'forbidden_source_prefixes', 'forbidden_source_names', 'forbidden_destination_segments']) {
    config[key] = config[key] || [];
  }
  if (!config.index_rewrites || typeof config.index_rewrites !== 'object' || Array.isArray(config.index_rewrites)) {
    throw refuse('bundle config index_rewrites must be an object mapping dependency URL to bundle path');
  }
  if (!(config.vendor_root === 'assets/vendor' || normalizeBundlePath(config.vendor_root, 'vendor_root').startsWith(VENDOR_ROOT_PREFIX))) {
    throw refuse('vendor_root must live under ' + VENDOR_ROOT_PREFIX + ', got: ' + config.vendor_root);
  }
  return { config, path: absolute };
}

// Vendored files are discovered under the vendor root only. There is no directory walk outside
// it and no recursive copy of any other repository directory.
function discoverVendorFiles(root, config) {
  const vendorRoot = path.resolve(root, config.vendor_root);
  if (vendorRoot === root || !vendorRoot.startsWith(root + path.sep)) throw refuse('vendor root resolves outside the source root: ' + config.vendor_root);
  const excluded = new Set(config.vendor_exclude || []);
  const files = [];
  const walk = (absoluteDir) => {
    const entries = fs.readdirSync(absoluteDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const absolute = path.join(absoluteDir, entry.name);
      if (entry.isSymbolicLink()) throw refuse('vendor entry is a symlink: ' + relativeTo(root, absolute));
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) throw refuse('vendor entry is not a regular file: ' + relativeTo(root, absolute));
      const relative = relativeTo(root, absolute);
      if (excluded.has(relative)) continue;
      files.push(relative);
    }
  };
  walk(vendorRoot);
  if (files.length === 0) throw refuse('vendor root contains no bundleable files: ' + config.vendor_root);
  for (const relative of files) assertAllowedSource(relative, config, 'vendor asset');
  return files;
}

// ------------------------------------------------------------------ html localization

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// URLs that would require the network on first launch. XML namespaces are not dependencies.
function dependencyUrls(html) {
  const found = new Set();
  for (const match of html.match(/(?:https?:)?\/\/[^\s"'<>)\\]+/gi) || []) {
    if (/^https?:\/\/www\.w3\.org\//i.test(match)) continue;
    found.add(match);
  }
  return [...found].sort();
}

// Approved rewrites only: exact external dependency URLs onto bundled allowlisted paths, the
// now-unused remote preconnects removed, and site-absolute internal routes onto bundled files.
// No layout, script logic or theme content is altered. Applied to the generated index and to
// the bundled copies of the legal pages; the root web sources are never modified.
function localizeHtml(html, config, { requireDependencyLinks = false } = {}) {
  let output = html;
  for (const [from, to] of Object.entries(config.index_rewrites).sort((a, b) => b[0].length - a[0].length)) {
    if (typeof from !== 'string' || from.length === 0) throw refuse('index rewrite source must be a non-empty string');
    output = output.split(from).join(normalizeBundlePath(to, 'index rewrite target'));
  }
  for (const link of config.index_dependency_links) {
    if (link.rel !== 'preconnect') throw refuse('only preconnect dependency links may be declared, got: ' + String(link.rel));
    if (typeof link.href !== 'string' || link.href.length === 0) throw refuse('dependency link is missing href');
    const pattern = new RegExp('<link\\b[^>]*\\brel=["\']preconnect["\'][^>]*\\bhref=["\']' + escapeRegExp(link.href) + '["\'][^>]*>', 'gi');
    const present = pattern.test(output);
    pattern.lastIndex = 0;
    if (!present && requireDependencyLinks) throw refuse('declared preconnect link is absent from the html: ' + link.href);
    output = output.replace(pattern, '');
  }
  for (const rewrite of config.local_route_rewrites) {
    if (typeof rewrite.from !== 'string' || !rewrite.from.startsWith('/')) {
      throw refuse('local route rewrite requires a site-absolute path: ' + JSON.stringify(rewrite.from === undefined ? null : rewrite.from));
    }
    output = output.split('"' + rewrite.from + '"').join('"' + normalizeBundlePath(rewrite.to, 'local route target') + '"');
  }
  const remaining = dependencyUrls(output);
  if (remaining.length > 0) throw refuse('html still references non-local dependency URLs: ' + remaining.join(', '));
  return output;
}

// ------------------------------------------------------------------ font stylesheet

function relativeFrom(fromDir, target) {
  const from = fromDir.split('/').filter(Boolean);
  const to = target.split('/');
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common += 1;
  return [...new Array(from.length - common).fill('..'), ...to.slice(common)].join('/');
}

// Rewrites the captured Google Fonts stylesheet onto the vendored font files. Only resource
// URLs that were actually vendored may remain; an unknown URL is a hard failure rather than a
// silent remote reference.
function buildFontStylesheet(root, config, destinations) {
  const sourceRel = normalizeBundlePath(config.vendor_font_css, 'vendor_font_css');
  assertAllowedSource(sourceRel, config, 'font css');
  const source = readText(resolveSource(root, sourceRel, 'font css'), 'FONT_CSS_UNREADABLE');
  const byBasename = new Map(destinations.map((destination) => [path.basename(destination), destination]));
  const missing = [];
  const body = source.replace(/url\((https:\/\/fonts\.gstatic\.com\/[^)\s]+)\)/g, (match, url) => {
    const local = byBasename.get(path.basename(url));
    if (!local) {
      missing.push(url);
      return match;
    }
    return 'url(' + relativeFrom('vendor/fonts', local) + ')';
  });
  if (missing.length > 0) throw refuse('font stylesheet references unvendored resources: ' + missing.join(', '));
  if (/https?:\/\//.test(body.replace(/\/\*[\s\S]*?\*\//g, ''))) throw refuse('font stylesheet still contains remote URLs after rewrite');
  if (!/@font-face/.test(body)) throw refuse('captured font stylesheet contains no @font-face rules');
  return { source: sourceRel, text: body };
}

// ------------------------------------------------------------------ output directory

// The output directory must be absent, empty, or a previous bundle this generator wrote. This
// prevents merging new output into an unrelated directory that might already hold server files,
// and prevents deleting anything this tool does not own.
function prepareOutput(outputRoot, config) {
  let stat = null;
  try {
    stat = fs.lstatSync(outputRoot);
  } catch {
    stat = null;
  }
  if (stat) {
    if (stat.isSymbolicLink()) throw refuse('output directory is a symlink: ' + outputRoot);
    if (!stat.isDirectory()) throw refuse('output path exists and is not a directory: ' + outputRoot);
    if (fs.readdirSync(outputRoot).length > 0) {
      let previous = null;
      try {
        previous = JSON.parse(fs.readFileSync(path.join(outputRoot, config.manifest), 'utf8'));
      } catch {
        previous = null;
      }
      if (!previous || previous.generator !== GENERATOR || !Array.isArray(previous.files)
          || previous.manifest_file !== config.manifest || typeof previous.bundle_hash !== 'string') {
        throw refuse('output directory is not a verified generated bundle: ' + outputRoot);
      }
      // A forged/stale generator field is not permission to remove user files.
      // Verify every declared file, reject extra files and reject links anywhere
      // beneath the output before recursive replacement.
      const expected = new Set([normalizeBundlePath(config.manifest, 'manifest')]);
      for (const file of previous.files) {
        if (!file || typeof file.path !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)
            || !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw refuse('invalid previous bundle inventory');
        const relative = normalizeBundlePath(file.path, 'previous bundle path');
        if (expected.has(relative)) throw refuse('duplicate previous bundle path: ' + relative);
        expected.add(relative);
        const absolute = path.join(outputRoot, relative);
        const stat = fs.lstatSync(absolute);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.bytes
            || sha256(fs.readFileSync(absolute)) !== file.sha256) {
          throw refuse('previous bundle file changed: ' + relative);
        }
      }
      const actual = new Set();
      const walk = (dir, prefix = '') => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) throw refuse('previous bundle contains a symlink');
          const relative = prefix ? prefix + '/' + entry.name : entry.name;
          if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
          else if (entry.isFile()) actual.add(relative);
          else throw refuse('previous bundle contains an unexpected entry');
        }
      };
      walk(outputRoot);
      if (expected.size !== actual.size || [...actual].some(file => !expected.has(file))) {
        throw refuse('previous bundle contains untracked files');
      }
      const actualHash = hashParts(previous.files
        .map(file => file.path + '\u0000' + file.bytes + '\u0000' + file.sha256)
        .sort());
      if (actualHash !== previous.bundle_hash) throw refuse('previous bundle manifest hash mismatch');
      fs.rmSync(outputRoot, { recursive: true, force: true });
    }
  }
  fs.mkdirSync(outputRoot, { recursive: true });
  // A symlinked final component would put the bundle somewhere other than the named directory.
  const real = fs.realpathSync(outputRoot);
  const realParent = fs.realpathSync(path.dirname(outputRoot));
  if (real !== path.join(realParent, path.basename(outputRoot))) throw refuse('output directory resolves through a link: ' + outputRoot);
  return real;
}

// Protected repository locations that a bundle must never be written into.
const PROTECTED_DIRS = ['src', 'public', 'assets', 'server', 'scripts', 'tests', 'native', 'deploy', 'docs', '.git', '.github', '.agents', 'Mega-XO-V5-Implementation-Pack'];

function assertOutputLocation(outputRoot, root) {
  const resolved = path.resolve(outputRoot);
  if (resolved === path.resolve(root)) throw refuse('refusing to write the bundle over the source root');
  for (const dir of PROTECTED_DIRS) {
    const absolute = path.join(path.resolve(root), dir);
    if (resolved === absolute || resolved.startsWith(absolute + path.sep)) {
      throw refuse('refusing to write the bundle into a protected repository location: ' + dir);
    }
  }
}

// ------------------------------------------------------------------ plan

function buildPlan(root, config) {
  const entries = [];
  const add = (kind, source, destination, extra = {}) => {
    const relative = normalizeBundlePath(source, kind + ' source');
    const dest = normalizeBundlePath(destination, kind + ' destination');
    assertAllowedSource(relative, config, kind);
    for (const segment of dest.split('/')) {
      if ((config.forbidden_destination_segments || []).includes(segment)) {
        throw refuse(kind + ' destination uses forbidden segment "' + segment + '": ' + dest);
      }
    }
    if (entries.some((entry) => entry.destination === dest)) throw refuse('duplicate bundle destination: ' + dest);
    entries.push({ kind, source: relative, destination: dest, generatedAsset: null, ...extra });
    return dest;
  };

  add('index', config.web_index, config.bundle_index, { provenance: 'approved-web-index' });
  for (const source of config.client_scripts) add('script', source, source, { provenance: 'approved-client-source' });
  for (const source of config.client_styles) add('style', source, source, { provenance: 'approved-client-source' });
  for (const page of config.legal_pages) add('legal', page.source, page.destination, { provenance: 'approved-legal-page' });
  for (const style of config.legal_styles) add('legal-style', style.source, style.destination, { provenance: 'approved-legal-style' });
  for (const script of config.vendor_scripts) {
    add('vendor-script', script.source, script.destination, { provenance: script.url, name: script.name, version: script.version });
  }
  for (const license of config.vendor_licenses) {
    add('license', license.path, vendorDestinationOrNull(license.path) || license.path, { provenance: license.url, name: license.name, spdx: license.spdx });
  }

  const vendorFiles = discoverVendorFiles(root, config);
  for (const relative of vendorFiles) {
    const destination = vendorDestination(relative);
    if (entries.some((entry) => entry.destination === destination)) continue;
    add('vendor-asset', relative, destination, { provenance: relative.startsWith('assets/vendor/lucide/') ? 'lucide@0.468.0' : 'pinned-google-fonts' });
  }

  const destinations = entries.filter((entry) => entry.kind === 'vendor-asset' || entry.kind === 'vendor-script' || entry.kind === 'license').map((entry) => entry.destination);
  const font = buildFontStylesheet(root, config, destinations.filter((destination) => destination.startsWith('vendor/fonts/')));
  entries.push({
    kind: 'vendor-font-style',
    source: font.source,
    destination: 'vendor/fonts/fonts.css',
    generatedAsset: 'google-fonts-stylesheet-rewritten-to-vendored-fonts',
    provenance: config.vendor_font_css_url,
  });
  return { entries, font };
}

// ------------------------------------------------------------------ build

function build(options) {
  let root = path.resolve(options.root || DEFAULT_ROOT);
  try {
    root = fs.realpathSync(root);
  } catch (error) {
    throw refuse('source root is not readable: ' + root);
  }
  if (!fs.statSync(root).isDirectory()) throw refuse('source root is not a directory: ' + root);
  const configPath = options.config || DEFAULT_CONFIG;
  const { config } = loadConfig(root, configPath);
  if (!options.output) throw usage('--output <directory> is required');
  const outputRoot = path.resolve(process.cwd(), options.output);
  assertOutputLocation(outputRoot, root);
  // Validate the entire source plan before replacing an already valid bundle.
  // The previous output must survive a missing/forbidden input or failed HTML
  // localization; otherwise an unsuccessful rebuild removes the last good client.
  const plan = buildPlan(root, config);
  const manifestPreflight = normalizeBundlePath(config.manifest, 'manifest');
  if (plan.entries.some((entry) => entry.destination === manifestPreflight)) {
    throw refuse('manifest path collides with a bundle file: ' + manifestPreflight);
  }
  for (const entry of plan.entries) {
    if (entry.generatedAsset) continue;
    const absolute = resolveSource(root, entry.source, entry.kind + ' source');
    if (entry.kind === 'index' || entry.kind === 'legal') {
      localizeHtml(fs.readFileSync(absolute, 'utf8'), config, { requireDependencyLinks: entry.kind === 'index' });
    }
  }
  for (const relative of config.vendor_exclude || []) {
    resolveSource(root, relative, 'vendor capture');
  }

  const realOutput = prepareOutput(outputRoot, config);
  const files = [];
  const sourceCaptures = [];
  let totalBytes = 0;

  const write = (destination, buffer, record) => {
    const absolute = path.join(realOutput, destination.split('/').join(path.sep));
    if (!absolute.startsWith(realOutput + path.sep)) throw refuse('destination escapes the output directory: ' + destination);
    if (files.some((file) => file.path === destination)) throw refuse('duplicate output path: ' + destination);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, buffer);
    totalBytes += buffer.length;
    files.push({ path: destination, bytes: buffer.length, sha256: sha256(buffer), ...record });
  };

  for (const entry of plan.entries) {
    if (entry.generatedAsset) {
      write(entry.destination, Buffer.from(plan.font.text, 'utf8'), {
        kind: entry.kind,
        source: entry.source,
        provenance: entry.provenance,
        generated: entry.generatedAsset,
      });
      continue;
    }
    const absolute = resolveSource(root, entry.source, entry.kind + ' source');
    let buffer = fs.readFileSync(absolute);
    let generated;
    if (entry.kind === 'index' || entry.kind === 'legal') {
      buffer = Buffer.from(localizeHtml(buffer.toString('utf8'), config, { requireDependencyLinks: entry.kind === 'index' }), 'utf8');
      generated = entry.kind === 'index'
        ? 'external-dependency-urls-and-internal-routes-rewritten-to-local-paths'
        : 'internal-routes-rewritten-to-local-paths';
    }
    write(entry.destination, buffer, {
      kind: entry.kind,
      source: relativeTo(root, absolute),
      provenance: entry.provenance || 'approved-client-source',
      ...(entry.name ? { name: entry.name } : {}),
      ...(entry.version ? { version: entry.version } : {}),
      ...(entry.spdx ? { spdx: entry.spdx } : {}),
      ...(generated ? { generated } : {}),
    });
  }

  // Excluded captures stay out of the bundle but their digests are recorded, so the vendored
  // fonts can be traced back to the exact pinned response the baseline observed.
  for (const relative of config.vendor_exclude || []) {
    const absolute = resolveSource(root, relative, 'vendor capture');
    const buffer = fs.readFileSync(absolute);
    sourceCaptures.push({ path: relativeTo(root, absolute), bytes: buffer.length, sha256: sha256(buffer), provenance: 'baseline-observed-dependency-capture' });
  }
  sourceCaptures.sort((a, b) => (a.path < b.path ? -1 : 1));

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const bundleHash = hashParts(files.map((file) => file.path + '\u0000' + file.bytes + '\u0000' + file.sha256));
  const manifestPath = normalizeBundlePath(config.manifest, 'manifest');
  if (files.some((file) => file.path === manifestPath)) throw refuse('manifest path collides with a bundle file: ' + manifestPath);
  const manifest = {
    schema_version: 1,
    generator: GENERATOR,
    config: path.isAbsolute(configPath) ? configPath : relativeTo(root, path.resolve(root, configPath)),
    bundle_file: config.bundle_index,
    manifest_file: manifestPath,
    bundle_hash_algorithm: MANIFEST_ALGORITHM,
    bundle_hash: bundleHash,
    file_count: files.length,
    total_bytes: totalBytes,
    files,
    source_captures: sourceCaptures,
  };
  // The manifest describes the hashed payload and is therefore not part of that payload; it is
  // written last so its own presence never changes the bundle hash.
  fs.writeFileSync(path.join(realOutput, manifestPath.split('/').join(path.sep)), JSON.stringify(manifest, null, 2) + '\n');

  return { output: realOutput, manifest, root };
}

// ------------------------------------------------------------------ CLI

function parseArgv(argv) {
  const options = { json: false, check: false, help: false, output: null, config: null, root: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output' || arg === '-o') options.output = argv[++index];
    else if (arg === '--config') options.config = argv[++index];
    else if (arg === '--root') options.root = argv[++index];
    else if (arg === '--json') options.json = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw usage('unknown argument: ' + arg);
  }
  if (options.output !== undefined && options.output !== null && typeof options.output !== 'string') throw usage('--output requires a directory');
  if (options.root !== undefined && options.root !== null && typeof options.root !== 'string') throw usage('--root requires a directory');
  if (options.config !== undefined && options.config !== null && typeof options.config !== 'string') throw usage('--config requires a file');
  return options;
}

const HELP = [
  'usage: node scripts/v5/build-client.js --output <directory> [--root <dir>] [--config <file>]',
  '                                          [--json] [--check]',
  '',
  'Builds the deterministic allowlisted client bundle (approved client/legal assets, pinned',
  'Lucide 0.468.0 and pinned font families) plus a JSON manifest of bundle-relative paths,',
  'sizes, SHA256 digests and provenance. Reads repository inputs only; it creates no server,',
  'account, provider or user object.',
  '',
  '  --output <dir>   absent, empty, or a previous bundle written by this generator',
  '  --root <dir>     source root to read (default: repository root)',
  '  --config <file>  bundle allowlist config (default native/client/bundle.config.json)',
  '  --json           print the manifest to stdout',
  '  --check          rebuild into <dir>.recheck and require an identical bundle hash',
  '',
].join('\n');

function main(argv = process.argv.slice(2)) {
  const options = parseArgv(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return null;
  }
  const result = build(options);
  if (options.check) {
    const recheck = build({ ...options, output: result.output + '.recheck' });
    if (recheck.manifest.bundle_hash !== result.manifest.bundle_hash) {
      throw new BuildError('NONDETERMINISTIC', 'two builds produced different bundle hashes');
    }
    fs.rmSync(recheck.output, { recursive: true, force: true });
  }
  if (options.json) process.stdout.write(JSON.stringify(result.manifest, null, 2) + '\n');
  else {
    process.stdout.write([
      'build-client: ok',
      '  output: ' + result.output,
      '  files: ' + result.manifest.file_count + ' (' + result.manifest.total_bytes + ' bytes)',
      '  bundle_hash: ' + result.manifest.bundle_hash,
      '',
    ].join('\n'));
  }
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const cli = error instanceof BuildError;
    if (process.argv.includes('--json')) {
      process.stderr.write(JSON.stringify({ ok: false, error: cli ? error.code : 'INTERNAL_ERROR', detail: error.message }) + '\n');
    } else {
      process.stderr.write('build-client: ' + (cli ? error.message : 'INTERNAL_ERROR: ' + error.message) + '\n');
    }
    process.exitCode = cli && error.code === 'USAGE' ? 64 : 1;
  }
}

module.exports = {
  main, build, buildPlan, buildFontStylesheet, localizeHtml, dependencyUrls,
  loadConfig, discoverVendorFiles, resolveSource, normalizeBundlePath, prepareOutput,
  assertOutputLocation, parseArgv, sha256, hashParts, BuildError,
  DEFAULT_CONFIG, DEFAULT_ROOT, GENERATOR, PROTECTED_DIRS,
};
