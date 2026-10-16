'use strict';

/* Offline render proof for the LR17 research-consent card: the notice explains necessary operations
 * and optional research SEPARATELY, research is never preselected, the adult-band gate is enforced
 * client-side with a clear note, a recorded choice renders its state with change/withdraw controls,
 * and no player-controlled string reaches the DOM unescaped. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let card = null;
test.before(async () => {
  card = (await import(pathToFileURL(path.join(__dirname, '..', 'apps', 'web', 'consent.js')).href)).researchConsentCard;
});

test('no state renders nothing (guest, loading, or fetch failure)', () => {
  assert.equal(card({}), '');
  assert.equal(card({ researchConsent: null }), '');
});

test('unrecorded: two-part notice, explicit actions, adult default, no preselected grant', () => {
  const html = card({ researchConsent: { recorded: false, research: false } });
  assert.match(html, /Needed to operate the game:/);
  assert.match(html, /Optional research, a separate choice:/);
  assert.match(html, /research-allow/);
  assert.match(html, /research-decline/);
  assert.match(html, /value="adult" selected/);
  assert.doesNotMatch(html, /checked/);
  assert.match(html, /only available to adult accounts/);
});

test('recorded allowed: status + change control, no re-consent form', () => {
  const html = card({ researchConsent: { recorded: true, research: true, withdrawn: false } });
  assert.match(html, /Optional research is allowed/);
  assert.match(html, /research-edit/);
  assert.doesNotMatch(html, /research-allow/);
});

test('recorded declined or withdrawn: status + change control', () => {
  for (const state of [{ recorded: true, research: false }, { recorded: true, research: true, withdrawn: true }]) {
    const html = card({ researchConsent: state });
    assert.match(html, /Optional research is not allowed/);
    assert.match(html, /research-edit/);
  }
});

test('edit reopen renders the form prefilled with the recorded band', () => {
  const html = card({ researchConsent: { recorded: true, research: true, ageBand: 'adult' }, researchOpen: true });
  assert.match(html, /value="adult" selected/);
});

test('messages and injected strings are escaped', () => {
  const html = card({ researchConsent: { recorded: false }, researchMessage: '<script>alert(1)</script>' });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

test('busy disables every control', () => {
  const html = card({ researchConsent: { recorded: false }, researchBusy: true });
  for (const match of html.matchAll(/<button[^>]*>/g)) assert.match(match[0], / disabled/);
  assert.match(html, /<select id="research-age-band" disabled/);
});
