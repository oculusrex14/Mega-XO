'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const data = import(pathToFileURL(path.join(__dirname, '../apps/web/data.js')).href);
const pages = import(pathToFileURL(path.join(__dirname, '../apps/web/pages.js')).href);
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function profile(overrides = {}) {
  return {
    id: 'actor-one', username: 'old_name', displayName: 'Old Name', name: 'Old Name', avatar: 'rook',
    statsVisibility: 'friends', presenceVisibility: 'hidden', tag: 'MEGA-ABCD', tier: 'wood', rating: 1200,
    wallet: { coins: 123, crowns: 4 }, ...overrides,
  };
}

async function fixture(request, active = () => true) {
  const { createProfileEditor } = await data;
  const context = { profile: profile(), sessionStatus: 'linked' };
  const changes = [];
  const editor = createProfileEditor({ context, request, active, changed: () => changes.push(context.profileEditor.status) });
  return { context, editor, changes };
}

test('profile editor loads protected fields and POSTs only the approved editable fields', async () => {
  const calls = [];
  let stored = profile();
  const ui = await fixture(async (url, body) => {
    calls.push({ url, body });
    if (url === '/api/account/profile' && body === undefined) return { ...stored };
    if (url === '/api/account/profile') {
      stored = { ...stored, username: body.username, displayName: body.displayName, name: body.displayName,
        statsVisibility: body.statsVisibility, presenceVisibility: body.presenceVisibility };
      return { ...stored };
    }
    throw Error('UNEXPECTED_ROUTE');
  });

  assert.equal(await ui.editor.load(), true);
  assert.equal(ui.context.profileEditor.status, 'ready');
  assert.equal(calls[0].url, '/api/account/profile');
  assert.equal(calls[0].body, undefined);
  assert.equal(await ui.editor.save({ username: ' New_Player ', displayName: ' New Display ', statsVisibility: 'private', presenceVisibility: 'friends' }), true);

  assert.deepEqual(calls[1].body, {
    username: 'new_player', displayName: 'New Display', statsVisibility: 'private', presenceVisibility: 'friends',
  });
  assert.deepEqual(Object.keys(calls[1].body).sort(), ['displayName', 'presenceVisibility', 'statsVisibility', 'username']);
  assert.equal(ui.context.profileEditor.status, 'saved');
  assert.equal(ui.context.profileEditor.message, 'Your profile changes are saved.');
  assert.deepEqual(ui.context.profile.wallet, { coins: 123, crowns: 4 });
  assert.equal(ui.context.profile.tag, 'MEGA-ABCD');
  assert.equal(ui.context.profile.rating, 1200);
  assert.equal(ui.context.profile.avatar, 'rook');
  assert.equal(ui.context.profile.username, 'new_player');
  assert.equal(ui.context.profile.displayName, 'New Display');
});

test('validation failure keeps the submitted draft for correction and a successful retry', async () => {
  let writes = 0;
  const ui = await fixture(async (_url, body) => {
    if (body === undefined) return profile();
    if (++writes === 1) throw Error('USERNAME_TAKEN');
    return profile({ username: body.username, displayName: body.displayName, name: body.displayName,
      statsVisibility: body.statsVisibility, presenceVisibility: body.presenceVisibility });
  });

  await ui.editor.load();
  const entered = { username: 'taken_name', displayName: 'Saved Later', statsVisibility: 'private', presenceVisibility: 'hidden' };
  assert.equal(await ui.editor.save(entered), false);
  assert.equal(ui.context.profileEditor.status, 'error');
  assert.equal(ui.context.profileEditor.errorCode, 'USERNAME_TAKEN');
  assert.match(ui.context.profileEditor.message, /already in use/);
  assert.deepEqual(ui.context.profileEditor.draft, entered);

  const corrected = { ...entered, username: 'available_name' };
  assert.equal(await ui.editor.save(corrected), true);
  assert.equal(writes, 2);
  assert.equal(ui.context.profileEditor.status, 'saved');
  assert.equal(ui.context.profileEditor.draft.username, 'available_name');
});

test('matching actor id alone cannot make an incomplete save response look successful', async () => {
  const ui = await fixture(async (_url, body) => body === undefined ? profile() : { id: 'actor-one', username: body.username });
  await ui.editor.load();
  const draft = { username: 'new_name', displayName: 'New Name', statsVisibility: 'private', presenceVisibility: 'friends' };
  assert.equal(await ui.editor.save(draft), false);
  assert.equal(ui.context.profileEditor.status, 'error');
  assert.equal(ui.context.profileEditor.errorCode, 'SERVICE_UNAVAILABLE');
  assert.deepEqual(ui.context.profileEditor.draft, draft);
  assert.equal(ui.context.profile.username, 'old_name');
});

test('old actor save reply is fenced after the signed-in actor changes', async () => {
  const saveReply = deferred();
  let actorTwo = false;
  const ui = await fixture(async (_url, body) => {
    if (body === undefined) return actorTwo ? profile({ id: 'actor-two', username: 'second_user', displayName: 'Second', name: 'Second' }) : profile();
    return saveReply.promise;
  });

  await ui.editor.load();
  const pendingSave = ui.editor.save({ username: 'old_actor_edit', displayName: 'Old Actor', statsVisibility: 'private', presenceVisibility: 'hidden' });
  actorTwo = true;
  ui.context.profile = profile({ id: 'actor-two', username: 'second_user', displayName: 'Second', name: 'Second' });
  assert.equal(await ui.editor.load(), true);
  saveReply.resolve(profile({ username: 'old_actor_edit', displayName: 'Old Actor', name: 'Old Actor', statsVisibility: 'private' }));
  assert.equal(await pendingSave, false);
  assert.equal(ui.context.profile.id, 'actor-two');
  assert.equal(ui.context.profileEditor.actorId, 'actor-two');
  assert.equal(ui.context.profileEditor.profile.id, 'actor-two');
  assert.equal(ui.context.profileEditor.status, 'ready');
});

test('a delayed old-actor AUTH_REQUIRED cannot retire the newly linked actor', async () => {
  const oldReply = deferred();
  const { createProfileEditor } = await data;
  const context = { profile: profile(), sessionStatus: 'linked' };
  let reads = 0, authLosses = 0;
  const editor = createProfileEditor({
    context,
    active: actor => context.sessionStatus === 'linked' && context.profile?.id === actor,
    request: async (_url, body) => {
      if (body !== undefined) throw Error('UNEXPECTED_WRITE');
      if (++reads === 1) return oldReply.promise;
      return profile({ id: 'actor-two', username: 'second_user', displayName: 'Second', name: 'Second' });
    },
    onAuthRequired: () => { authLosses++; context.sessionStatus = 'guest'; context.profile = null; },
  });

  const oldLoad = editor.load();
  context.profile = profile({ id: 'actor-two', username: 'second_user', displayName: 'Second', name: 'Second' });
  const newLoad = editor.load();
  assert.equal(await newLoad, true);
  oldReply.reject(Error('AUTH_REQUIRED'));
  assert.equal(await oldLoad, false);
  assert.equal(authLosses, 0);
  assert.equal(context.sessionStatus, 'linked');
  assert.equal(context.profile.id, 'actor-two');
  assert.equal(context.profileEditor.actorId, 'actor-two');
});

test('only a current AUTH_REQUIRED retires the session for profile reads and saves', async () => {
  const { createProfileEditor } = await data;
  for (const failingOperation of ['load', 'save']) {
    const context = { profile: profile(), sessionStatus: 'linked' };
    const authLosses = [];
    let editor;
    editor = createProfileEditor({
      context,
      active: actor => context.sessionStatus === 'linked' && context.profile?.id === actor,
      request: async (_url, body) => {
        if (body === undefined && failingOperation === 'save') return profile();
        throw Error('AUTH_REQUIRED');
      },
      onAuthRequired: (_error, operation) => {
        authLosses.push(operation.operation);
        context.profile = null;context.sessionStatus = 'guest';editor.deactivate();
      },
    });

    if (failingOperation === 'load') assert.equal(await editor.load(), false);
    else {
      await editor.load();
      assert.equal(await editor.save({ username: 'old_name', displayName: 'Old Name', statsVisibility: 'friends', presenceVisibility: 'hidden' }), false);
    }
    assert.deepEqual(authLosses, [failingOperation]);
    assert.equal(context.sessionStatus, 'guest');
    assert.equal(context.profileEditor.status, 'idle');
  }
});

test('same-actor focus refresh freezes writes and preserves the memory-only draft until protected refresh succeeds', async () => {
  let reads = 0;
  const ui = await fixture(async (_url, body) => {
    if (body !== undefined) throw Error('WRITE_SHOULD_STAY_FROZEN');
    if (++reads === 1) return profile();
    if (reads === 2) throw Error('REQUEST_TIMEOUT');
    return profile({ username: 'server_name', displayName: 'Server Name', name: 'Server Name' });
  });

  await ui.editor.load();
  const draft = { username: 'unsaved_name', displayName: 'Unsaved Display', statsVisibility: 'private', presenceVisibility: 'friends' };
  assert.equal(ui.editor.updateDraft(draft), true);
  ui.context.sessionStatus = 'loading';
  assert.equal(ui.editor.suspend(), true);
  assert.equal(ui.context.profileEditor.status, 'refreshing');
  assert.deepEqual(ui.context.profileEditor.draft, draft);
  assert.equal(await ui.editor.save(), false);
  assert.equal(ui.editor.updateDraft({ ...draft, displayName: 'Changed while locked' }), false);

  ui.context.profile = profile();
  ui.context.sessionStatus = 'linked';
  assert.equal(await ui.editor.resume('actor-one'), false);
  assert.equal(ui.context.profileEditor.status, 'refresh-error');
  assert.deepEqual(ui.context.profileEditor.draft, draft);
  assert.equal(await ui.editor.save(), false);

  assert.equal(await ui.editor.refresh(), true);
  assert.equal(ui.context.profileEditor.status, 'ready');
  assert.equal(ui.context.profileEditor.profile.username, 'server_name');
  assert.deepEqual(ui.context.profileEditor.draft, draft);
});

test('session and route departure fence both pending protected reads and writes', async () => {
  const readReply = deferred();
  let onProfileRoute = true;
  const ui = await fixture((_url, body) => body === undefined ? readReply.promise : Promise.resolve(profile()), () => onProfileRoute);
  const pendingRead = ui.editor.load();
  onProfileRoute = false;
  ui.editor.deactivate();
  readReply.resolve(profile());
  assert.equal(await pendingRead, false);
  assert.equal(ui.context.profileEditor.status, 'idle');

  onProfileRoute = true;
  assert.equal(await ui.editor.load(), true);
  const saveReply = deferred();
  const { createProfileEditor } = await data;
  // Use a new controller so this pending write is fenced by a signed-out session change.
  const otherContext = { profile: profile(), sessionStatus: 'linked' };
  const other = createProfileEditor({ context: otherContext, active: () => true, request: async (_url, body) => body === undefined ? profile() : saveReply.promise });
  await other.load();
  const pendingWrite = other.save({ username: 'session_change', displayName: 'Session Change', statsVisibility: 'public', presenceVisibility: 'friends' });
  otherContext.sessionStatus = 'guest';
  other.deactivate();
  saveReply.resolve(profile({ username: 'session_change', displayName: 'Session Change', name: 'Session Change' }));
  assert.equal(await pendingWrite, false);
  assert.equal(otherContext.profileEditor.status, 'idle');
  assert.equal(otherContext.profile.username, 'old_name');
});

test('profile page renders labeled supported fields and preserves a failed draft accessibly', async () => {
  const { renderPage } = await pages;
  const serverProfile = profile();
  const draft = { username: 'taken_name', displayName: 'Edited Name', statsVisibility: 'private', presenceVisibility: 'friends' };
  const html = renderPage('/profile', {
    sessionStatus: 'linked', profile: serverProfile,
    profileEditor: { status: 'error', actorId: serverProfile.id, profile: serverProfile, draft, message: 'That username is already in use.', errorCode: 'USERNAME_TAKEN' },
  });
  assert.match(html, /href="#profile-editor"/);
  assert.match(html, /<form class="pg-profile-form" data-profile-form>/);
  for (const name of ['username', 'displayName', 'statsVisibility', 'presenceVisibility']) {
    assert.match(html, new RegExp(`name="${name}"`));
  }
  assert.match(html, /value="taken_name"/);
  assert.match(html, /value="Edited Name"/);
  assert.match(html, /role="status" aria-live="polite" tabindex="-1">That username is already in use\./);
  assert.match(html, /value="public"/);
  assert.match(html, /value="friends" selected/);
  assert.doesNotMatch(html, /name="avatar"|name="password"|name="email"/);

  const cooldown = renderPage('/profile', {
    sessionStatus: 'linked', profile: serverProfile,
    profileEditor: { status: 'error', actorId: serverProfile.id, profile: serverProfile,
      draft: { ...draft, username: 'recent_change' }, message: 'Wait before changing your username.', errorCode: 'USERNAME_COOLDOWN' },
  });
  assert.match(cooldown, /data-profile-action="keep-username"/);
  assert.match(cooldown, /Use your current username and keep the other edits/);

  const guest = renderPage('/profile', { sessionStatus: 'guest', profile: null });
  assert.match(guest, /Sign in to edit your profile/);
  assert.doesNotMatch(guest, /data-profile-form|MEGA-ABCD|Old Name/);
  const loading = renderPage('/profile', { sessionStatus: 'loading', profile: null });
  assert.match(loading, /Checking your signed-in profile/);
  assert.match(loading, /aria-busy="true"/);
  const sessionError = renderPage('/profile', { sessionStatus: 'error', profile: null, accountMessage: 'Temporary account check error.' });
  assert.match(sessionError, /Temporary account check error/);
  assert.match(sessionError, /data-account-action="retry"/);
  const held = renderPage('/profile', { sessionStatus: 'loading', profile: null, profileEditor: {
    status: 'refreshing', actorId: serverProfile.id, profile: serverProfile, draft,
    message: 'Confirming your account before profile changes can continue…',
  } });
  assert.match(held, /unsaved edits remain in this tab and are locked/);
  assert.match(held, /data-account-action="retry"/);
  assert.doesNotMatch(held, /data-profile-form/);
  const refreshError = renderPage('/profile', { sessionStatus: 'linked', profile: serverProfile, profileEditor: {
    status: 'refresh-error', actorId: serverProfile.id, profile: serverProfile, draft,
    message: 'The service did not respond in time. Try again.', errorCode: 'REQUEST_TIMEOUT',
  } });
  assert.match(refreshError, /data-profile-action="retry-refresh"/);
  assert.match(refreshError, /name="username"[^>]*disabled/);
});
