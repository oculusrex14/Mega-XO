'use strict';
/* WebKit scroll-jump regression (production bug 2026-10-19): a per-move render must update the
 * existing board elements in place instead of destroying and recreating them. The helper is the
 * same code render() uses; a minimal DOM stub keeps the test offline and deterministic. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeElement {
  constructor(tagName, attributes = [], text = '') {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this._attributes = new Map(attributes.map(([name, value]) => [name, value]));
    this.childNodes = [];
    this.parentNode = null;
    this._text = text;
    this.open = this.hasAttribute('open');
    this.value = this.getAttribute('value') || '';
    this.type = this.getAttribute('type') || '';
    this.checked = this.hasAttribute('checked');
  }
  get children() { return this.childNodes.filter(node => node.nodeType === 1); }
  getAttribute(name) { return this._attributes.has(name) ? this._attributes.get(name) : null; }
  hasAttribute(name) { return this._attributes.has(name); }
  setAttribute(name, value) { this._attributes.set(name, String(value)); }
  removeAttribute(name) { this._attributes.delete(name); }
  get attributes() { return [...this._attributes].map(([name, value]) => ({ name, value })); }
  appendChild(child) { this.childNodes.push(child); child.parentNode = this; return child; }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
    this.parentNode = null;
  }
  replaceWith(replacement) {
    if (!this.parentNode) return;
    this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1, replacement);
    replacement.parentNode = this.parentNode;
    this.parentNode = null;
  }
  get textContent() { return this.childNodes.length === 0 ? this._text : this.childNodes.map(child => child.textContent).join(''); }
  set textContent(value) { this.childNodes = []; this._text = String(value); }
}
class FakeText {
  constructor(value) { this.nodeType = 3; this.textContent = value; this.parentNode = null; }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
    this.parentNode = null;
  }
  replaceWith(replacement) {
    if (!this.parentNode) return;
    this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1, replacement);
    replacement.parentNode = this.parentNode;
  }
}

function cell(id, player, extraClass = '') {
  const button = new FakeElement('button', [['data-gb-cell', id], ['class', `gb-cell${extraClass}`]]);
  const svg = new FakeElement('svg', [['class', 'gb-mark']]);
  svg.appendChild(new FakeElement(player === 'X' ? 'path' : 'circle', [], ''));
  button.appendChild(svg);
  return button;
}

const { mergeRenderedElement } = (() => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'apps', 'web', 'board.js'), 'utf8').replace(/^export /gm, '');
  const sandbox = {};
  vm.runInNewContext(`${source}\n;globalThis.__merge = { mergeRenderedElement };`, sandbox);
  return sandbox.__merge;
})();

test('a stable board updates cells in place, keeping the same element objects', () => {
  const current = cell('4:4', 'X');
  const next = cell('4:4', 'O', ' gb-cell--played');
  assert.equal(mergeRenderedElement(current, next), true);
  assert.equal(current.getAttribute('data-gb-cell'), '4:4');
  assert.equal(current.getAttribute('class'), 'gb-cell gb-cell--played');
  assert.equal(current.children[0].children[0].tagName, 'CIRCLE', 'the mark swaps without recreating the button');
});

test('diverged structures refuse to merge so the caller replaces that part', () => {
  const current = new FakeElement('div', []);
  current.appendChild(cell('4:4', 'X'));
  const next = new FakeElement('div', []);
  next.appendChild(cell('4:4', 'X'));
  next.appendChild(cell('0:0', 'X'));
  const before = current.children[0];
  assert.equal(mergeRenderedElement(current, next), true);
  assert.equal(current.children.length, 2);
  assert.equal(current.children[0], before, 'existing keyed board cells must remain stable when siblings appear');
});

test('a count change deep in the tree replaces only that subtree', () => {
  const actions = (buttons) => {
    const div = new FakeElement('div', [['class', 'gb-game-actions']]);
    for (const [action, label] of buttons) div.appendChild(new FakeElement('button', [['data-gb-action', action]], label));
    return div;
  };
  const current = new FakeElement('div', []);
  current.appendChild(actions([['share', 'Share game']]));
  const next = new FakeElement('div', []);
  next.appendChild(actions([['resign', 'Resign'], ['share', 'Share game']]));
  assert.equal(mergeRenderedElement(current, next), true, 'the stable parent survives');
  assert.equal(current.children[0].children.length, 2);
  assert.equal(current.children[0].children[0].getAttribute('data-gb-action'), 'resign');
});

test('identity attributes gate the merge and text-only leaves update in place', () => {
  const current = new FakeElement('p', [['data-gb-match-note', 'your move']]);
  const next = new FakeElement('p', [['data-gb-match-note', 'opponent thinking']]);
  assert.equal(mergeRenderedElement(current, next), false, 'different data identities never merge');
  const note = new FakeElement('p', []);
  const updated = new FakeElement('p', []);
  assert.equal(mergeRenderedElement(note, updated), true);
  note.textContent = 'Your move.';
  updated.textContent = 'Opponent is thinking…';
  assert.equal(mergeRenderedElement(note, updated), true);
  assert.equal(note.textContent, 'Opponent is thinking…');
});

test('turn strip and player status preserve their root and live text nodes across successive moves', () => {
  const status = new FakeElement('div', [['class', 'gb-turn-strip'], ['role', 'status'], ['aria-live', 'polite']]);
  const copy = new FakeElement('p');
  const message = new FakeText('Your move');
  copy.appendChild(message);
  status.appendChild(copy);
  const next = new FakeElement('div', [['class', 'gb-turn-strip'], ['role', 'status'], ['aria-live', 'polite']]);
  const newCopy = new FakeElement('p');
  newCopy.appendChild(new FakeText('Bot is thinking'));
  next.appendChild(newCopy);
  assert.equal(mergeRenderedElement(status, next), true);
  assert.equal(status.children[0], copy);
  assert.equal(status.children[0].childNodes[0], message);
  assert.equal(message.textContent, 'Bot is thinking');

  const players = new FakeElement('section', [['class', 'gb-game-players']]);
  const score = new FakeElement('strong', [['aria-label', '0 small boards won']]);
  score.appendChild(new FakeText('0'));
  players.appendChild(score);
  const nextPlayers = new FakeElement('section', [['class', 'gb-game-players']]);
  const nextScore = new FakeElement('strong', [['aria-label', '1 small boards won']]);
  nextScore.appendChild(new FakeText('1'));
  nextPlayers.appendChild(nextScore);
  assert.equal(mergeRenderedElement(players, nextPlayers), true);
  assert.equal(players.children[0], score);
  assert.equal(score.textContent, '1');
  assert.equal(score.getAttribute('aria-label'), '1 small boards won');
});

test('changing legal-move dots never destroys or replaces the tapped cell', () => {
  const grid = new FakeElement('div', [['class', 'gb-grid']]);
  const current = new FakeElement('button', [['data-gb-cell', '0:0'], ['class', 'gb-cell gb-cell--legal']]);
  current.appendChild(new FakeElement('span', [['class', 'gb-move-dot']]));
  grid.appendChild(current);
  const future = new FakeElement('button', [['data-gb-cell', '0:0'], ['class', 'gb-cell gb-cell--x']]);
  future.appendChild(new FakeElement('svg', [['class', 'gb-mark gb-mark--x']]));
  assert.equal(mergeRenderedElement(current, future), true);
  assert.equal(grid.children[0], current);
  assert.equal(current.children[0].tagName, 'SVG');
  const unavailable = new FakeElement('button', [['data-gb-cell', '0:0'], ['class', 'gb-cell']]);
  assert.equal(mergeRenderedElement(current, unavailable), true);
  assert.equal(grid.children[0], current);
  assert.equal(current.children.length, 0);
});

test('opened disclosure and unchanged form controls retain their live interactive state', () => {
  const current = new FakeElement('details', [['class', 'gb-powers-explainer']]);
  current.open = true;
  const next = new FakeElement('details', [['class', 'gb-powers-explainer']]);
  assert.equal(mergeRenderedElement(current, next), true);
  assert.equal(current.open, true);
  const existing = new FakeElement('select', [['data-gb-setting', 'theme']]);
  existing.value = 'cinematic';
  const upcoming = new FakeElement('select', [['data-gb-setting', 'theme']]);
  upcoming.value = 'vector';
  assert.equal(mergeRenderedElement(existing, upcoming), true);
  assert.equal(existing.value, 'vector');
});

test('render updates every stacked mobile anchor in place instead of assigning turn-strip innerHTML', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'apps', 'web', 'board.js'), 'utf8');
  assert.match(source, /'\.gb-game-players', '\.gb-turn-strip', '\.gb-match-note'/);
  assert.doesNotMatch(source, /stage\.querySelector\('\.gb-turn-strip'\)\.innerHTML\s*=/);
  assert.match(source, /if \(!mergeRenderedElement\(currentPart, nextPart\)\) currentPart\.replaceWith\(nextPart\)/);
});
