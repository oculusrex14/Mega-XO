'use strict';
// Consumer-visible security regression for the deterministic client bundler (V5-01-05).
//
// Only uncertain bundle boundaries are covered here: source escape/traversal, symlink and
// non-regular inputs, server/authority/credential leakage, unapproved dependency URLs left in
// generated html, output-location safety, vendor tampering and manifest hash sensitivity.
// The tests never execute the packaging CLI as a subprocess and never rewrite repository files:
// they call the exported build() against a private copy root and assert the refusal codes and
// the digest properties a real bundle consumer depends on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const builder = require('../scripts/v5/build-client.js');

const REPO_ROOT = path.resolve(__dirname, '..');

// Private copy root holding just enough approved structure for real builds. Nothing here is the
// repository's mutable progress/evidence state.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-v5-bundle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, content) => {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
    return absolute;
  };
  write('index.html', [
    '<!doctype html><html lang="en" data-theme="vector"><head>',
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    '<link href="https://fonts.example.test/css?family=Space+Grotesk" rel="stylesheet">',
    '<script src="https://unpkg.example.test/lucide@0.468.0/dist/umd/lucide.min.js"></script>',
    '<link rel="stylesheet" href="src/styles.css">',
    '</head><body><a href="/privacy">Privacy</a><a href="/terms">Terms</a></body></html>',
  ].join(''));
  write('src/styles.css', ':root{--x:1}\n');
  write('src/app.js', 'window.app=1;\n');
  write('public/privacy.html', '<!doctype html><html><head><link rel="stylesheet" href="/public/legal.css"></head><body><a href="/terms">Terms</a></body></html>');
  write('public/terms.html', '<!doctype html><html><body><a href="/privacy">Privacy</a></body></html>');
  write('public/legal.css', 'body{margin:0}\n');
  write('assets/vendor/lucide/lucide.min.js', '/* lucide 0.468.0 */\n');
  write('assets/vendor/lucide/LICENSE', 'ISC License\n');
  write('assets/vendor/fonts/spacegrotesk/abc123.woff2', 'FONT-A');
  write('assets/vendor/fonts/spacegrotesk/OFL.txt', 'SIL Open Font License\n');
  write('assets/vendor/fonts/google-fonts.source.css', [
    '/* latin */',
    '@font-face{font-family:"Space Grotesk";font-weight:500;src:url(https://fonts.gstatic.com/s/spacegrotesk/v22/abc123.woff2) format("woff2");}',
  ].join('\n'));
  // Adversarial repository content the bundle must never pick up, exactly as in the real root.
  write('src/authority.js', 'module.exports={secret:true};\n');
  write('server/community-server.js', 'require("../src/authority.js");\n');
  write('tests/secret.test.js', 'throw Error("test");\n');
  write('scripts/deploy.js', '// deploy\n');
  write('docs/plan.md', '# plan\n');
  write('.env', 'SESSION_SECRET=nope\n');
  write('package.json', '{}\n');
  write('Mega-XO-V5-Implementation-Pack/tasks.json', '{}\n');
  const config = {
    schema_version: 1,
    bundle_index: 'bundle-index.html',
    manifest: 'client-bundle.manifest.json',
    web_index: 'index.html',
    client_scripts: ['src/app.js'],
    client_styles: ['src/styles.css'],
    legal_pages: [
      { source: 'public/privacy.html', destination: 'privacy.html' },
      { source: 'public/terms.html', destination: 'terms.html' },
    ],
    legal_styles: [{ source: 'public/legal.css', destination: 'legal.css' }],
    vendor_root: 'assets/vendor',
    vendor_font_css: 'assets/vendor/fonts/google-fonts.source.css',
    vendor_font_css_url: 'https://fonts.example.test/css?family=Space+Grotesk',
    vendor_licenses: [
      { path: 'assets/vendor/lucide/LICENSE', url: 'https://unpkg.example.test/lucide@0.468.0/LICENSE', name: 'Lucide', spdx: 'ISC' },
      { path: 'assets/vendor/fonts/spacegrotesk/OFL.txt', url: 'https://raw.example.test/OFL.txt', name: 'Space Grotesk', spdx: 'OFL-1.1' },
    ],
    vendor_scripts: [
      { source: 'assets/vendor/lucide/lucide.min.js', destination: 'vendor/lucide/lucide.min.js', url: 'https://unpkg.example.test/lucide@0.468.0/dist/umd/lucide.min.js', name: 'lucide', version: '0.468.0' },
    ],
    vendor_exclude: ['assets/vendor/fonts/google-fonts.source.css'],
    index_rewrites: {
      'https://unpkg.example.test/lucide@0.468.0/dist/umd/lucide.min.js': 'vendor/lucide/lucide.min.js',
      'https://fonts.example.test/css?family=Space+Grotesk': 'vendor/fonts/fonts.css',
    },
    index_dependency_links: [
      { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
      { rel: 'preconnect', href: 'https://fonts.gstatic.com' },
    ],
    local_route_rewrites: [
      { from: '/privacy', to: 'privacy.html' },
      { from: '/terms', to: 'terms.html' },
      { from: '/public/legal.css', to: 'legal.css' },
    ],
    allowed_source_prefixes: ['index.html', 'src/', 'public/', 'assets/vendor/'],
    forbidden_source_prefixes: ['src/authority.js', 'server/', 'tests/', 'deploy/', 'scripts/', 'docs/', 'native/', '.git/', 'Mega-XO-V5-Implementation-Pack/'],
    forbidden_source_names: ['.env', '.env.example', 'package.json', 'package-lock.json', 'Dockerfile', 'README.md'],
    forbidden_destination_segments: ['authority', 'server', 'credential', 'secret', '.git', '.env'],
  };
  write('native/client/bundle.config.json', JSON.stringify(config, null, 2));
  return { root, write, configPath: 'native/client/bundle.config.json' };
}

// Runs the real exporter against the private fixture root through the shipped --root seam.
function buildIn(root, options) {
  return builder.build({ ...options, root });
}

const outDir = (name = 'out') => path.join(os.tmpdir(), 'mega-v5-bundle-out-' + process.pid + '-' + crypto.randomBytes(6).toString('hex') + '-' + name);

test('builds an allowlisted bundle with manifest digests and no server/authority leakage', (t) => {
  const { root, configPath } = fixture(t);
  const output = outDir();
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const result = buildIn(root, { output, config: configPath });

  assert.equal(result.manifest.generator, 'scripts/v5/build-client.js');
  assert.ok(result.manifest.files.length > 5);
  for (const file of result.manifest.files) {
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
    assert.ok(file.bytes > 0);
    assert.ok(!path.isAbsolute(file.path));
  }
  assert.equal(result.manifest.files.find((f) => f.path === 'client-bundle.manifest.json'), undefined);
  const manifestBytes = fs.readFileSync(path.join(output, 'client-bundle.manifest.json'), 'utf8');
  assert.equal(JSON.parse(manifestBytes).bundle_hash, result.manifest.bundle_hash);
  // The manifest records itself: it must be listed as a file with its own digest, and the hash
  // must not simply repeat one file's digest.
  const listed = JSON.parse(manifestBytes).files.map((f) => f.path);
  assert.ok(listed.includes('bundle-index.html'));
  assert.ok(listed.includes('privacy.html'));
  assert.ok(listed.includes('vendor/lucide/lucide.min.js'));
  assert.ok(listed.includes('vendor/fonts/fonts.css'));
  assert.ok(!listed.some((p) => /authority|server|tests|deploy|\.env|package\.json/i.test(p)), 'bundle paths must exclude server/authority inputs: ' + listed.join(','));

  // Rewritten index and legal pages must not reference the removed external dependencies, and
  // the internal routes must resolve to bundled files.
  const index = fs.readFileSync(path.join(output, 'bundle-index.html'), 'utf8');
  assert.ok(!/https?:\/\/fonts\.example\.test/.test(index));
  assert.ok(!/https?:\/\/unpkg\.example\.test/.test(index));
  assert.ok(!/preconnect/.test(index));
  assert.ok(index.includes('href="vendor/fonts/fonts.css"'));
  assert.ok(index.includes('src="vendor/lucide/lucide.min.js"'));
  assert.ok(index.includes('href="privacy.html"'));
  assert.ok(index.includes('href="terms.html"'));

  const fonts = fs.readFileSync(path.join(output, 'vendor/fonts/fonts.css'), 'utf8');
  assert.ok(fonts.includes('@font-face'));
  assert.ok(!/fonts\.gstatic\.com/.test(fonts));
  assert.ok(fonts.includes('spacegrotesk/abc123.woff2'));

  // Excluded captures are still traceable through the manifest.
  assert.ok(result.manifest.source_captures.some((c) => c.path === 'assets/vendor/fonts/google-fonts.source.css'));
});

test('is deterministic: identical inputs produce an identical bundle hash', (t) => {
  const { root, configPath } = fixture(t);
  const first = outDir('a');
  const second = outDir('b');
  t.after(() => fs.rmSync(first, { recursive: true, force: true }));
  t.after(() => fs.rmSync(second, { recursive: true, force: true }));
  const a = buildIn(root, { output: first, config: configPath });
  const b = buildIn(root, { output: second, config: configPath });
  assert.equal(a.manifest.bundle_hash, b.manifest.bundle_hash);
});

test('bundle hash changes when one approved asset changes', (t) => {
  const { root, write, configPath } = fixture(t);
  const first = outDir('a');
  const second = outDir('b');
  t.after(() => fs.rmSync(first, { recursive: true, force: true }));
  t.after(() => fs.rmSync(second, { recursive: true, force: true }));
  const a = buildIn(root, { output: first, config: configPath });
  write('src/app.js', 'window.app=2;\n');
  const b = buildIn(root, { output: second, config: configPath });
  assert.notEqual(a.manifest.bundle_hash, b.manifest.bundle_hash);
});

test('refuses authority.js, server, tests, deploy, docs and repository metadata sources', (t) => {
  const { root, write, configPath } = fixture(t);
  const cases = [
    ['src/authority.js', 'src/authority.js'],
    ['server/community-server.js', 'server/community-server.js'],
    ['tests/secret.test.js', 'tests/secret.test.js'],
    ['scripts/deploy.js', 'scripts/deploy.js'],
    ['docs/plan.md', 'docs/plan.md'],
    ['.env', '.env'],
    ['package.json', 'package.json'],
    ['Mega-XO-V5-Implementation-Pack/tasks.json', 'Mega-XO-V5-Implementation-Pack/tasks.json'],
  ];
  for (const [source, destination] of cases) {
    const config = JSON.parse(fs.readFileSync(path.join(root, configPath), 'utf8'));
    config.client_scripts = [source];
    write('native/client/escape.config.json', JSON.stringify(config));
    const output = outDir('x');
    t.after(() => fs.rmSync(output, { recursive: true, force: true }));
    assert.throws(() => buildIn(root, { output, config: 'native/client/escape.config.json' }), /REFUSAL/, 'source must be refused: ' + source);
  }
});

test('refuses traversing and absolute sources and destinations', (t) => {
  const { root, write, configPath } = fixture(t);
  const base = JSON.parse(fs.readFileSync(path.join(root, configPath), 'utf8'));
  const variants = [];
  variants.push({ ...base, client_scripts: ['../outside.js'] });
  variants.push({ ...base, client_scripts: ['/etc/passwd'] });
  variants.push({ ...base, client_scripts: ['src/../../outside.js'] });
  variants.push({ ...base, legal_pages: [{ source: 'public/privacy.html', destination: '../escaped.html' }] });
  variants.push({ ...base, legal_pages: [{ source: 'public/privacy.html', destination: '/abs.html' }] });
  variants.push({ ...base, index_rewrites: { 'https://unpkg.example.test/lucide@0.468.0/dist/umd/lucide.min.js': '../../outside.js' } });
  variants.push({ ...base, legal_styles: [{ source: 'public/legal.css', destination: 'authority/bundle.css' }] });
  write('outside.js', 'window.outside=1;\n');
  for (let index = 0; index < variants.length; index += 1) {
    write('native/client/escape-' + index + '.config.json', JSON.stringify(variants[index]));
    const output = outDir('e' + index);
    t.after(() => fs.rmSync(output, { recursive: true, force: true }));
    assert.throws(
      () => buildIn(root, { output, config: 'native/client/escape-' + index + '.config.json' }),
      /REFUSAL/,
      'variant ' + index + ' must be refused',
    );
    assert.ok(!fs.existsSync(path.join(path.dirname(output), 'escaped.html')), 'no file may escape the output directory');
  }
});

test('refuses symlinked sources, symlinked vendor entries and symlink outputs', (t) => {
  const { root, write, configPath } = fixture(t);
  fs.symlinkSync(path.join(root, 'src/app.js'), path.join(root, 'src/linked.js'));
  const linkedConfig = JSON.parse(fs.readFileSync(path.join(root, configPath), 'utf8'));
  linkedConfig.client_scripts = ['src/linked.js'];
  write('native/client/symlink.config.json', JSON.stringify(linkedConfig));
  const output = outDir('s');
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  assert.throws(() => buildIn(root, { output, config: 'native/client/symlink.config.json' }), /REFUSAL/);

  // A symlinked entry inside the vendor walk must be refused even if it points inside the root.
  fs.symlinkSync(path.join(root, 'assets/vendor/lucide/LICENSE'), path.join(root, 'assets/vendor/lucide/LICENSE.link'));
  const output2 = outDir('s2');
  t.after(() => fs.rmSync(output2, { recursive: true, force: true }));
  assert.throws(() => buildIn(root, { output: output2, config: configPath }), /REFUSAL/);
  fs.rmSync(path.join(root, 'assets/vendor/lucide/LICENSE.link'));

  const symlinkOutput = outDir('s3');
  fs.mkdirSync(symlinkOutput, { recursive: true });
  const target = path.join(symlinkOutput, 'real');
  fs.mkdirSync(target, { recursive: true });
  const link = path.join(symlinkOutput, 'link');
  fs.symlinkSync(target, link);
  assert.throws(() => buildIn(root, { output: link, config: configPath }), /REFUSAL/);
});

test('refuses a non-empty output directory that this generator did not write', (t) => {
  const { root, configPath } = fixture(t);
  const output = outDir('occupied');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'server.js'), '// unrelated\n');
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  assert.throws(() => buildIn(root, { output, config: configPath }), /REFUSAL/);
  assert.ok(fs.existsSync(path.join(output, 'server.js')), 'unrelated output content must not be deleted');
});

test('refuses to write the bundle into protected repository locations', () => {
  const protectedPaths = ['src', 'public', 'assets', 'server', 'scripts', 'tests', 'native', 'deploy', 'docs', 'Mega-XO-V5-Implementation-Pack', '.'];
  for (const relative of protectedPaths) {
    const absolute = path.resolve(REPO_ROOT, relative);
    assert.throws(() => builder.assertOutputLocation(absolute, REPO_ROOT), /REFUSAL/, 'must refuse ' + relative);
  }
  assert.throws(() => builder.assertOutputLocation(path.join(REPO_ROOT, 'src', 'nested'), REPO_ROOT), /REFUSAL/);
  assert.doesNotThrow(() => builder.assertOutputLocation(path.join(REPO_ROOT, 'dist', 'client'), REPO_ROOT));
  assert.doesNotThrow(() => builder.assertOutputLocation(path.join(os.tmpdir(), 'mega-v5-out'), REPO_ROOT));
});

test('refuses a font stylesheet that references an unvendored font resource', (t) => {
  const { root, write, configPath } = fixture(t);
  write('assets/vendor/fonts/google-fonts.source.css', '@font-face{font-family:"X";src:url(https://fonts.gstatic.com/s/x/v1/not-vendored.woff2) format("woff2");}');
  const output = outDir('f');
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  assert.throws(() => buildIn(root, { output, config: configPath }), /REFUSAL/);
});

test('refuses html that keeps an unapproved dependency URL', (t) => {
  const { root, write, configPath } = fixture(t);
  write('public/support.html', '<!doctype html><html><body><img src="https://tracker.example.test/pixel.gif"></body></html>');
  const config = JSON.parse(fs.readFileSync(path.join(root, configPath), 'utf8'));
  config.legal_pages.push({ source: 'public/support.html', destination: 'support.html' });
  write('native/client/tracker.config.json', JSON.stringify(config));
  const output = outDir('h');
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  assert.throws(() => buildIn(root, { output, config: 'native/client/tracker.config.json' }), /REFUSAL/);
});

test('dependencyUrls ignores XML namespaces but reports real remote references', () => {
  const html = '<svg xmlns="http://www.w3.org/2000/svg"></svg><link href="https://fonts.googleapis.com/css2">';
  assert.deepEqual(builder.dependencyUrls(html), ['https://fonts.googleapis.com/css2']);
});

test('the repository root is not a permitted output and reads no mutable state', () => {
  assert.throws(() => builder.assertOutputLocation(REPO_ROOT, REPO_ROOT), /REFUSAL/);
  // The default config path exists and is a real regular file in the repository.
  assert.ok(fs.statSync(path.resolve(REPO_ROOT, builder.DEFAULT_CONFIG)).isFile());
});


test('invalid rebuild inputs preserve the previous verified client bundle', (t) => {
  const { root, write, configPath } = fixture(t);
  const output = outDir('preserve-previous');
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const first = buildIn(root, { output, config: configPath });
  const indexPath = path.join(output, 'bundle-index.html');
  const manifestPath = path.join(output, 'client-bundle.manifest.json');
  const indexBefore = fs.readFileSync(indexPath);
  const manifestBefore = fs.readFileSync(manifestPath);

  // The original implementation deleted the prior bundle and then discovered
  // the bad remote dependency while copying this legal page.
  write('public/privacy.html', '<!doctype html><img src="https://unapproved.example.test/pixel.png">');
  assert.throws(() => buildIn(root, { output, config: configPath }), /REFUSAL/);
  assert.deepEqual(fs.readFileSync(indexPath), indexBefore);
  assert.deepEqual(fs.readFileSync(manifestPath), manifestBefore);

  // A missing source and a manifest/file collision must also fail before cleanup.
  const bad = JSON.parse(fs.readFileSync(path.join(root, configPath), 'utf8'));
  bad.client_scripts.push('src/does-not-exist.js');
  write('native/client/missing.config.json', JSON.stringify(bad));
  assert.throws(() => buildIn(root, { output, config: 'native/client/missing.config.json' }), /REFUSAL/);
  assert.deepEqual(fs.readFileSync(manifestPath), manifestBefore);
  assert.equal(first.manifest.bundle_file, 'bundle-index.html');
});


test('refuses to overwrite a bundle with unexpected, changed or linked contents', (t) => {
  const { root, configPath } = fixture(t);
  const cases = [
    {
      name: 'extra',
      mutate(output) { fs.writeFileSync(path.join(output, 'unrelated-notes.txt'), 'keep me'); },
      preserved(output) { assert.equal(fs.readFileSync(path.join(output, 'unrelated-notes.txt'), 'utf8'), 'keep me'); },
    },
    {
      name: 'changed',
      mutate(output) { fs.writeFileSync(path.join(output, 'src', 'app.js'), 'overwritten outside generator'); },
      preserved(output) { assert.equal(fs.readFileSync(path.join(output, 'src', 'app.js'), 'utf8'), 'overwritten outside generator'); },
    },
    {
      name: 'link',
      mutate(output) { fs.symlinkSync(path.join(output, 'src', 'app.js'), path.join(output, 'shortcut.js')); },
      preserved(output) { assert.ok(fs.lstatSync(path.join(output, 'shortcut.js')).isSymbolicLink()); },
    },
    {
      name: 'forged-marker',
      mutate(output) {
        const manifest = path.join(output, 'client-bundle.manifest.json');
        fs.writeFileSync(manifest, JSON.stringify({ generator: builder.GENERATOR, files: [], manifest_file: 'client-bundle.manifest.json', bundle_hash: 'fake' }));
      },
      preserved(output) { assert.ok(fs.existsSync(path.join(output, 'bundle-index.html'))); },
    },
  ];
  for (const item of cases) {
    const output = outDir(item.name);
    t.after(() => fs.rmSync(output, { recursive: true, force: true }));
    buildIn(root, { output, config: configPath });
    item.mutate(output);
    assert.throws(() => buildIn(root, { output, config: configPath }), /REFUSAL/, item.name);
    item.preserved(output);
  }
});

test('a valid generated bundle can be rebuilt in place', (t) => {
  const { root, configPath } = fixture(t);
  const output = outDir('valid-rebuild');
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const before = buildIn(root, { output, config: configPath });
  const after = buildIn(root, { output, config: configPath });
  assert.equal(after.manifest.bundle_hash, before.manifest.bundle_hash);
});
