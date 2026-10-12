'use strict';

/**
 * Production-composable Game Core HTTP listener. The Core process is given
 * core_runtime only; it may run commands and publish authorized rankings.
 * Ticket issuance is API-owned and can never be injected into this host.
 *
 * Deployment supplies an already readied Core, queue and guarded Core pool.
 * Starting this module creates no database connection or fallback credentials.
 * Nonloopback binds require explicit acknowledgment of proxy/TLS configuration.
 */
const http = require('node:http');
const { createCoreServiceIngress } = require('../../packages/services/core-gateway.js');
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

function createCoreIngressServer(options = {}) {
  const { coreService, queue, pool, secret, host = '127.0.0.1', port = 0, allowNonLoopback = false } = options;
  if (Object.hasOwn(options, 'ticketIssuer') || Object.hasOwn(options, 'apiPool')) {
    throw Error('CORE_API_ROLE_CREDENTIAL_FORBIDDEN');
  }
  if (!coreService || typeof coreService.run !== 'function') throw Error('CORE_SERVICE_REQUIRED');
  if (!pool || typeof pool.query !== 'function') throw Error('CORE_READ_POOL_REQUIRED');
  if (typeof pool.describe !== 'function' || pool.describe()?.role !== 'core_runtime') {
    throw Error('CORE_RUNTIME_ROLE_REQUIRED');
  }
  if (typeof secret !== 'string' || secret.length < 16) throw Error('INGRESS_SECRET_REQUIRED');
  if (typeof host !== 'string' || !host.trim() || (!LOOPBACK.has(host) && allowNonLoopback !== true)) {
    throw Error('INGRESS_BIND_REQUIRES_EXPLICIT_APPROVAL');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('INGRESS_PORT_INVALID');
  const ingress = createCoreServiceIngress({ coreService, queue, leaderboardPool:pool, secret });
  const server = http.createServer(ingress);
  let closing = false;
  let listening = false;
  return {
    server,
    async listen() {
      if (closing || listening) throw Error('INGRESS_ALREADY_STARTED_OR_CLOSED');
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
        });
      } catch (error) {
        closing = true;
        throw error;
      }
      listening = true;
      return { host, port:server.address().port };
    },
    async close() {
      if (closing) return;
      closing = true;
      if (!listening) return;
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections?.();
      await closed;
      listening = false;
    },
  };
}
module.exports = { createCoreIngressServer };
