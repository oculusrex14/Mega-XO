'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { GooglePlayStoreNotifications, AppleStoreNotificationsV5 } = require('../server/v5-store-notifications.js');

const b64u = b => Buffer.from(b).toString('base64url');
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
const KID = 'test-key-1';
const jwksBody = JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] });

function pushToken(opts = {}) {
  const email = opts.email || 'push@megaxo.iam.gserviceaccount.com';
  const aud = opts.aud || 'https://megaxo.online/api/monetization/google-play-rtdn';
  const header = b64u(JSON.stringify({ alg: 'RS256', kid: KID }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64u(JSON.stringify({ iss: 'https://accounts.google.com', aud, email, exp: now + 300, iat: now }));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(header + '.' + payload), privateKey).toString('base64url');
  return header + '.' + payload + '.' + sig;
}

function rtdn() {
  const refunds = [];
  const seenIds = new Set();
  const hooks = {
    seen: async (store, id) => seenIds.has(store + ':' + id),
    record: async (store, id) => { seenIds.add(store + ':' + id); },
    onRefund: async (store, transactionId) => { refunds.push([store, transactionId]); },
  };
  const handler = new GooglePlayStoreNotifications({
    packageName: 'online.megaxo.game',
    serviceAccountEmail: 'push@megaxo.iam.gserviceaccount.com',
    jwksUrl: 'https://jwks.test/certs',
    fetcher: async () => ({ json: async () => JSON.parse(jwksBody) }),
  });
  return { handler, refunds, seenIds, hooks };
}

const envelope = data => ({ message: { messageId: 'rtbn-1', data: b64u(JSON.stringify(data)) } });

test('google rtdn: a verified cancelled one-time purchase refunds the sha256(purchaseToken) identity', async () => {
  const { handler, refunds, seenIds, hooks } = rtdn();
  const res = await handler.handle('Bearer ' + pushToken(), envelope({ packageName: 'online.megaxo.game', oneTimeProductNotification: { notificationType: 2, purchaseToken: 'token-abc', sku: 'crowns_100' } }), hooks);
  assert.equal(res.ok, true);
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0][0], 'google');
  assert.equal(refunds[0][1], crypto.createHash('sha256').update('token-abc').digest('hex'));
  assert.equal(seenIds.has('google:rtbn-1'), true);
});

test('google rtdn: a replayed notification id is a duplicate and refunds nothing', async () => {
  const { handler, refunds, hooks } = rtdn();
  await handler.handle('Bearer ' + pushToken(), envelope({ packageName: 'online.megaxo.game', voidedPurchaseNotification: { purchaseToken: 'token-xyz' } }), hooks);
  const res = await handler.handle('Bearer ' + pushToken(), envelope({ packageName: 'online.megaxo.game', voidedPurchaseNotification: { purchaseToken: 'token-xyz' } }), hooks);
  assert.equal(res.duplicate, true);
  assert.equal(refunds.length, 1);
});

test('google rtdn: a wrong-package or forged push is refused', async () => {
  const { handler, hooks } = rtdn();
  await assert.rejects(() => handler.handle('Bearer ' + pushToken(), envelope({ packageName: 'com.evil.app', voidedPurchaseNotification: { purchaseToken: 'x' } }), hooks), /INVALID_STORE_NOTIFICATION/);
  await assert.rejects(() => handler.handle('Bearer not-a-jwt', envelope({})), /INVALID_STORE_NOTIFICATION/);
  await assert.rejects(() => handler.handle('Bearer ' + pushToken({ email: 'attacker@evil.test' }), envelope({ packageName: 'online.megaxo.game', voidedPurchaseNotification: { purchaseToken: 'x' } }), hooks), /INVALID_STORE_NOTIFICATION/);
});

test('google rtdn: type 1 with no provider read refunds nothing', async () => {
  const { handler, refunds, hooks } = rtdn();
  const res = await handler.handle('Bearer ' + pushToken(), envelope({ packageName: 'online.megaxo.game', oneTimeProductNotification: { notificationType: 1, purchaseToken: 'token-live', sku: 'crowns_100' } }), hooks);
  assert.equal(res.ok, true);
  assert.equal(refunds.length, 0);
});

test('apple notifications: malformed envelopes fail closed before any chain work', async () => {
  const storeKit = { verifyJws: () => { throw Error('INVALID_RECEIPT'); }, inspectTransaction: () => { throw Error('INVALID_RECEIPT'); } };
  const handler = new AppleStoreNotificationsV5({ storeKit });
  await assert.rejects(() => handler.handle({}), /INVALID_STORE_NOTIFICATION/);
  await assert.rejects(() => handler.handle({ signedPayload: 'a.b.c' }), /INVALID_STORE_NOTIFICATION/);
  const hooks = { seen: async () => false, record: async () => {}, onRefund: async () => {} };
  await assert.rejects(() => handler.handle({ signedPayload: 'a.b.c' }, hooks), /INVALID_STORE_NOTIFICATION/);
});

test('apple notifications: the verifyJws result drives the revocation branch', async () => {
  const refunds = [];
  const storeKit = {
    verifyJws: p => {
      if (p === 'good') return { notificationUUID: 'uuid-1', notificationType: 'REFUND', data: { signedTransactionInfo: 'inner' } };
      if (p === 'inner') return { transactionId: 'raw-inner' };
      throw Error('INVALID_RECEIPT');
    },
    inspectTransaction: () => ({ transactionId: 'tx-1', revoked: false }),
  };
  const handler = new AppleStoreNotificationsV5({ storeKit });
  const res = await handler.handle({ signedPayload: 'good' }, { seen: async () => false, record: async () => {}, onRefund: async (store, id) => { refunds.push([store, id]); } });
  assert.equal(res.refunded, 1);
  assert.deepEqual(refunds, [['apple', 'tx-1']]);
});
