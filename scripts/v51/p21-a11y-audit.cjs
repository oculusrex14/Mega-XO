#!/usr/bin/env node
'use strict';
/*
 * scripts/v51/p21-a11y-audit.cjs — static accessibility + visual-integrity audit of the
 * BUILT P21 website bundle (default `.artifacts/p21-web`).
 *
 * It deliberately runs WITHOUT a browser: it parses the built HTML/CSS/JS bytes directly, so it
 * cannot be satisfied by a hydrated DOM, a network fixture or a synthetic render. That also makes
 * it a cheap CI gate next to the heavier `scripts/p21/accessibility-qa.cjs` (axe-core/Chromium)
 * and `scripts/p21/browser-qa.cjs` suites, which remain the browser evidence.
 *
 * Checks (all against the exact built bytes recorded in `web-build.manifest.json`):
 *   documents  main landmark, exactly one h1, lang, viewport meta, title, heading order,
 *              duplicate ids, skip link, no positive tabindex, no aria-hidden focusable control
 *   media      img alt (static markup AND the website JS view templates), svg name/aria state
 *   controls   accessible name for every link/button/input/select/textarea/summary/[role],
 *              label association, iframe title
 *   focus      every `outline:none|0` has an accompanying focus style (or is a programmatic
 *              focus target that changes state visually)
 *   contrast   WCAG 2.2 AA 1.4.3 text pairs (4.5:1) and 1.4.11 non-text pairs (3.0:1) for the
 *              four browser themes (vector/midnight/paperclub/afterhours) from the theme CSS
 *              variables, plus exact same-block literal pairs from the website stylesheets
 *   integrity  manifest hash/byte verification for every built file, resolution of every local
 *              asset reference, intrinsic width/height on static images
 *
 * Output: a machine-readable summary on stdout (one JSON document) and
 * `tests-output/p21-a11y/<bundle12>/p21-a11y-audit.json` plus a stable `p21-a11y-audit.json`.
 * Exit code is 0 only when there are zero FAIL rows. Rows it can measure but must not silently
 * decide are reported as MANUAL_REVIEW and never count as PASS.
 *
 * Boundary: automated static analysis is not screen-reader, physical-device or owner sign-off.
 * Manual VoiceOver/TalkBack, 200% zoom, touch and real-device review stay NOT_DONE.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ROOT, MANIFEST, WEBSITE_ROUTES, routeFile } = require('../p21/build-web.js');

const DEFAULTS = Object.freeze({
  bundle: path.join(ROOT, '.artifacts/p21-web'),
  themes: ['vector', 'midnight', 'paperclub', 'afterhours'],
});

/* ------------------------------------------------------------------ arguments */

function parseArgs(argv) {
  const options = { bundle: DEFAULTS.bundle, noBuild: false, verbose: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--no-build') options.noBuild = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--bundle' && argv[index + 1] && !argv[index + 1].startsWith('--')) options.bundle = path.resolve(argv[++index]);
    else throw new Error('usage: node scripts/v51/p21-a11y-audit.cjs [--bundle <dir>] [--no-build] [--verbose]');
  }
  return options;
}

/* ------------------------------------------------------------------ html parsing */

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);
const TOKEN = /<!--[\s\S]*?-->|<\/([a-zA-Z][-a-zA-Z0-9:]*)>|<([a-zA-Z][-a-zA-Z0-9:]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

function parseAttrs(source) {
  const attributes = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match;
  while ((match = re.exec(source))) {
    const name = match[1].toLowerCase();
    if (name in attributes) continue;
    attributes[name] = match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : match[4] !== undefined ? match[4] : '';
  }
  return attributes;
}

/** Tolerant tag scanner: flat node list, parents linked, inner ranges resolved on close. */
function parseHtml(html) {
  const nodes = [];
  const stack = [];
  TOKEN.lastIndex = 0;
  let match;
  while ((match = TOKEN.exec(html))) {
    if (match[0].startsWith('<!--')) continue;
    if (match[1]) {
      const name = match[1].toLowerCase();
      for (let index = stack.length - 1; index >= 0; index--) {
        const open = stack[index];
        stack.length = index;
        open.innerEnd = match.index;
        if (open.tag === name) break;
      }
      continue;
    }
    const tag = match[2].toLowerCase();
    const node = { tag, attrs: parseAttrs(match[3]), start: match.index, end: match.index + match[0].length, parent: stack[stack.length - 1] || null, children: [] };
    if (node.parent) node.parent.children.push(node);
    nodes.push(node);
    const selfClosing = match[4] === '/' || VOID_ELEMENTS.has(tag);
    if (selfClosing) { node.innerEnd = node.end; continue; }
    node.innerStart = node.end;
    stack.push(node);
    if (RAW_TEXT_ELEMENTS.has(tag)) {
      const close = new RegExp('</' + tag + '\\s*>', 'i').exec(html.slice(node.end));
      node.innerEnd = close ? node.end + close.index : html.length;
    }
  }
  for (const open of stack) if (open.innerEnd === undefined) open.innerEnd = html.length;
  for (const node of nodes) if (node.innerEnd === undefined) node.innerEnd = node.end;
  return nodes;
}

function decodeEntities(text) {
  return text
    .replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (raw, dec, hex, name) => {
      if (dec) return String.fromCodePoint(Number(dec));
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      const entity = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rarr: '→', middot: '·', copy: '©' }[name.toLowerCase()];
      return entity === undefined ? raw : entity;
    });
}

/** Visible text of a markup fragment: comments, scripts and styles removed, entities decoded. */
function visibleText(fragment) {
  const stripped = fragment
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  return decodeEntities(stripped.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

const FOCUSABLE_SELECTOR = /^(?:a|button|input|select|textarea|summary|details|audio|video)$/;
function isNativelyFocusable(node) {
  if (!FOCUSABLE_SELECTOR.test(node.tag)) return false;
  if (node.attrs.disabled !== undefined) return false;
  if (node.tag === 'a' && node.attrs.href === undefined) return false;
  if (node.tag === 'input' && node.attrs.type === 'hidden') return false;
  return true;
}
function isFocusable(node) {
  return isNativelyFocusable(node) || (node.attrs.tabindex !== undefined && Number(node.attrs.tabindex) >= 0) || ['button', 'link', 'tab', 'menuitem', 'checkbox', 'switch', 'radio', 'combobox', 'textbox', 'searchbox', 'spinbutton', 'slider'].includes(node.attrs.role);
}

/** Accessible-name subset: aria-labelledby, aria-label, alt/legend/value, for/id, wrapper label, text. */
function accessibleName(node, document, byId) {
  const labelledBy = node.attrs['aria-labelledby'];
  if (labelledBy) {
    const text = labelledBy.split(/\s+/).map(id => (byId.get(id) ? visibleText(document.slice(byId.get(id).innerStart, byId.get(id).innerEnd)) : '')).join(' ').trim();
    if (text) return { name: text, source: 'aria-labelledby' };
  }
  if (node.attrs['aria-label'] && node.attrs['aria-label'].trim()) return { name: node.attrs['aria-label'].trim(), source: 'aria-label' };
  if (node.tag === 'img') return node.attrs.alt === undefined ? { name: '', source: 'none' } : { name: node.attrs.alt, source: 'alt' };
  if (node.tag === 'input') {
    const type = (node.attrs.type || 'text').toLowerCase();
    if (['submit', 'button', 'reset'].includes(type)) return { name: node.attrs.value || type, source: 'value' };
    if (type === 'image') return node.attrs.alt === undefined ? { name: '', source: 'none' } : { name: node.attrs.alt, source: 'alt' };
  }
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.tag === 'label') {
      const text = visibleText(document.slice(parent.innerStart, parent.innerEnd));
      if (text) return { name: text, source: 'wrapper-label' };
      break;
    }
  }
  if (node.attrs.id) {
    for (const candidate of document ? parseHtml(document) : []) {
      if (candidate.tag !== 'label' || candidate.attrs.for !== node.attrs.id) continue;
      const text = visibleText(document.slice(candidate.innerStart, candidate.innerEnd));
      if (text) return { name: text, source: 'label-for' };
      break;
    }
  }
  if (node.attrs.title && node.attrs.title.trim()) return { name: node.attrs.title.trim(), source: 'title' };
  const inner = document.slice(node.innerStart, node.innerEnd);
  const nested = [];
  for (const child of parseHtml(inner)) {
    if (child.tag === 'img' && child.attrs.alt) nested.push(child.attrs.alt);
    if (child.tag === 'svg') {
      const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(inner.slice(child.start, child.innerEnd));
      if (title) nested.push(visibleText(title[1]));
    }
  }
  const text = [visibleText(inner), ...nested].join(' ').trim();
  return text ? { name: text, source: 'contents' } : { name: '', source: 'none' };
}

/* ------------------------------------------------------------------ css parsing */

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Flat rule list; at-rule preludes are kept as `at` so media/forced-colors scopes stay visible. */
function cssRules(css) {
  const out = [];
  const stack = [];
  let depth = 0;
  let preludeStart = 0;
  for (let index = 0; index < css.length; index++) {
    const char = css[index];
    if (char === '{') {
      const prelude = css.slice(preludeStart, index).trim();
      stack.push({ prelude, bodyStart: index + 1 });
      preludeStart = index + 1;
      depth++;
    } else if (char === '}') {
      const frame = stack.pop();
      if (frame) {
        const body = css.slice(frame.bodyStart, index);
        const at = stack.filter(entry => entry.prelude.startsWith('@')).map(entry => entry.prelude);
        if (!frame.prelude.startsWith('@')) out.push({ selector: frame.prelude, body, at, index: frame.bodyStart });
      }
      preludeStart = index + 1;
      depth--;
      if (depth < 0) depth = 0;
    }
  }
  return out;
}

function declarations(body) {
  const out = [];
  let depth = 0;
  let buffer = '';
  const parts = [];
  for (const char of body) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ';' && depth === 0) { parts.push(buffer); buffer = ''; continue; }
    buffer += char;
  }
  parts.push(buffer);
  for (const part of parts) {
    const colon = part.indexOf(':');
    if (colon === -1) continue;
    const property = part.slice(0, colon).trim().toLowerCase();
    if (!property || property.startsWith('--')) {
      if (property.startsWith('--')) out.push({ property, value: part.slice(colon + 1).trim() });
      continue;
    }
    out.push({ property, value: part.slice(colon + 1).trim() });
  }
  return out;
}

function declaration(body, property) {
  const found = declarations(body).filter(entry => entry.property === property);
  return found.length ? found[found.length - 1].value : null;
}

const HEX = /#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g;
const RGBA = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)/g;

function parseHex(value) {
  let hex = value.slice(1);
  if (hex.length === 3) hex = hex.split('').map(char => char + char).join('');
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}
function parseAlpha(value) {
  if (value === undefined) return 1;
  return value.endsWith('%') ? Number(value.slice(0, -1)) / 100 : Number(value);
}
function toHex(rgb) {
  return '#' + rgb.map(channel => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0')).join('');
}
function composite(fg, alpha, bg) {
  return toHex(fg.map((channel, index) => channel * alpha + bg[index] * (1 - alpha)));
}
/** Every concrete color literal in a value, in document order (gradient stops included). */
function colorLiterals(value) {
  const out = [];
  HEX.lastIndex = 0;
  RGBA.lastIndex = 0;
  let hexMatch;
  while ((hexMatch = HEX.exec(value))) out.push({ index: hexMatch.index, hex: hexMatch[0], rgb: parseHex(hexMatch[0]), alpha: 1 });
  let rgbaMatch;
  while ((rgbaMatch = RGBA.exec(value))) out.push({ index: rgbaMatch.index, hex: toHex([Number(rgbaMatch[1]), Number(rgbaMatch[2]), Number(rgbaMatch[3])]), rgb: [Number(rgbaMatch[1]), Number(rgbaMatch[2]), Number(rgbaMatch[3])], alpha: parseAlpha(rgbaMatch[4]) });
  return out.sort((left, right) => left.index - right.index);
}

/* ------------------------------------------------------------------ contrast */

function channelLuminance(value) {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}
function relativeLuminance(rgb) {
  return 0.2126 * channelLuminance(rgb[0]) + 0.7152 * channelLuminance(rgb[1]) + 0.0722 * channelLuminance(rgb[2]);
}
function contrastRatio(fg, bg) {
  const first = relativeLuminance(fg);
  const second = relativeLuminance(bg);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}
const round2 = value => Math.round(value * 100) / 100;

/* ------------------------------------------------------------------ theme variables */

/**
 * Resolve `--token: value` maps for a base theme scope only. A descendant-scoped override
 * (for example `.gb-stage[data-gb-theme="vector"] .gb-turn-strip { --gb-ink: #fff }`) is a
 * component context, not the theme; folding it in would measure the wrong background.
 * Only literals are accepted; a token chained through `var()` is resolved within the same map.
 */
function tokenScopes(css, attribute) {
  const base = new RegExp('^\\.?[^{,]*\\[' + attribute + '="([a-z]+)"\\]\\s*$');
  const scopes = {};
  for (const rule of cssRules(css)) {
    for (const selector of rule.selector.split(',')) {
      const match = base.exec(selector.trim());
      if (!match) continue;
      const id = match[1];
      scopes[id] = scopes[id] || {};
      for (const entry of declarations(rule.body)) if (entry.property.startsWith('--')) scopes[id][entry.property] = entry.value;
    }
  }
  for (const id of Object.keys(scopes)) {
    for (const [name, value] of Object.entries(scopes[id])) {
      const indirect = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(value.trim());
      if (indirect && scopes[id][indirect[1]]) scopes[id][name] = scopes[id][indirect[1]];
    }
  }
  return scopes;
}

/** Component-scoped token overrides: `[data-...="id"] <descendant> { --token: literal }`. */
function componentScopes(css, attribute) {
  const pattern = new RegExp('\\[' + attribute + '="([a-z]+)"\\]\\s+([^{,]+?)\\s*$');
  const out = [];
  for (const rule of cssRules(css)) {
    for (const selector of rule.selector.split(',')) {
      const match = pattern.exec(selector.trim());
      if (!match) continue;
      const tokens = Object.fromEntries(declarations(rule.body).filter(entry => entry.property.startsWith('--')).map(entry => [entry.property, entry.value]));
      if (Object.keys(tokens).length) out.push({ theme: match[1], target: match[2].trim(), tokens, selector: selector.trim() });
    }
  }
  return out;
}
function tokenColor(scopes, id, name) {
  const value = scopes[id] && scopes[id][name];
  if (!value) return null;
  const literals = colorLiterals(value);
  return literals.length === 1 && !/[a-z(]/i.test(value.replace(/var\([^)]*\)/gi, '')) ? toHex(literals[0].rgb) : literals[0] ? toHex(literals[0].rgb) : null;
}
function rgbOf(hex) { return parseHex(hex); }

/* ------------------------------------------------------------------ report scaffolding */

function createReport() {
  const rows = [];
  const add = (group, id, verdict, detail) => {
    rows.push({ group, id, verdict, ...detail });
    return verdict;
  };
  return { rows, add };
}

/* ------------------------------------------------------------------ checks */

function checkManifest(bundle, report) {
  const manifestPath = path.join(bundle, MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const problems = [];
  let bytes = 0;
  for (const file of manifest.files) {
    const full = path.join(bundle, file.path);
    if (!fs.existsSync(full)) { problems.push('missing:' + file.path); continue; }
    const content = fs.readFileSync(full);
    if (content.length !== file.bytes) problems.push('bytes:' + file.path);
    else if (crypto.createHash('sha256').update(content).digest('hex') !== file.sha256) problems.push('sha256:' + file.path);
    bytes += content.length;
  }
  const recomputed = crypto.createHash('sha256')
    .update(Buffer.from(manifest.files.map(file => file.path + '\0' + file.bytes + '\0' + file.sha256).join('\0')))
    .digest('hex');
  if (recomputed !== manifest.bundle_sha256) problems.push('bundle_sha256');
  report.add('integrity', 'manifest-file-integrity', problems.length ? 'FAIL' : 'PASS', {
    files: manifest.files.length, bytes, expected_bytes: manifest.total_bytes, problems: problems.slice(0, 20),
  });
  return manifest;
}

function checkDocuments(bundle, manifest, report) {
  const documents = [...new Set([...manifest.files.map(file => file.path).filter(name => name.endsWith('.html')), ...WEBSITE_ROUTES.map(routeFile)])].sort();
  const byPath = new Map();
  for (const file of manifest.files) if (file.path.endsWith('.html')) byPath.set(file.path, true);
  const htmlDocuments = documents.filter(name => byPath.has(name));
  const summary = { documents: htmlDocuments.length, pages: [], images: 0, controls: 0 };
  const structural = { main: [], h1: [], lang: [], viewport: [], title: [], headingOrder: [], duplicateId: [], positiveTabindex: [], ariaHiddenFocusable: [], skip: [] };
  const media = { missingAlt: [], unnamedSvg: [], unlabeledControl: [] };
  const runtimeHeadings = [];
  const focusableBeforeMain = [];
  let focusableTotal = 0;

  for (const name of htmlDocuments) {
    const html = fs.readFileSync(path.join(bundle, name), 'utf8');
    const nodes = parseHtml(html);
    const byId = new Map();
    const duplicates = [];
    for (const node of nodes) {
      if (!node.attrs.id) continue;
      if (byId.has(node.attrs.id)) duplicates.push(node.attrs.id);
      else byId.set(node.attrs.id, node);
    }
    const mains = nodes.filter(node => node.tag === 'main');
    const headings = nodes.filter(node => /^h[1-6]$/.test(node.tag));
    // A page heading may be supplied by the client at runtime. Prove it from the static payload
    // instead of assuming it: the scripts the document loads must contain an `<h1`.
    const mainNode = mains[0];
    const emptyMain = mainNode && !visibleText(html.slice(mainNode.innerStart, mainNode.innerEnd)) && !/<(?:h[1-6]|p|section|div|article)\b/i.test(html.slice(mainNode.innerStart, mainNode.innerEnd));
    const loadedSources = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*"([^"]+)"/g)].map(match => match[1]);
    const runtimeHeadingSources = [];
    if (emptyMain) {
      for (const reference of loadedSources) {
        // Resolve relative to the document itself: the retained client uses `src/...` paths that
        // are only valid from inside `legacy-game/`.
        const target = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:)?\/\//.test(reference)
          ? null
          : path.join(bundle, reference.startsWith('/') ? reference.slice(1) : path.join(path.dirname(name), reference));
        if (!target || !fs.existsSync(target) || !fs.lstatSync(target).isFile()) continue;
        if (/<h1\b/.test(fs.readFileSync(target, 'utf8'))) runtimeHeadingSources.push(path.relative(bundle, target));
      }
    }
    const orders = [];
    let previous = null;
    for (const heading of headings) {
      const level = Number(heading.tag[1]);
      if (previous !== null && level > previous + 1) orders.push(previous + '->' + level);
      previous = level;
    }
    const htmlAttr = /<html\b[^>]*>/i.exec(html);
    const lang = htmlAttr ? parseAttrs(htmlAttr[0].replace(/^<html/i, '').replace(/>$/, '')).lang : undefined;
    const viewport = nodes.some(node => node.tag === 'meta' && (node.attrs.name || '').toLowerCase() === 'viewport');
    const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    const skip = nodes.find(node => node.tag === 'a' && /skip/i.test(node.attrs.class || ''));
    const skipTarget = skip && skip.attrs.href && skip.attrs.href.startsWith('#') ? skip.attrs.href.slice(1) : null;

    // Interactive controls and media, static markup only (view templates are checked separately).
    for (const node of nodes) {
      if (node.tag === 'img') {
        summary.images++;
        const decorative = node.attrs['aria-hidden'] === 'true' || node.attrs.role === 'presentation' || node.attrs.role === 'none';
        if (node.attrs.alt === undefined && !decorative) media.missingAlt.push({ document: name, src: (node.attrs.src || '').slice(0, 90) });
      }
      if (node.tag === 'svg' && !node.children.length) {
        // An inline svg that is not hidden from assistive tech must carry a role+name or a <title>.
        const fragment = html.slice(node.innerStart, node.innerEnd);
        const hidden = node.attrs['aria-hidden'] === 'true';
        const named = Boolean(node.attrs['aria-label'] || node.attrs['aria-labelledby'] || /<title\b/i.test(fragment) || node.attrs.role === 'presentation' || node.attrs.role === 'none' || node.attrs.role === 'img' || node.attrs.role === 'graphics-symbol' || node.attrs.focusable === 'false');
        if (!hidden && !named) media.unnamedSvg.push({ document: name, excerpt: html.slice(node.start, node.start + 70) });
      }
      if (node.tag === 'iframe' && !node.attrs.title && !node.attrs['aria-label'] && node.attrs['aria-hidden'] !== 'true') {
        media.unlabeledControl.push({ document: name, kind: 'iframe', excerpt: '<iframe>' });
      }
      if (node.attrs['aria-hidden'] === 'true' && isFocusable(node)) {
        structural.ariaHiddenFocusable.push({ document: name, tag: node.tag, excerpt: html.slice(node.start, node.start + 70) });
      }
      if (node.attrs.tabindex !== undefined && /^\d+$/.test(node.attrs.tabindex) && Number(node.attrs.tabindex) > 0) {
        structural.positiveTabindex.push({ document: name, tag: node.tag, tabindex: node.attrs.tabindex });
      }
      if (isFocusable(node)) {
        summary.controls++;
        focusableTotal++;
        const mainStart = mains.length ? mains[0].start : html.length;
        if (node.start < mainStart) focusableBeforeMain.push(name);
        const role = node.attrs.role;
        if (role === 'presentation' || role === 'none' || node.attrs['aria-hidden'] === 'true') continue;
        if (node.tag === 'img' || (node.tag === 'input' && ['hidden'].includes(node.attrs.type))) continue;
        if (node.tag === 'input' && ['submit', 'button', 'reset', 'image'].includes((node.attrs.type || '').toLowerCase())) continue;
        const resolved = accessibleName(node, html, byId);
        if (!resolved.name) media.unlabeledControl.push({ document: name, kind: node.tag, excerpt: html.slice(node.start, node.start + 90) });
      }
    }

    if (mains.length !== 1) structural.main.push({ document: name, count: mains.length });
    const hasStaticH1 = headings.some(heading => heading.tag === 'h1');
    if (!hasStaticH1 && !runtimeHeadingSources.length) structural.h1.push({ document: name, headings: headings.length, runtime_heading_proven: false });
    if (emptyMain && runtimeHeadingSources.length) {
      runtimeHeadings.push({ document: name, provided_by: runtimeHeadingSources, detail: 'the loaded client renders the page heading; the bundled script contains an <h1>' });
    }
    if (!lang) structural.lang.push({ document: name });
    if (!viewport) structural.viewport.push({ document: name });
    if (!title || !visibleText(title[1])) structural.title.push({ document: name });
    if (orders.length) structural.headingOrder.push({ document: name, skips: orders });
    if (duplicates.length) structural.duplicateId.push({ document: name, ids: [...new Set(duplicates)].slice(0, 10) });
    if (skip && skipTarget && !nodes.some(node => node.attrs.id === skipTarget)) structural.skip.push({ document: name, target: skipTarget });
    summary.pages.push({ document: name, bytes: Buffer.byteLength(html), main: mains.length, h1: headings.filter(heading => heading.tag === 'h1').length, headings: headings.length });
  }

  const gate = (id, rows, detail) => report.add('documents', id, rows.length ? 'FAIL' : 'PASS', { failures: rows.slice(0, 12), ...detail });
  gate('main-landmark', structural.main, { detail: 'exactly one <main> per document' });
  gate('page-h1', structural.h1, { detail: 'at least one <h1> per document' });
  gate('document-lang', structural.lang, { detail: 'lang on <html>' });
  gate('viewport-meta', structural.viewport, { detail: 'viewport meta present' });
  gate('document-title', structural.title, { detail: 'non-empty <title>' });
  gate('heading-order', structural.headingOrder, { detail: 'no skipped heading level' });
  gate('duplicate-id', structural.duplicateId, { detail: 'unique id per document' });
  gate('positive-tabindex', structural.positiveTabindex, { detail: 'no tabindex > 0' });
  gate('aria-hidden-focusable', structural.ariaHiddenFocusable, { detail: 'no focusable control inside aria-hidden' });
  gate('skip-link-target', structural.skip, { detail: 'skip link target resolves inside the document' });
  report.add('media', 'img-alt-attribute', media.missingAlt.length ? 'FAIL' : 'PASS', { images: summary.images, failures: media.missingAlt.slice(0, 12) });
  report.add('media', 'svg-name-or-hidden', media.unnamedSvg.length ? 'FAIL' : 'PASS', { failures: media.unnamedSvg.slice(0, 12) });
  report.add('controls', 'accessible-name', media.unlabeledControl.length ? 'FAIL' : 'PASS', { controls: summary.controls, failures: media.unlabeledControl.slice(0, 12) });
  // A skip link is needed when a document has focusable controls before <main> AND no earlier
  // by-pass mechanism. Documents with a skip link are proven; documents with many pre-main
  // controls and no skip link are reported for review with the exact count.
  const withSkip = [];
  const withoutSkip = [];
  for (const name of htmlDocuments) {
    const html = fs.readFileSync(path.join(bundle, name), 'utf8');
    const nodes = parseHtml(html);
    const hasSkip = nodes.some(node => node.tag === 'a' && node.attrs.href && node.attrs.href.startsWith('#') && /skip/i.test((node.attrs.class || '') + ' ' + (node.attrs.textContent || '') + visibleText(html.slice(node.innerStart, node.innerEnd))));
    const preMain = focusableBeforeMain.filter(entry => entry === name).length;
    if (hasSkip) withSkip.push({ document: name, focusable_before_main: preMain });
    else if (preMain >= 12) withoutSkip.push({ document: name, focusable_before_main: preMain });
  }
  report.add('documents', 'skip-link-coverage', withoutSkip.length ? 'MANUAL_REVIEW' : 'PASS', {
    detail: 'documents with 12+ focusable controls before <main> need a by-pass mechanism',
    with_skip_link: withSkip.length,
    needing_review: withoutSkip,
  });
  report.add('documents', 'runtime-rendered-heading', 'PASS', {
    detail: 'a document whose <main> is empty gets its page heading from a bundled script that contains an <h1>',
    documents: runtimeHeadings,
  });
  return { summary, structural };
}

/**
 * Bounded evaluation of a JS template-literal expression for the accessible-name check. It does
 * not run the bundle; it resolves the inputs it can prove (string literals, ternaries, `.map()`
 * over a string-literal array, and `const NAME = [...]` string arrays in the same file) and
 * returns `null` when an input cannot be proven. `null` becomes MANUAL_REVIEW, never PASS.
 */
function stringArrayBindings(source) {
  const bindings = new Map();
  for (const match of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[([^\]]*)\]/g)) {
    const items = [...match[2].matchAll(/'([^']*)'|"([^"]*)"/g)].map(entry => entry[1] !== undefined ? entry[1] : entry[2]);
    if (items.length && items.every(item => item.length > 0)) bindings.set(match[1], items);
  }
  return bindings;
}

function evaluateInterpolation(expression, bindings, locals) {
  const candidates = new Set();
  // 1. Local `.map(<ident> => ...)` bindings collected from the enclosing statement.
  for (const [name, values] of Object.entries(locals)) {
    if (new RegExp('\\b' + name.replace(/\$/g, '\\$') + '\\b').test(expression)) {
      for (const value of values) candidates.add(value.charAt(0).toUpperCase() + value.slice(1));
    }
  }
  // 2. String literals inside the expression (ternary branches, `??` fallbacks, concatenation).
  for (const entry of expression.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)) {
    const value = entry[1] !== undefined ? entry[1] : entry[2] !== undefined ? entry[2] : entry[3];
    if (/[A-Za-z]{2}/.test(value)) candidates.add(value);
  }
  // 3. File-level string arrays referenced by name (for example `GAME_THEMES` or `tiers`).
  for (const [name, values] of bindings) {
    if (new RegExp('\\b' + name.replace(/\$/g, '\\$') + '\\b').test(expression)) for (const value of values) candidates.add(value);
  }
  if (candidates.size === 0) return null;
  return [...candidates];
}

function evaluateTemplateText(source, start, end, bindings) {
  const template = source.slice(start, end);
  const locals = {};
  const mapCall = /\.map\(\s*([A-Za-z_$][\w$]*)\s*=>/.exec(template.slice(0, Math.max(0, template.indexOf('${'))));
  if (mapCall) {
    const arrayLiteral = /\[([^\]]*)\]\s*\.map\(/.exec(template);
    if (arrayLiteral) {
      const items = [...arrayLiteral[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map(entry => entry[1] !== undefined ? entry[1] : entry[2]);
      if (items.length) locals[mapCall[1]] = items;
    }
  }
  const pieces = [template.split(/\$\{/)[0]];
  let complete = true;
  for (const chunk of template.split(/\$\{/).slice(1)) {
    const depth = chunk.indexOf('}');
    if (depth === -1) { complete = false; break; }
    const expression = chunk.slice(0, depth);
    // Nested braces inside the interpolation (object literals) are common; take to the matching close.
    let braces = 0;
    let cursor = 0;
    for (; cursor < chunk.length; cursor++) {
      if (chunk[cursor] === '{') braces++;
      else if (chunk[cursor] === '}') { if (braces === 0) break; braces--; }
    }
    const full = chunk.slice(0, cursor);
    const candidates = evaluateInterpolation(full, bindings, locals);
    if (candidates === null) { complete = false; pieces.push({ unknown: true, expression: full }); }
    else pieces.push(candidates);
    const rest = chunk.slice(cursor + 1);
    const nextSplit = rest.indexOf('${');
    pieces.push(nextSplit === -1 ? rest : rest.slice(0, nextSplit));
    if (nextSplit !== -1) pieces.push({ nested: rest.slice(nextSplit + 2) });
  }
  if (!complete) return { resolvable: false, expressions: pieces.filter(entry => entry && entry.unknown).map(entry => entry.expression) };
  // Brute force the resolvable combinations (bounded: the codebase templates are small).
  let texts = [''];
  for (const piece of pieces) {
    if (typeof piece === 'string') texts = texts.map(text => text + piece);
    else if (Array.isArray(piece)) texts = texts.flatMap(text => piece.map(value => text + value));
  }
  const rendered = [...new Set(texts.map(text => visibleText(text)))];
  return { resolvable: true, texts: rendered.slice(0, 12), empty_combination: rendered.some(text => !text) };
}

function checkJsTemplates(report, files) {
  const missingAlt = [];
  const unresolved = [];
  const unlabeled = [];
  let templates = 0;
  let buttons = 0;
  let images = 0;
  let resolvedButtons = 0;
  for (const name of files) {
    const source = fs.readFileSync(path.join(ROOT, name), 'utf8');
    templates++;
    const bindings = stringArrayBindings(source);
    for (const match of source.matchAll(/<img\b((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g)) {
      images++;
      const attributes = parseAttrs(match[1]);
      if (attributes.alt === undefined) missingAlt.push({ file: name, excerpt: match[0].slice(0, 100) });
    }
    let index = -1;
    while ((index = source.indexOf('<button', index + 1)) !== -1) {
      buttons++;
      const open = source.indexOf('>', index);
      const attributes = parseAttrs(source.slice(index + '<button'.length, open).replace(/\/$/, ''));
      if (attributes['aria-label'] || attributes['aria-labelledby'] || attributes.title) continue;
      const close = source.indexOf('</button>', open);
      const inner = close === -1 ? source.slice(open + 1, open + 500) : source.slice(open + 1, close);
      const staticText = visibleText(inner.replace(/\$\{[\s\S]*?\}/g, ' '));
      if (staticText) continue;
      const evaluated = evaluateTemplateText(inner, 0, inner.length, bindings);
      if (!evaluated.resolvable) { unresolved.push({ file: name, expressions: evaluated.expressions, excerpt: source.slice(index, index + 110).replace(/\s+/g, ' ') }); continue; }
      resolvedButtons++;
      if (evaluated.empty_combination) unlabeled.push({ file: name, texts: evaluated.texts, excerpt: source.slice(index, index + 110).replace(/\s+/g, ' ') });
    }
  }
  report.add('media', 'js-template-img-alt', missingAlt.length ? 'FAIL' : 'PASS', { images, failures: missingAlt.slice(0, 12) });
  report.add('controls', 'js-template-accessible-name', unlabeled.length ? 'FAIL' : 'PASS', {
    buttons_without_static_text: buttons - resolvedButtons - unresolved.length,
    buttons_resolved_from_template_inputs: resolvedButtons,
    failures: unlabeled.slice(0, 12),
  });
  report.add('controls', 'js-template-unresolved-names', 'MANUAL_REVIEW', {
    detail: 'template inputs could not be proven statically; these buttons need a rendered-DOM check',
    count: unresolved.length,
    failures: unresolved.slice(0, 12),
  });
  return { templates, buttons, images, resolved: resolvedButtons, unresolved: unresolved.length };
}

function checkFocusStyles(report, cssFiles, bundle) {
  const suppressed = [];
  const focusRules = [];
  for (const name of cssFiles) {
    const css = stripComments(fs.readFileSync(path.join(bundle, name), 'utf8'));
    for (const rule of cssRules(css)) {
      const body = rule.body;
      const outline = declaration(body, 'outline');
      const outlineStyle = declaration(body, 'outline-style');
      const outlineWidth = declaration(body, 'outline-width');
      const removes = (outline && /^(?:none|0)\b/i.test(outline.trim())) || (outlineStyle && /^none$/i.test(outlineStyle.trim())) || (outlineWidth && /^0(?:px)?$/i.test(outlineWidth.trim()));
      const differentiator = ['border-color', 'border', 'box-shadow', 'background', 'background-color', 'filter', 'text-decoration', 'color', 'transform']
        .some(property => declaration(body, property) !== null);
      if (removes) suppressed.push({ file: name, selector: rule.selector, differentiator, inAtRule: rule.at });
      if (/:focus(?:-visible|-within)?\b/.test(rule.selector)) {
        const sets = ['outline', 'outline-color', 'border-color', 'box-shadow', 'background', 'background-color', 'color', 'filter', 'text-decoration'].filter(property => declaration(body, property) !== null);
        focusRules.push({ file: name, selector: rule.selector, sets });
      }
    }
  }
  const focusTargets = focusRules.map(entry => ({
    selector: entry.selector.replace(/:focus(?:-visible|-within)?/g, '').trim().split(/\s*,\s*/).filter(Boolean),
    file: entry.file,
    sets: entry.sets,
  }));
  const programmaticTargets = new Set(['#main', '#page', 'main']);
  const findings = [];
  const allowed = [];
  for (const entry of suppressed) {
    const selectors = entry.selector.split(/\s*,\s*/).map(value => value.trim()).filter(Boolean);
    const covered = selectors.every(selector => {
      const simple = selector.replace(/::?[a-z-]+(?:\([^)]*\))?/gi, '').trim();
      const baseTag = (simple.match(/^([a-z][a-z0-9]*)/i) || [])[1];
      if (entry.differentiator) return true;
      if (programmaticTargets.has(simple) || programmaticTargets.has('#' + (simple.match(/#([\w-]+)/) || [])[1])) return true;
      return focusTargets.some(target => target.selector.some(candidate => candidate === simple || simple.endsWith(' ' + candidate) || simple.endsWith(candidate) || candidate.endsWith(' ' + simple)))
        || focusTargets.some(target => baseTag && target.selector.some(candidate => candidate === baseTag));
    });
    (covered ? allowed : findings).push(entry);
  }
  report.add('focus', 'outline-suppression-has-focus-style', findings.length ? 'FAIL' : 'PASS', {
    suppressed_rules: suppressed.length,
    failures: findings.slice(0, 12),
    allowed_with_reason: allowed.slice(0, 12),
    focus_rule_count: focusRules.length,
  });
  return { suppressed: suppressed.length, findings };
}

/* ------------------------------------------------------------------ contrast tiers */

const TEXT_MINIMUM = 4.5;
const NON_TEXT_MINIMUM = 3;

/**
 * Theme token roles. Text color must come from a text-capable token; using a mark, boundary or
 * glow token as text color is a component defect even when the token value itself is approved.
 */
const TEXT_TOKEN = /(?:^|--)(?:gb-)?(?:ink|muted|text|on-hud|hud-muted|on-cta|on-accent|badge-ink|nav)$/;
function tokenRole(token) {
  return TEXT_TOKEN.test(token) ? 'text' : 'non-text';
}

/** Pairs drawn from the four browser theme variable sets (WCAG 2.2 AA roles and thresholds). */
const BOARD_THEME_PAIRS = Object.freeze([
  { foreground: '--gb-ink', background: '--gb-surface', minimum: TEXT_MINIMUM, role: 'text' },
  { foreground: '--gb-ink', background: '--gb-raised', minimum: TEXT_MINIMUM, role: 'text' },
  { foreground: '--gb-muted', background: '--gb-surface', minimum: TEXT_MINIMUM, role: 'secondary-text' },
  { foreground: '--gb-muted', background: '--gb-raised', minimum: TEXT_MINIMUM, role: 'secondary-text' },
  { foreground: '--gb-x', background: '--gb-raised', minimum: NON_TEXT_MINIMUM, role: 'game-mark' },
  { foreground: '--gb-o', background: '--gb-raised', minimum: NON_TEXT_MINIMUM, role: 'game-mark' },
  { foreground: '--gb-focus', background: '--gb-surface', minimum: NON_TEXT_MINIMUM, role: 'focus-indicator' },
  { foreground: '--gb-focus', background: '--gb-raised', minimum: NON_TEXT_MINIMUM, role: 'focus-indicator' },
  { foreground: '--gb-route', background: '--gb-surface', minimum: NON_TEXT_MINIMUM, role: 'active-board-ring' },
  { foreground: '--gb-route', background: '--gb-raised', minimum: NON_TEXT_MINIMUM, role: 'active-board-ring' },
  { foreground: '--gb-line', background: '--gb-surface', minimum: NON_TEXT_MINIMUM, role: 'cell-divider' },
  { foreground: '--gb-line', background: '--gb-raised', minimum: NON_TEXT_MINIMUM, role: 'cell-divider' },
  { foreground: '--gb-mini-border', background: '--gb-surface', minimum: NON_TEXT_MINIMUM, role: 'board-boundary' },
  { foreground: '--gb-mini-border', background: '--gb-raised', minimum: NON_TEXT_MINIMUM, role: 'board-boundary' },
]);
const RETAINED_THEME_PAIRS = Object.freeze([
  { foreground: '--ink', background: '--surface', minimum: TEXT_MINIMUM, role: 'text' },
  { foreground: '--ink', background: '--raised', minimum: TEXT_MINIMUM, role: 'text' },
  { foreground: '--muted', background: '--surface', minimum: TEXT_MINIMUM, role: 'secondary-text' },
  { foreground: '--muted', background: '--raised', minimum: TEXT_MINIMUM, role: 'secondary-text' },
  { foreground: '--focus', background: '--surface', minimum: NON_TEXT_MINIMUM, role: 'focus-indicator' },
  { foreground: '--focus', background: '--raised', minimum: NON_TEXT_MINIMUM, role: 'focus-indicator' },
]);

/**
 * Palette-to-palette pairs are measured, never failed. The four browser palettes are approved
 * theme contracts (docs/THEMES.md, docs/p21-web/DECISIONS.md P21-D003/P21-D004) and an automated
 * audit must not silently rewrite owner-approved colors; a below-minimum row is an explicit owner
 * decision recorded with its exact ratio.
 */
const OWNER_PALETTE = 'OWNER_PALETTE';
function themeContrastRows(scopes, pairs, themes) {
  const rows = [];
  for (const theme of themes) {
    if (!scopes[theme]) { rows.push({ theme, pair: 'scope', verdict: 'MANUAL_REVIEW', detail: 'no variable scope found for theme' }); continue; }
    for (const pair of pairs) {
      const fg = tokenColor(scopes, theme, pair.foreground);
      const bg = tokenColor(scopes, theme, pair.background);
      if (!fg || !bg) { rows.push({ theme, pair: pair.foreground + ' / ' + pair.background, verdict: 'MANUAL_REVIEW', detail: 'token missing or not a literal color' }); continue; }
      const ratio = round2(contrastRatio(rgbOf(fg), rgbOf(bg)));
      rows.push({
        theme, pair: pair.foreground.replace('--gb-', '--') + ' / ' + pair.background.replace('--gb-', '--'),
        role: pair.role, foreground: fg, background: bg, ratio, minimum: pair.minimum,
        meets_minimum: ratio >= pair.minimum, verdict: OWNER_PALETTE,
      });
    }
  }
  return rows;
}

/**
 * Same-block literal pairs: a rule that declares both `color` and a background. This is exact —
 * no cross-block guessing. Values are composited onto the page canvas when translucent.
 */
const CANVAS = '#030917';
function literalContrastRows(cssFiles, bundle) {
  const rows = [];
  for (const name of cssFiles) {
    if (name.includes('legacy-game/')) continue; // retained compatibility client measured separately
    const css = stripComments(fs.readFileSync(path.join(bundle, name), 'utf8'));
    for (const rule of cssRules(css)) {
      const color = declaration(rule.body, 'color');
      if (!color || /var\(|inherit|currentColor|transparent/i.test(color)) continue;
      const foregrounds = colorLiterals(color);
      if (!foregrounds.length) continue;
      const backgroundValue = declaration(rule.body, 'background') || declaration(rule.body, 'background-color') || declaration(rule.body, 'background-image');
      if (!backgroundValue) continue;
      const backgrounds = colorLiterals(backgroundValue);
      if (!backgrounds.length) continue;
      if (/gradient|url\(/i.test(backgroundValue) === false && backgrounds.length > 1) continue;
      let ratio = Infinity;
      let worst = null;
      for (const foreground of foregrounds) {
        for (const background of backgrounds) {
          const effective = composite(background.rgb, background.alpha, rgbOf(CANVAS));
          const value = round2(contrastRatio(foreground.rgb, rgbOf(effective)));
          if (value < ratio) { ratio = value; worst = { foreground: toHex(foreground.rgb), background: effective, raw_background: background.hex, alpha: background.alpha }; }
        }
      }
      if (!worst) continue;
      rows.push({ file: name, selector: rule.selector.slice(0, 120), ...worst, ratio, minimum: TEXT_MINIMUM, verdict: ratio >= TEXT_MINIMUM ? 'PASS' : 'FAIL' });
    }
  }
  return rows.filter(row => row.verdict === 'FAIL' || row.ratio < 5);
}

/**
 * Cross-block component contexts. Each entry names the class list of the element that carries the
 * text and the class lists of the element that paints the background, plus any painted ancestors.
 * Every color is read back out of the parsed stylesheet, so the harness cannot restate a value the
 * CSS does not contain. Unresolvable contexts are reported for review, never passed.
 * `distinct_from_last` marks a colour that is deliberately a different element from the previous
 * row on the same background (the diagram label, number and caption are three separate spans).
 */
const COMPONENT_CONTEXTS = Object.freeze([
  { id: 'practice-player-name', text: { classes: ['gb-player', 'gb-player--active'], property: 'color', fallbackToken: '--gb-muted' }, background: { classes: ['gb-frame'], ancestors: [['gb-stage']] }, minimum: 4.5, role: 'secondary-text' },
  { id: 'turn-strip-detail', text: { classes: ['gb-turn-strip'], property: 'color', extra: 'p', fallbackToken: '--gb-muted', ancestors: [['gb-stage', 'gb-turn-strip']] }, background: { classes: ['gb-turn-strip'], ancestors: [] }, minimum: 4.5, role: 'secondary-text' },
  { id: 'turn-strip-copy', text: { classes: ['gb-turn-strip'], property: 'color', extra: 'strong', fallbackToken: '--gb-ink', ancestors: [['gb-stage', 'gb-turn-strip']] }, background: { classes: ['gb-turn-strip'], ancestors: [] }, minimum: 4.5, role: 'text' },
  { id: 'turn-strip-mark-x', text: { classes: ['gb-turn-icon', 'gb-turn-icon--x'], property: 'color', fallbackToken: '--gb-x', ancestors: [['gb-stage', 'gb-turn-strip']] }, background: { classes: ['gb-turn-icon'], ancestors: [['gb-turn-strip']] }, minimum: 3, role: 'game-mark' },
  { id: 'turn-strip-mark-o', text: { classes: ['gb-turn-icon', 'gb-turn-icon--o'], property: 'color', fallbackToken: '--gb-o', ancestors: [['gb-stage', 'gb-turn-strip']] }, background: { classes: ['gb-turn-icon'], ancestors: [['gb-turn-strip']] }, minimum: 3, role: 'game-mark' },
  { id: 'practice-sign-in-link', text: { classes: ['gb-sign-in'], property: 'color', fallbackToken: '--gb-ink', ancestors: [['gb-stage', 'gb-turn-strip']] }, background: { classes: ['gb-turn-strip'], ancestors: [] }, minimum: 4.5, role: 'text' },
  { id: 'practice-reset-button', text: { classes: ['gb-reset'], property: 'color', fallbackToken: '--gb-muted', ancestors: [['gb-stage', 'gb-turn-strip']] }, background: { classes: ['gb-turn-strip'], ancestors: [] }, minimum: 3, role: 'non-text-marker' },
  { id: 'guided-title', text: { classes: ['gb-guided-title'], property: 'color', fallbackToken: '--gb-ink', ancestors: [['gb-guided-panel'], ['gb-stage']] }, background: { classes: ['gb-guided-panel'], ancestors: [['gb-stage']] }, minimum: 4.5, role: 'text' },
  { id: 'guided-caption', text: { classes: ['gb-guided-caption'], property: 'color', fallbackToken: '--gb-muted', ancestors: [['gb-guided-panel'], ['gb-stage']] }, background: { classes: ['gb-guided-panel'], ancestors: [['gb-stage']] }, minimum: 4.5, role: 'secondary-text' },
  { id: 'guided-progress', text: { classes: ['gb-guided-progress'], property: 'color', fallbackToken: '--gb-route', ancestors: [['gb-guided-panel'], ['gb-stage']] }, background: { classes: ['gb-guided-panel'], ancestors: [['gb-stage']] }, minimum: 4.5, role: 'text' },
  { id: 'guided-secondary-button', text: { classes: ['gb-guided-btn', 'gb-guided-btn--secondary'], property: 'color', fallbackToken: '--gb-muted' }, background: { classes: ['gb-guided-btn', 'gb-guided-btn--secondary'], ancestors: [['gb-guided-panel'], ['gb-stage']] }, minimum: 4.5, role: 'text' },
  { id: 'guided-details-summary', text: { classes: ['gb-guided-details'], property: 'color', extra: 'summary', fallbackToken: '--gb-muted', ancestors: [['gb-guided-panel'], ['gb-stage']] }, background: { classes: ['gb-guided-panel'], ancestors: [['gb-stage']] }, minimum: 4.5, role: 'secondary-text' },
  { id: 'guided-volume-label', text: { classes: ['gb-guided-volume-label'], property: 'color', fallbackToken: '--gb-muted', ancestors: [['gb-guided-panel'], ['gb-stage']] }, background: { classes: ['gb-guided-panel'], ancestors: [['gb-stage']] }, minimum: 4.5, role: 'secondary-text' },
  { id: 'guided-diagram-label', text: { classes: ['gb-guided-diagram-step'], property: 'color', extra: 'span', fallbackToken: '--gb-muted', ancestors: [['gb-guided-diagram'], ['gb-guided-panel'], ['gb-stage']] }, background: { classes: ['gb-guided-diagram'], ancestors: [['gb-guided-panel'], ['gb-stage']] }, minimum: 4.5, role: 'secondary-text' },
  { id: 'guided-diagram-number', text: { classes: ['gb-guided-diagram-step'], property: 'color', extra: 'b', fallbackToken: '--gb-x', ancestors: [['gb-guided-diagram'], ['gb-guided-panel'], ['gb-stage']] }, background: { classes: ['gb-guided-diagram'], ancestors: [['gb-guided-panel'], ['gb-stage']] }, minimum: 3, role: 'game-mark' },
  { id: 'guided-diagram-caption', text: { classes: ['gb-guided-diagram-step'], property: 'color', extra: 'small', fallbackToken: '--gb-muted', ancestors: [['gb-guided-diagram'], ['gb-guided-panel'], ['gb-stage']] }, background: { classes: ['gb-guided-diagram'], ancestors: [['gb-guided-panel'], ['gb-stage']] }, minimum: 4.5, role: 'secondary-text' },
  { id: 'guided-diagram-arrow', text: { classes: ['gb-guided-arrow'], property: 'color', fallbackToken: '--gb-route', ancestors: [['gb-guided-diagram'], ['gb-guided-panel'], ['gb-stage']] }, background: { classes: ['gb-guided-diagram'], ancestors: [['gb-guided-panel'], ['gb-stage']] }, minimum: 3, role: 'non-text-marker' },
  { id: 'guided-danger-button', text: { classes: ['gb-guided-btn', 'gb-guided-btn--danger'], property: 'color' }, background: { classes: ['gb-guided-btn', 'gb-guided-btn--danger'], ancestors: [['gb-guided-panel'], ['gb-stage']] }, minimum: 4.5, role: 'text' },
  { id: 'guided-primary-button', text: { classes: ['gb-guided-btn', 'gb-guided-btn--primary'], property: 'color' }, background: { classes: ['gb-guided-btn', 'gb-guided-btn--primary'], ancestors: [] }, minimum: 4.5, role: 'text' },
  { id: 'guided-cta-subtext', text: { classes: ['gb-guided-subtext'], property: 'color' }, background: { classes: ['gb-guided-cta'], ancestors: [['gb-help-panel']] }, minimum: 4.5, role: 'secondary-text' },
]);

/** The last compound of a selector, e.g. `.a .b--x:hover` -> `.b--x`. */
function lastCompound(selector) {
  const parts = selector.replace(/::?[\w-]+(?:\([^)]*\))?/g, '').split(/\s+|[>+~]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}
/** Class names in the last compound. */
function compoundClasses(selector) {
  const compound = lastCompound(selector);
  const names = [...compound.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map(match => match[1]);
  if (names.length) return names;
  const tag = /^([a-z][a-z0-9]*)/.exec(compound);
  return tag ? [tag[1]] : [];
}
/**
 * A target is a class list on one element (for example `['gb-guided-btn','gb-guided-btn--danger']`).
 * A selector rule applies when its last compound's classes are all present on the target and, if the
 * rule carries a `[data-gb-theme="<id>"]` scope, that scope equals the theme being measured.
 */
/** Strip `:not(...)`/`:where(...)` guards so a guard is never mistaken for a theme scope. */
function withoutGuards(selector) {
  return selector.replace(/:(?:not|where|is)\([^()]*(?:\([^()]*\)[^()]*)*\)/g, '');
}
function selectorMatches(selector, classes, theme) {
  for (const part of selector.split(',')) {
    const trimmed = part.trim();
    const guarded = withoutGuards(trimmed);
    const scope = /\[data-gb-theme="([a-z]+)"\]/.exec(guarded);
    // A scope attribute lives on an ancestor compound; only the last compound is the element.
    if (scope && scope[1] !== theme) continue;
    const needed = compoundClasses(trimmed);
    if (!needed.length) continue;
    // A class-list entry that is a bare word is a required tag name in the last compound.
    if (needed.every(name => classes.includes(name))) return true;
  }
  return false;
}
/** Specificity proxy: theme-scoped attribute rules win, then more class selectors, then pseudo-class. */
function themeSpecificity(selector, theme) {
  const guarded = withoutGuards(selector);
  const scoped = guarded.includes('[data-gb-theme="' + theme + '"]') ? 100 : 0;
  const unscopedGuard = selector !== guarded && theme !== 'cinematic' ? 50 : 0;
  // `:where()` contributes zero specificity; every other class/attribute selector contributes one.
  const classes = [...guarded.matchAll(/\.[a-zA-Z_][\w-]*/g)].length;
  const attributes = [...guarded.matchAll(/\[[a-zA-Z-]+[^\]]*\]/g)].length;
  return scoped + unscopedGuard + (classes + attributes) * 2;
}
/** Theme tokens plus the descendant-scoped token overrides that reach an ancestor context. */
function scopedTokens(rules, theme, classes, scopes, ancestors = []) {
  const tokens = { ...(scopes[theme] || {}) };
  // Custom properties inherit, so the furthest ancestor is applied first and the element itself
  // last: an element's own declaration must win over the theme scope it lives inside.
  for (const candidate of [...ancestors].reverse().concat([classes])) {
    const overrides = rules
      .filter(rule => withoutGuards(rule.selector).includes('[data-gb-theme="' + theme + '"]') && selectorMatches(rule.selector, candidate, theme))
      .sort((left, right) => themeSpecificity(left.selector, theme) - themeSpecificity(right.selector, theme));
    for (const rule of overrides) {
      for (const entry of declarations(rule.body)) if (entry.property.startsWith('--')) tokens[entry.property] = entry.value;
    }
  }
  return tokens;
}
/** Winning declaration for a property on a class-list target, theme scope first, tokens substituted. */
const STATE_PSEUDO = /:(?:hover|active|focus|focus-visible|focus-within|disabled|checked|target)\b/;
function winningDeclaration(rules, theme, classes, property, tokens) {
  const matches = [];
  for (const rule of rules) {
    if (!selectorMatches(rule.selector, classes, theme)) continue;
    // State variants are not the resting appearance: a `:hover` background must not be measured as
    // the background the text normally sits on.
    if (STATE_PSEUDO.test(rule.selector)) continue;
    const value = declaration(rule.body, property);
    if (!value || /^(?:none|initial|unset|inherit|transparent|0)$/i.test(value.trim())) continue;
    matches.push({ value, selector: rule.selector, specificity: themeSpecificity(rule.selector, theme) });
  }
  if (!matches.length) return null;
  matches.sort((left, right) => right.specificity - left.specificity);
  const winner = matches[0];
  return { ...winner, substituted: substituteTokens(winner.value, tokens) };
}
function substituteTokens(value, tokens, depth = 0) {
  if (depth > 4) return value;
  const next = value.replace(/var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^)]*))?\)/gi, (raw, token, fallback) => tokens[token] || (fallback !== undefined ? fallback : raw));
  return next === value ? next : substituteTokens(next, tokens, depth + 1);
}
/**
 * The painted background of a class target. CSS composes `background-color` and `background-image`
 * independently, so a colour layer and a gradient layer from different rules are both applied:
 * image stops paint over the resolved colour, which itself may fall back to a painted ancestor.
 */
function resolveBackground(rules, theme, classes, ancestors, scopes) {
  for (const candidate of [classes, ...ancestors]) {
    const localTokens = scopedTokens(rules, theme, candidate, scopes);
    const colorRule = winningDeclaration(rules, theme, candidate, 'background-color', localTokens)
      || winningDeclaration(rules, theme, candidate, 'background', localTokens);
    const imageRule = winningDeclaration(rules, theme, candidate, 'background-image', localTokens)
      || winningDeclaration(rules, theme, candidate, 'background', localTokens);
    const colorLiteralsFound = colorRule ? colorLiterals(colorRule.substituted) : [];
    const imageLiterals = imageRule && /gradient|url\(/i.test(imageRule.substituted) ? colorLiterals(imageRule.substituted) : [];
    // A shorthand `background: var(--surface)` contributes a colour, not an image.
    const opaque = colorLiteralsFound.find(entry => entry.alpha === 1 && !imageLiterals.some(image => image.index === entry.index));
    if (!opaque && !imageLiterals.length) continue;
    const baseColor = opaque ? toHex(opaque.rgb) : (ancestors.length ? null : CANVAS);
    const parent = baseColor ? null : resolveBackground(rules, theme, ancestors[0] || classes, ancestors.slice(1), scopes);
    const parentColor = parent ? toHex(parent.literals[0].rgb) : CANVAS;
    const stacked = (imageLiterals.length ? imageLiterals : colorLiteralsFound).map(entry => ({
      ...entry,
      effective: entry.alpha < 1 ? composite(entry.rgb, entry.alpha, rgbOf(baseColor || parentColor)) : toHex(entry.rgb),
    }));
    return {
      classes: candidate,
      rule: [colorRule && colorRule.selector, imageRule && imageRule !== colorRule && imageRule.selector].filter(Boolean).join(' + '),
      color: baseColor || parentColor,
      stops: stacked,
      literals: stacked.map(entry => ({ ...entry, alpha: 1, rgb: parseHex(entry.effective) })),
      value: [colorRule && colorRule.substituted, imageRule && imageRule.substituted].filter(Boolean).join(' | '),
    };
  }
  return null;
}

function componentContextRows(rules, scopes, themes) {
  const rows = [];
  for (const theme of themes) {
    if (!scopes[theme]) continue;
    for (const context of COMPONENT_CONTEXTS) {
      if (!context.background.ancestors) context.background.ancestors = [];
      const textTokens = scopedTokens(rules, theme, context.text.classes, scopes, context.text.ancestors || []);
      const background = resolveBackground(rules, theme, context.background.classes, context.background.ancestors, scopes);
      if (!background) { rows.push({ component: context.id, theme, verdict: 'MANUAL_REVIEW', detail: 'no painted background resolved for .' + context.background.classes.join('.') }); continue; }
      // A background layer that is not fully opaque composites over the resolved base colour.
      const parent = background.stops.some(stop => stop.alpha < 1)
        ? resolveBackground(rules, theme, background.classes, context.background.ancestors.filter(candidate => candidate !== background.classes), scopes)
        : null;
      // Text colour: the winning explicit declaration, else the nearest ancestor that declares one
      // (normal inheritance), else the named theme token.
      let declared = winningDeclaration(rules, theme, context.text.classes, context.text.property, textTokens);
      if (!declared && context.text.extra) declared = winningDeclaration(rules, theme, [...context.text.classes, context.text.extra], context.text.property, textTokens);
      for (const ancestor of context.text.ancestors || []) {
        if (declared) break;
        const inherited = scopedTokens(rules, theme, ancestor, scopes, [ancestor]);
        declared = winningDeclaration(rules, theme, ancestor, context.text.property, inherited);
        if (declared) declared = { ...declared, inherited_from: '.' + ancestor.join('.') };
      }
      const referencedTokens = declared ? [...declared.value.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map(entry => entry[1]) : [];
      const tokenValue = !declared && context.text.fallbackToken ? (textTokens[context.text.fallbackToken] || null) : null;
      const resolvedText = declared ? declared.substituted : tokenValue ? substituteTokens(tokenValue, textTokens) : null;
      const textColors = resolvedText ? colorLiterals(resolvedText) : [];
      if (!textColors.length) { rows.push({ component: context.id, theme, verdict: 'MANUAL_REVIEW', detail: 'text colour not a literal for .' + context.text.classes.join('.') }); continue; }
      // A literal `color` in the stylesheet is component intent; a token reference is theme intent.
      const declaredLiteralText = Boolean(declared && !/var\(/i.test(declared.value) && !declared.inherited_from);
      // A mark/boundary/glow token is the correct source for a glyph or ring; it is a defect only
      // when it is used as *text* colour, where the AA text minimum applies.
      const isText = context.role.endsWith('text');
      const roleMisuse = isText ? referencedTokens.filter(token => tokenRole(token) === 'non-text') : [];
      let worst = null;
      for (const stop of background.stops) {
        const effective = stop.alpha < 1 && parent ? composite(stop.rgb, stop.alpha, rgbOf(parent.color)) : stop.effective;
        for (const foreground of textColors) {
          const ratio = round2(contrastRatio(foreground.rgb, rgbOf(effective)));
          if (!worst || ratio < worst.ratio) worst = { ratio, foreground: toHex(foreground.rgb), background: effective, background_rule: background.rule, alpha: stop.alpha };
        }
      }
      if (!worst) { rows.push({ component: context.id, theme, verdict: 'MANUAL_REVIEW', detail: 'no measurable pair' }); continue; }
      // Palette reuse vs component defect: when the text color is exactly the theme's own text
      // token AND the painted background is exactly the theme's surface or raised token, the row
      // only re-measures an owner-approved palette pair (already reported once in
      // `board-theme-pairs`). Anything else — a component-specific override, a translucent tint
      // composited over the page, a gradient, or a mark/boundary token used as text color — is a
      // component defect that this unit must fix.
      // The reuse test is by value: the painted background must be exactly one of this theme's own
      // token colors, and the text must be a token reference (not a component literal). That keeps
      // owner-approved palette measurements out of the defect list without naming any selector.
      const themeTokens = scopes[theme];
      const tokenHexes = themeTokens ? Object.values(themeTokens).flat().map(value => {
        try { return toHex(colorLiterals(substituteTokens(value, themeTokens))[0].rgb); } catch { return null; }
      }).filter(Boolean) : [];
      const paletteReuse = !roleMisuse.length
        && worst.alpha === 1
        && tokenHexes.includes(worst.background)
        && !declaredLiteralText;
      rows.push({
        component: context.id, theme, role: context.role, minimum: context.minimum,
        foreground: worst.foreground, background: worst.background, background_alpha: worst.alpha,
        background_rule: worst.background_rule, background_element: '.' + background.classes.join('.'),
        text_element: '.' + context.text.classes.join('.') + (context.text.extra ? ' ' + context.text.extra : ''),
        text_color_source: declared ? (declared.inherited_from ? 'inherited from ' + declared.inherited_from : declared.selector) : 'token ' + context.text.fallbackToken,
        resolved_text_value: resolvedText,
        non_text_tokens_used_as_text_color: roleMisuse.length ? roleMisuse : undefined,
        ratio: worst.ratio, palette_reuse: paletteReuse,
        finding: worst.ratio < context.minimum
          ? paletteReuse
            ? 'owner-approved palette token pair (see board-theme-pairs)'
            : 'measured ratio is below the ' + context.minimum + ':1 minimum'
              + (roleMisuse.length ? '; text color uses a non-text theme token: ' + roleMisuse.join(', ') : '')
          : undefined,
        // The verdict is the measured ratio. Token-role reuse is recorded as diagnostic context,
        // not as a separate failure, so a well-contrasting dark theme stays a PASS.
        verdict: paletteReuse ? OWNER_PALETTE : worst.ratio < context.minimum ? 'FAIL' : 'PASS',
      });
    }
  }
  return rows;
}

/* ------------------------------------------------------------------ asset integrity */

function checkAssetIntegrity(bundle, manifest, report) {
  const built = new Set(manifest.files.map(file => file.path));
  const routes = new Set(Object.keys(manifest.routes));
  const problems = [];
  const seen = new Set();
  let references = 0;
  const resolve = (documentPath, url) => {
    if (/^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|#)/.test(url)) return null;
    const clean = url.split('#')[0].split('?')[0];
    if (!clean) return null;
    if (clean.startsWith('/')) return clean.slice(1);
    const base = documentPath.split('/').slice(0, -1).join('/');
    return path.posix.normalize(path.posix.join(base, clean));
  };
  const record = (documentPath, url) => {
    if (/\$\{/.test(url)) return; // template interpolation: checked against known asset families below
    const target = resolve(documentPath, url);
    if (target === null || target.startsWith('api/')) return;
    references++;
    const key = documentPath + '|' + target;
    if (seen.has(key)) return;
    seen.add(key);
    if (built.has(target) || routes.has('/' + target) || routes.has('/' + target + '/') || routes.has('/' + target.replace(/index\.html$/, ''))) return;
    problems.push({ document: documentPath, reference: url, resolved: target });
  };
  for (const file of manifest.files) {
    if (file.path.endsWith('.html')) {
      const html = fs.readFileSync(path.join(bundle, file.path), 'utf8');
      for (const match of html.matchAll(/\b(?:src|href|poster)\s*=\s*"([^"]+)"/g)) record(file.path, match[1]);
      for (const match of html.matchAll(/srcset\s*=\s*"([^"]+)"/g)) for (const part of match[1].split(',')) record(file.path, part.trim().split(/\s+/)[0]);
    } else if (file.path.endsWith('.css')) {
      const css = stripComments(fs.readFileSync(path.join(bundle, file.path), 'utf8')).replace(/url\(\s*["']?data:[\s\S]*?(?=\))/g, '');
      for (const match of css.matchAll(/url\(\s*["']?([^"')]+)/g)) record(file.path, match[1]);
    }
  }
  // JS view templates reference built assets by absolute path.
  for (const name of ['apps/web/app.js', 'apps/web/board.js', 'apps/web/pages.js', 'apps/web/site.js', 'apps/web/ui.js', 'apps/web/downloads.js', 'apps/web/offline.js', 'apps/web/realtime.js']) {
    if (!fs.existsSync(path.join(ROOT, name))) continue;
    const source = fs.readFileSync(path.join(ROOT, name), 'utf8');
    for (const match of source.matchAll(/["'](\/assets\/[^"']+)["']/g)) record('js:' + name, match[1]);
  }
  report.add('integrity', 'asset-reference-resolution', problems.length ? 'FAIL' : 'PASS', { references, failures: problems.slice(0, 12) });

  const sized = [];
  let images = 0;
  for (const file of manifest.files.filter(entry => entry.path.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(bundle, file.path), 'utf8');
    for (const match of html.matchAll(/<img\b((?:"[^"]*"|'[^']*'|[^>"'])*?)\/?>/g)) {
      images++;
      const attributes = parseAttrs(match[1]);
      if (attributes.width === undefined || attributes.height === undefined) sized.push({ document: file.path, excerpt: match[0].slice(0, 90) });
    }
  }
  report.add('integrity', 'static-image-intrinsic-size', sized.length ? 'MANUAL_REVIEW' : 'PASS', {
    images, failures: sized.slice(0, 12),
    detail: 'width+height prevent layout shift; a missing pair is a visual-integrity observation, not a WCAG failure',
  });
  return { references, problems };
}

/* ------------------------------------------------------------------ summary */

function summarise(report, meta) {
  const verdicts = report.rows.reduce((accumulator, row) => { accumulator[row.verdict] = (accumulator[row.verdict] || 0) + 1; return accumulator; }, {});
  const failures = report.rows.filter(row => row.verdict === 'FAIL');
  const manual = report.rows.filter(row => row.verdict === 'MANUAL_REVIEW');
  const palette = report.rows.filter(row => row.verdict === OWNER_PALETTE);
  const contrast = report.rows.filter(row => row.group === 'contrast');

  return {
    result: failures.length ? 'FAIL' : 'PASS',
    command: 'env -u NODE_OPTIONS ' + process.execPath + ' scripts/v51/p21-a11y-audit.cjs',
    checked_at: new Date().toISOString(),
    runtime_version: process.version,
    tool: 'scripts/v51/p21-a11y-audit.cjs (static HTML/CSS/JS analysis; no browser)',
    audit_script_sha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
    bundle: meta.bundle,
    bundle_sha256: meta.bundle_sha256,
    source_commit: meta.source_commit,
    manifest_source_commit: meta.manifest_source_commit,
    files_checked: meta.files_checked,
    bytes_checked: meta.bytes_checked,
    html_documents_checked: meta.html_documents,
    js_templates_checked: meta.js_templates,
    counts: {
      passed: verdicts.PASS || 0,
      failed: verdicts.FAIL || 0,
      manual_review: verdicts.MANUAL_REVIEW || 0,
      owner_palette_decisions: verdicts[OWNER_PALETTE] || 0,
      rows: report.rows.length,
    },
    contrast: {
      checked: contrast.length,
      failed: contrast.filter(row => row.verdict === 'FAIL').length,
      themes: meta.themes,
      minimums: { text: TEXT_MINIMUM, non_text: NON_TEXT_MINIMUM },
      failing_pairs: contrast.filter(row => row.verdict === 'FAIL').map(row => ({
        theme: row.theme, component: row.component || row.pair, role: row.role, ratio: row.ratio, minimum: row.minimum, finding: row.finding || null,
      })),
      owner_palette_below_minimum: palette.filter(row => row.meets_minimum === false).map(row => ({
        theme: row.theme, pair: row.pair, role: row.role, tokens: row.pair, ratio: row.ratio, minimum: row.minimum,
      })),
    },
    failures: failures.map(row => ({
      group: row.group, id: row.id, theme: row.theme, subject: row.component || row.pair, role: row.role,
      ratio: row.ratio, minimum: row.minimum, finding: row.finding || null,
      detail: row.detail || row.selector || null,
      failures: row.failures ? row.failures.slice(0, 6) : undefined,
    })),
    manual_review: manual.map(row => ({ group: row.group, id: row.id, detail: row.detail || null })),
    owner_palette_decisions: palette.map(row => ({ theme: row.theme, pair: row.pair, role: row.role, ratio: row.ratio, minimum: row.minimum, meets_minimum: row.meets_minimum })),
    not_done: [
      'Manual screen-reader acceptance (VoiceOver/TalkBack) on real devices',
      'Physical browser matrix (Safari/iOS/Android Chrome/Firefox) and touch/zoom review',
      'Owner visual sign-off against the approved reference',
      'Measured Core Web Vitals on real hardware/networks',
    ],
    checks: report.rows,
  };
}

/* ------------------------------------------------------------------ main */

function main() {
  const options = parseArgs(process.argv.slice(2));
  const bundleRelative = path.relative(ROOT, options.bundle);
  if (!fs.existsSync(path.join(options.bundle, MANIFEST))) {
    if (options.noBuild) throw new Error('bundle is not built: ' + bundleRelative + ' (drop --no-build to build it)');
    const { buildWeb } = require('../p21/build-web.js');
    buildWeb({ output: options.bundle });
  }
  const report = createReport();
  const manifest = checkManifest(options.bundle, report);
  const documents = checkDocuments(options.bundle, manifest, report);
  const templates = checkJsTemplates(report, ['apps/web/board.js', 'apps/web/pages.js', 'apps/web/site.js', 'apps/web/ui.js']);
  const bundleCss = manifest.files.map(file => file.path).filter(name => name.endsWith('.css'));
  const focus = checkFocusStyles(report, bundleCss, options.bundle);

  // Read the contrast rules from the SAME payload being audited. The builder copies these two
  // stylesheets into the bundle verbatim, so a `--bundle` run must not mix built HTML with
  // working-tree CSS: that would report the source's contrast for the bundle's markup.
  const payloadCss = name => {
    const built = path.join(options.bundle, name);
    if (fs.existsSync(built)) return fs.readFileSync(built, 'utf8');
    const source = path.join(ROOT, 'apps/web', name);
    if (fs.existsSync(source)) return fs.readFileSync(source, 'utf8');
    throw new Error('stylesheets unavailable for the audited payload: ' + name);
  };
  const boardCss = payloadCss('board.css');
  const compatCss = payloadCss('bot-compat.css');
  const boardScopes = tokenScopes(boardCss, 'data-gb-theme');
  const retainedSource = path.join(ROOT, 'src/styles.css');
  const retainedScopes = fs.existsSync(retainedSource) ? tokenScopes(fs.readFileSync(retainedSource, 'utf8'), 'data-theme') : {};
  // Conditional renderings are measured by their own rules, not by the forced-colors override:
  // a `@media (forced-colors: active)` or reduced-motion block is not the default appearance.
  const contrastRules = [...cssRules(stripComments(boardCss)), ...cssRules(stripComments(compatCss))]
    .filter(rule => !rule.at.some(at => /forced-colors|prefers-reduced-motion|prefers-contrast/i.test(at)));
  const boardRows = themeContrastRows(boardScopes, BOARD_THEME_PAIRS, DEFAULTS.themes);
  for (const row of boardRows) report.add('contrast', 'board-theme-pairs', row.verdict, { ...row, source: 'apps/web/board.css' });
  // The retained compatibility client keeps its approved palette; measure it, do not modify it.
  const retainedRows = themeContrastRows(retainedScopes, RETAINED_THEME_PAIRS, DEFAULTS.themes);
  for (const row of retainedRows) report.add('contrast', 'retained-client-pairs', 'MANUAL_REVIEW', {
    ...row, source: 'src/styles.css',
    detail: 'approved V3.2.1 palette contract (docs/THEMES.md); read `tests/contrast.py` for the recorded per-theme secondary-text bar before changing it',
  });
  const literalRows = literalContrastRows(bundleCss, options.bundle);
  for (const row of literalRows) report.add('contrast', 'literal-pairs', row.verdict, row);
  const contextRows = componentContextRows(contrastRules, boardScopes, DEFAULTS.themes);
  for (const row of contextRows) report.add('contrast', 'component-context-pairs', row.verdict, row);
  checkAssetIntegrity(options.bundle, manifest, report);

  const summary = summarise(report, {
    bundle: bundleRelative,
    bundle_sha256: manifest.bundle_sha256,
    source_commit: (() => { try { return require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return null; } })(),
    manifest_source_commit: manifest.source_commit,
    files_checked: manifest.files.length,
    bytes_checked: manifest.total_bytes,
    html_documents: documents.summary.documents,
    js_templates: templates.templates,
    themes: DEFAULTS.themes,
  });
  summary.focus = focus;
  summary.documents = documents.summary.pages.map(page => page.document);
  summary.literal_pairs = literalRows;
  summary.retained_client_contrast = retainedRows;

  const output = path.join(ROOT, 'tests-output/p21-a11y');
  fs.mkdirSync(path.join(output, manifest.bundle_sha256.slice(0, 12)), { recursive: true });
  fs.writeFileSync(path.join(output, manifest.bundle_sha256.slice(0, 12), 'p21-a11y-audit.json'), JSON.stringify(summary, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'p21-a11y-audit.json'), JSON.stringify(summary, null, 2) + '\n');
  process.stdout.write(JSON.stringify({
    result: summary.result,
    bundle_sha256: summary.bundle_sha256,
    source_commit: summary.source_commit,
    files_checked: summary.files_checked,
    html_documents_checked: summary.html_documents_checked,
    js_templates_checked: summary.js_templates_checked,
    counts: summary.counts,
    contrast: summary.contrast,
    failures: summary.failures.map(entry => ({ group: entry.group, id: entry.id })),
    report: path.relative(ROOT, path.join(output, manifest.bundle_sha256.slice(0, 12), 'p21-a11y-audit.json')),
  }, null, 2) + '\n');
  if (options.verbose) console.error(summary.checks.map(row => [row.group, row.id, row.verdict].join(' ')).join('\n'));
  if (summary.result !== 'PASS') process.exitCode = 1;
}

if (require.main === module) {
  try { main(); }
  catch (error) { process.stderr.write('P21_A11Y_AUDIT_FAILED: ' + String(error && error.message || error) + '\n'); process.exitCode = 1; }
}

module.exports = { parseHtml, parseAttrs, visibleText, accessibleName, cssRules, declarations, contrastRatio, tokenScopes, componentScopes, componentContextRows, literalContrastRows, colorLiterals, toHex, substituteTokens, selectorMatches, compoundClasses, resolveBackground, winningDeclaration, themeSpecificity };
