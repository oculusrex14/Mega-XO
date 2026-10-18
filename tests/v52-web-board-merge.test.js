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
  constructor(tagName, attributes = {}, text = '') {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this._attributes = new Map(attributes.map(([name, value]) => [name, value]));
    this.children = [];
    this.parentNode = null;
    this._text = text;
  }
  getAttribute(name) { return this._attributes.has(name) ? this._attributes.get(name) : null; }
  hasAttribute(name) { return this._attributes.has(name); }
  setAttribute(name, value) { this._attributes.set(name, String(value)); }
  removeAttribute(name) { this._attributes.delete(name); }
  get attributes() { return [...this._attributes].map(([name, value]) => ({ name, value })); }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  replaceWith(replacement) {
    if (!this.parentNode) return;
    this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1, replacement);
    replacement.parentNode = this.parentNode;
    this.parentNode = null;
  }
  get textContent() { return this.children.length === 0 ? this._text : this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.children = []; this._text = String(value); }
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
  assert.equal(mergeRenderedElement(current, next), false);
  assert.equal(current.children.length, 1);
  assert.equal(current.children[0], before, 'nothing is mutated when the merge refuses');
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
