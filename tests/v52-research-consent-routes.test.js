'use strict';
/* The account-lane research-consent contract: routes, actor-from-session, and fail-closed reads.
 * 0052 implemented the consent DATA MODEL and explicitly deferred the authenticated client route to
 * this lane; these tests pin the properties that make it safe. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ROUTES = require('../packages/contracts/routes.js');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the consent routes are linked-only, CSRF-correct and accept no actor parameter', () => {
  const get = ROUTES.routeById('account.research.read');
  const post = ROUTES.routeById('account.research.write');
  assert.ok(get && post, 'both research routes must exist in the frozen contract');
  assert.equal(get.method, 'GET');
  assert.equal(get.path, '/api/account/research');
  assert.equal(get.auth, ROUTES.AUTH.LINKED, 'a read of your own choice requires a linked account');
  assert.equal(get.csrf, false, 'a GET carries no CSRF token');
  assert.equal(post.method, 'POST');
  assert.equal(post.csrf, true, 'the write is state-changing and needs CSRF');
  assert.equal(post.auth, ROUTES.AUTH.LINKED);
  // No route may take an actor id: the actor comes from the session, never the request.
  for (const route of [get, post]) {
    assert.ok(!/:actor|:id|actorId/.test(route.path), 'no actor parameter in the path: ' + route.path);
  }
});

test('the handler resolves the actor from the session and never from the body', () => {
  const source = read('apps/api/routes/account.js');
  assert.match(source, /async function getResearchConsent/);
  assert.match(source, /async function postResearchConsent/);
  // Both call resolveAuth and refuse an unauthenticated caller.
  for (const name of ['getResearchConsent', 'postResearchConsent']) {
    const body = source.slice(source.indexOf('async function ' + name));
    const end = body.indexOf('\nasync function ', 10);
    const slice = end === -1 ? body : body.slice(0, end);
    assert.match(slice, /resolveAuth\(context, req\)/, name + ' must resolve auth');
    assert.match(slice, /AUTH_REQUIRED/, name + ' must refuse an unauthenticated caller');
    assert.doesNotMatch(slice, /body\.actor|choice\.actor|req\.actor/, name + ' must not read an actor from the request');
  }
});

test('a read of an absent record is reported as NOT consented, never as a grant', () => {
  const service = read('packages/services/accounts.js');
  const api = read('apps/api/routes/account.js');
  // The SQL function must return an explicit recorded:false shape for a missing row.
  const sql = read('packages/migrations/migrations/0054_account_consent_lane.sql');
  assert.match(sql, /'recorded',false,'research',false/, 'absence must be an explicit not-consented shape');
  assert.match(sql, /\bNOT FOUND THEN/, 'there must be an explicit absent-record branch');
  // The repository must refuse a reply it cannot use rather than treating it as a grant.
  assert.match(read('packages/db/pg/accounts.js'), /CONSENT_READ_UNAVAILABLE/);
  assert.match(service, /recorded:false, research:false/, 'the service documents the absent shape');
  assert.match(api, /recorded:false/, 'the API documents the absent shape');
  // An unknown/absent body must record the fail-closed choice, not an accidental grant.
  assert.match(api, /research: choice\.research === true/);
});

test('recording an affirmative requires an adult band and is enforced in the database', () => {
  const sql = read('packages/migrations/migrations/0054_account_consent_lane.sql');
  // 0054 must delegate to 0052's record_consent, which is where the adult-only and withdrawal rules live.
  assert.match(sql, /PERFORM learning\.record_consent\(/);
  const base = read('packages/migrations/migrations/0052_research_consent_and_retention.sql');
  assert.match(base, /CAPTURE_CONSENT_ADULT_ONLY/, 'an affirmative with a non-adult band must be refused');
  assert.match(base, /withdraw_research\(actor,'user-choice'\)/, 'affirmative -> no must become a withdrawal');
  assert.match(base, /CAPTURE_CONSENT_WITHDRAWN/, 'a withdrawn subject cannot silently re-consent');
});

test('the new functions are granted to api_runtime only, and the consent lane is additive', () => {
  const sql = read('packages/migrations/migrations/0054_account_consent_lane.sql');
  assert.match(sql, /GRANT EXECUTE ON FUNCTION learning\.actor_consent\(text\),learning\.set_consent\(text,text,boolean,text,text\) TO api_runtime;/);
  assert.match(sql, /REVOKE ALL ON FUNCTION learning\.actor_consent\(text\),learning\.set_consent\(text,text,boolean,text,text\) FROM PUBLIC;/);
  // Additive: no table/column/constraint is touched and no earlier migration is altered.
  assert.doesNotMatch(sql, /ALTER TABLE/i);
  assert.doesNotMatch(sql, /DROP /i);
  assert.match(sql, /CREATE FUNCTION learning\.actor_consent/);
  assert.match(sql, /CREATE FUNCTION learning\.set_consent/);
});

test('0055 restores record_consent EXACTLY as 0052 defined it, with only the withdrawal fix', () => {
  const read52 = read('packages/migrations/migrations/0052_research_consent_and_retention.sql');
  const read53 = read('packages/migrations/migrations/0053_consent_and_export_retention_fixes.sql');
  const read55 = read('packages/migrations/migrations/0055_restore_record_consent_body.sql');

  const bodyOf = (sql) => {
    const i = sql.indexOf('CREATE FUNCTION learning.record_consent(');
    assert.ok(i !== -1, 'record_consent must be defined');
    return sql.slice(i, sql.indexOf('$$;', i));
  };

  const base = bodyOf(read52);
  const fixed = bodyOf(read55);

  /* Every argument-validation line must be identical: this is the drift that broke the lane when
     0053 reconstructed the body instead of copying it. */
  const validationLines = (text) => text.split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('IF ') && line.includes('RAISE EXCEPTION'))
    .map(line => line.replace(/\s+/g, ' '));
  assert.deepEqual(validationLines(fixed), validationLines(base),
    'the validation guards must match 0052 exactly');
  /* The band vocabularies must match - the specific defect. */
  assert.match(base, /band NOT IN \('adult','youth','unknown'\)/);
  assert.match(fixed, /band NOT IN \('adult','youth','unknown'\)/);
  assert.doesNotMatch(fixed, /'under-13'|'13-15'|'prefer-not-to-say'/,
    'the age-band vocabulary must not leak into the consent band check');
  /* The only permitted difference is the withdrawal durability fix. */
  assert.match(fixed, /withdrawn_at=CASE WHEN EXCLUDED\.optional_research THEN NULL ELSE learning\.consent\.withdrawn_at END/);
  assert.match(base, /withdrawn_at=NULL,age_band=EXCLUDED\.age_band/);
  /* And 0053 is left alone: it is already applied, so it is corrected forward-only. */
  assert.match(read53, /FUNCTION learning\.record_consent\(/);
});
