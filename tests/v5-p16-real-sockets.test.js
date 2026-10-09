'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const { createCoreInstanceLifecycle } = require('../packages/services/core-instance-lifecycle');
const { createCoreConnectionDrain } = require('../packages/services/core-drain-connections');

async function waitUntil(predicate, maxMs = 1000) {
  const stop = Date.now() + maxMs;
  while (!predicate()) {
    if (Date.now() > stop) throw new Error('SOCKET_TEST_TIMEOUT');
    await sleep(5);
  }
}

function dial(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const onError = (error) => reject(error);
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.removeListener('error', onError);
      resolve(socket);
    });
  });
}

// This is a real loopback TCP admission/drain test, NOT a Core WebSocket or
// committed-move failover claim. No managed provider, public listener or
// externally addressable port is involved.
test('real loopback connections receive drain notice, reject newcomers, and release only on socket close', { timeout: 5000 }, async (t) => {
  const lifecycle = createCoreInstanceLifecycle({ capacity: 2, drainTimeoutMs: 1000 });
  lifecycle.markReady();
  const registry = createCoreConnectionDrain(lifecycle);
  const accepted = new Set();
  const server = net.createServer((socket) => {
    const handle = registry.register({
      socket,
      notifyDrain: () => socket.write('SERVER_DRAIN\n'),
      forceClose: () => socket.destroy(),
    });
    if (!handle) {
      socket.end('RETRY_LATER\n');
      return;
    }
    accepted.add(socket);
    socket.resume(); // Consume FIN so the server-side close event releases the lease.
    socket.once('close', () => {
      accepted.delete(socket);
      handle.release();
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  t.after(async () => {
    for (const socket of accepted) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  const port = server.address().port;
  const client = await dial(port);
  t.after(() => client.destroy());
  await waitUntil(() => registry.status().active === 1);
  const notice = once(client, 'data');
  assert.equal(registry.beginDrain().noticesQueued, 1);
  assert.equal((await notice)[0].toString(), 'SERVER_DRAIN\n');

  const newcomer = await dial(port);
  t.after(() => newcomer.destroy());
  const retry = once(newcomer, 'data');
  assert.equal((await retry)[0].toString(), 'RETRY_LATER\n');
  assert.equal(registry.status().active, 1);
  assert.equal(registry.finishStop(), false);

  client.end();
  const result = await registry.awaitDrained();
  assert.deepEqual(result, { drained: true, active: 0, reason: 'idle' });
  assert.equal(registry.finishStop(), true);
  assert.equal(registry.status().trackedConnections, 0);
});
