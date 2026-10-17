'use strict';

/* Offline unit proof for the LR08 Apple Team ID association fix: the /.well-known
 * apple-app-site-association must carry the REAL team prefix when configured, and fail closed to
 * the documented TEAMID placeholder when absent or malformed — never a guessed prefix. */
const test = require('node:test');
const assert = require('node:assert/strict');

const wellKnown = require('../apps/api/routes/well-known.js');

const REAL_TEAM = 'ABCDE12345'; /* syntactically valid shape: 10 chars A-Z0-9 */

test('appleAssociationForTeam: real team id replaces the placeholder in appIDs and webcredentials', () => {
  const doc = wellKnown.appleAssociationForTeam(REAL_TEAM);
  assert.deepEqual(doc.applinks.details[0].appIDs, [REAL_TEAM + '.online.megaxo.xoxo']);
  assert.deepEqual(doc.webcredentials.apps, [REAL_TEAM + '.online.megaxo.xoxo']);
  /* Route components are preserved from the documented default. */
  assert.deepEqual(doc.applinks.details[0].components, wellKnown.DEFAULT_APPLE_ASSOCIATION.applinks.details[0].components);
});

test('appleAssociationForTeam: missing, malformed, or non-string team ids fail closed to the placeholder', () => {
  for (const bad of [undefined, null, '', 'teamid1234', 'ABC', 'ABCDEF12345!', 12345]) {
    const doc = wellKnown.appleAssociationForTeam(bad);
    assert.deepEqual(doc.applinks.details[0].appIDs, ['TEAMID.online.megaxo.xoxo'], String(typeof bad) + ' ' + String(bad));
  }
});

test('appleTeamPrefixFor: accepts exactly 10 A-Z0-9 characters', () => {
  assert.equal(wellKnown.appleTeamPrefixFor(REAL_TEAM), REAL_TEAM);
  assert.equal(wellKnown.appleTeamPrefixFor('abcde12345'), 'TEAMID', 'lowercase is not a valid Apple Team ID shape');
  assert.equal(wellKnown.appleTeamPrefixFor('ABCDE1234'), 'TEAMID', '9 chars refused');
});

test('appleAssociationForTeam: a comma-separated team list serves one appID per team (MXA-REL-002)', () => {
  const doc = wellKnown.appleAssociationForTeam('D5TQJ76T44, 6N6C9338NX');
  assert.deepEqual(doc.applinks.details[0].appIDs, ['D5TQJ76T44.online.megaxo.xoxo', '6N6C9338NX.online.megaxo.xoxo']);
  assert.deepEqual(doc.webcredentials.apps, ['D5TQJ76T44.online.megaxo.xoxo', '6N6C9338NX.online.megaxo.xoxo']);
});

test('appleAssociationForTeam: invalid entries are dropped and a fully-invalid list fails closed', () => {
  const doc = wellKnown.appleAssociationForTeam('nope, alsobad');
  assert.deepEqual(doc.applinks.details[0].appIDs, ['TEAMID.online.megaxo.xoxo']);
});

test('getAppleAppSiteAssociation: context.appleTeamId flows into the served document', async () => {
  /* Capture the written body through a minimal response stub — no socket. */
  let body = null;
  const res = {
    writeHead() {},
    end(b) { body = b; },
  };
  wellKnown.getAppleAppSiteAssociation({ appleTeamId: REAL_TEAM }, { method: 'GET' }, res);
  const doc = JSON.parse(body);
  assert.deepEqual(doc.applinks.details[0].appIDs, [REAL_TEAM + '.online.megaxo.xoxo']);
});
