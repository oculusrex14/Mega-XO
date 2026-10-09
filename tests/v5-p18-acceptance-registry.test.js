'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { TASKS, STATUS, parseSource, validate, plan, loadSource } = require('../scripts/v5/p18/acceptance-registry.js');
const markdown = loadSource(path.resolve(__dirname,'..'));

test('registry follows the actual forty frozen acceptance cases', () => {
  const matrix = parseSource(markdown);
  assert.equal(matrix.size, 40);
  assert.match(matrix.get('A01'), /Product\/source freeze/);
  assert.match(matrix.get('A39'), /Rollback classes/);
  assert.equal(validate(markdown).size, 40);
});
test('all five P18 tasks have actual evidence dimensions, none self-certified', () => {
  const planned = plan(markdown);
  assert.equal(planned.phase, 'P18');
  assert.equal(planned.executionStatus, STATUS);
  assert.equal(planned.taskCount, 5);
  assert.equal(planned.g18Accepted, false);
  assert.deepEqual(planned.tasks.map(item=>item.taskId),Object.keys(TASKS));
  for (const task of planned.tasks) {
    assert.equal(task.status, STATUS);
    assert.equal(task.passedCases.length, 0);
    assert.ok(task.caseIds.length > 1);
    assert.ok(task.requiredEvidence.length > 0);
    assert.ok(task.caseIds.every(id => /^A\d{2}$/.test(id)));
  }
});
test('phase inventory rejects missing, duplicated or reordered acceptance source cases', () => {
  assert.throws(() => validate(markdown.replace('### A39 -','### A40 -')), /P18_REGISTRY_REFUSED/);
  assert.throws(() => validate(markdown.replace('### A01 -','### A99 -')), /P18_REGISTRY_REFUSED/);
  assert.throws(() => validate('A01 A02'), /P18_REGISTRY_REFUSED/);
});
test('approved native purchases and ads require real evidence, not fixture-only signoff', () => {
  const plan18=plan(markdown);
  const economy=plan18.tasks.find(t=>t.taskId==='V5-18-03');
  const parity=plan18.tasks.find(t=>t.taskId==='V5-18-04');
  assert.ok(economy.caseIds.includes('A34') && economy.caseIds.includes('A35'));
  assert.equal(parity.evidenceLevel,'DEVICE_AND_BROWSER_STAGING');
  assert.ok(plan18.excludedScope.includes('deferred'));
});
