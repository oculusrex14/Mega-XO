'use strict';

const { parseJsonBody, resolveAuth, sendJson } = require('./helpers');
const { resolveGateway, resolveOpKey } = require('./competitive');
const { tournamentCommand, tournamentRoomId } = require('../../../packages/services/tournament-http-contract');

async function handleTournamentRoute(context, req, res) {
 const url = new URL(req.url || '/', 'http://localhost');
 if (!url.pathname.startsWith('/api/party/')) return false;
 const method = (req.method || 'GET').toUpperCase();
 if (url.pathname === '/api/party/capabilities' && method === 'GET') {
  let gateway;
  try { gateway = resolveGateway(context); } catch { /* Unconfigured local previews offer no online entry. */ }
  const result = typeof gateway?.tournamentCapabilities === 'function'
   ? await gateway.tournamentCapabilities() : { online: false, publicEnabled: false, tables: [] };
  sendJson(res, 200, result);
  return true;
 }
 const match = /^\/api\/party\/rooms\/([^/]+)$/.exec(url.pathname);
 if ((match && method === 'GET') || (url.pathname === '/api/party/command' && method === 'POST')) {
  const { actor } = await resolveAuth(context, req);
  if (!actor) { const error = Error('AUTH_REQUIRED'); error.status = 401; throw error; }
  const gateway = resolveGateway(context);
  if (match) {
   let id;
   try { id = decodeURIComponent(match[1]); } catch { id = null; }
   const result = await gateway.tournamentView({ actor, id: tournamentRoomId(id) });
   sendJson(res, 200, result);
  } else {
   const body = await parseJsonBody(req);
   const opKey = resolveOpKey(req, body);
   if (opKey.length > 160) { const error = Error('INVALID_IDEMPOTENCY_KEY'); error.status = 400; throw error; }
   // Legacy idempotency metadata may live at the envelope level; it is never
   // forwarded as a command field or used as actor authority.
   const { opKey: _opKey, idempotencyKey: _idempotencyKey, key: _key, ...input } = body || {};
   const command = tournamentCommand(input);
   const result = await gateway.tournamentCommand({ actor, opKey, command });
   sendJson(res, 200, result);
  }
  return true;
 }
 sendJson(res, 404, { error: 'NOT_FOUND' });
 return true;
}

module.exports = { handleTournamentRoute };
