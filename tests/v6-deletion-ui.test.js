'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/community.js'), 'utf8');
function extract(start, end) {
 const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
 assert.ok(a >= 0 && b > a);
 return source.slice(a, b);
}
test('B4 account privacy renders server deadline and cancellation action only during cooling', async () => {
 const calls = [];
 let cooling = true, cancellable = true;
 const sandbox = {
  session: { profile: { providers: ['email'], emailVerified: true } }, window: {}, esc: String,
  btn: (text, action) => `<button data-c="${action}">${text}</button>`,
  API: { request: async (route) => route.endsWith('/sessions') ? { sessions: [] } : { available: true, cooling, cancellable, request: { executeAt: '2026-11-19T12:00:00Z' } } },
  frame: (...args) => calls.push(args),
 };
 vm.runInNewContext(extract('async function connections(', 'function person('), sandbox);
 await sandbox.connections();
 assert.match(calls.at(-1)[1], /cancel-deletion-form/);
 assert.match(calls.at(-1)[1], /Deletion scheduled for/);
 assert.doesNotMatch(calls.at(-1)[1], /delete-account-form/);
 cancellable = false; await sandbox.connections();
 assert.doesNotMatch(calls.at(-1)[1], /cancel-deletion-form/);
 assert.match(calls.at(-1)[1], /window has closed/);
 cooling = false; await sandbox.connections();
 assert.match(calls.at(-1)[1], /delete-account-form/);
});
test('B4 cancellation posts the typed tag and refreshes account state', async () => {
 const events = [];
 const sandbox = { $: () => ({ value: ' MEGA-12345678 ' }),
  API: { request: async (...args) => events.push(args), session: async () => ({ linked: true }) },
  connections: async () => events.push('connections'), APP: { notify: (message) => events.push(message) },
 };
 vm.runInNewContext(extract('async function cancelDeletion(', 'async function deleteAccount('), sandbox);
 await sandbox.cancelDeletion();
 assert.equal(events[0][0], '/api/account/deletion/cancel');
 assert.equal(events[0][1].confirmation, 'MEGA-12345678');
 assert.equal(events[1], 'connections');
 assert.match(events[2], /Deletion cancelled/);
});
test('B4 destructive confirmation and replacement flow promise cancellable 30-day cooling', () => {
 assert.doesNotMatch(source, /there is no in-app cancellation|account has been deleted/);
 assert.match(source, /cancel deletion in account settings before this date/);
 assert.match(source, /Schedule deletion in 30 days/);
});
