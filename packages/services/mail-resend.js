'use strict';

/* V5 Resend transactional mail transport (LR10, 2026-10-16).
 *
 * INTERFACE CONTRACT (packages/services/worker-workflows.js): the mail worker dispatches
 * sendOtp/sendPasswordChanged/sendSecurityNotice/sendMail with the SEALED-BODY-OPENED message, and
 * probes enabled(). This module implements exactly that surface over the Resend HTTP API, ported
 * from the proven V4 provider (server/email-provider.js): same templates, same Idempotency-Key
 * discipline, same fail-closed rules.
 *
 * CONFIGURATION IS EXPLICIT: no process.env reads here. The composition passes the secret (from the
 * approved secret-file channel) and the fetcher (injectable for offline tests). A missing or
 * malformed key refuses at construction - never at first send. */

const DEFAULT_FROM = 'Mega XOXO by Antimatter Innovations <contact@antimatterinnovations.com>';
const BRAND = 'Mega XOXO';
const DEVELOPER = 'Antimatter Innovations';
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const CONTACT = 'contact@antimatterinnovations.com';

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function createResendMailTransport(options = {}) {
  const apiKey = options.apiKey;
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw Error('RESEND_API_KEY_REQUIRED');
  }
  if (typeof options.fetcher !== 'function') {
    throw Error('RESEND_FETCHER_REQUIRED');
  }
  const from = typeof options.from === 'string' && options.from.length > 0 ? options.from : DEFAULT_FROM;
  const fetcher = options.fetcher;

  async function send(payload) {
    const response = await fetcher(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
        ...(payload.idempotencyKey ? { 'Idempotency-Key': String(payload.idempotencyKey) } : {}),
      },
      body: JSON.stringify({ from, to: [payload.to], subject: payload.subject, text: payload.text, html: payload.html }),
    });
    let body = {};
    try { body = await response.json(); } catch { /* a non-JSON error body stays a failure */ }
    if (!response.ok) throw Error('EMAIL_DELIVERY_FAILED');
    return body;
  }

  return Object.freeze({
    enabled: () => true,
    async sendOtp(message) {
      const to = message && message.to;
      const code = message && message.code;
      const purpose = message && message.purpose;
      if (typeof to !== 'string' || to.length === 0) throw Error('EMAIL_RECIPIENT_REQUIRED');
      if (typeof code !== 'string' || code.length === 0) throw Error('EMAIL_CODE_REQUIRED');
      const reset = purpose === 'reset';
      const subject = reset ? 'Reset your Mega XOXO password' : 'Verify your Mega XOXO email';
      const action = reset ? 'password reset' : 'email verification';
      const text = BRAND + ' ' + action + ' code: ' + code + '. Expires in 10 minutes, usable once. If you did not request this, ignore this email. ' + BRAND + ' is developed by ' + DEVELOPER + '.';
      const html = '<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;padding:28px"><p style="font-size:12px;letter-spacing:.12em;text-transform:uppercase">' + DEVELOPER + '</p><h1 style="font-size:24px">' + BRAND + '</h1><p>Use this one-time code for ' + escapeHtml(action) + ':</p><p style="font-size:34px;font-weight:700;letter-spacing:.18em;margin:24px 0">' + escapeHtml(code) + '</p><p>This code expires in <strong>10 minutes</strong> and can be used once.</p><p style="color:#666">If you did not request this, you can ignore this email.</p><hr style="border:0;border-top:1px solid #ddd;margin:28px 0"><p style="font-size:12px;color:#666">' + BRAND + ' is developed by ' + DEVELOPER + '.</p></div>';
      return send({ to, subject, text, html, idempotencyKey: message.idempotencyKey });
    },
    async sendPasswordChanged(message) {
      const to = message && message.to;
      if (typeof to !== 'string' || to.length === 0) throw Error('EMAIL_RECIPIENT_REQUIRED');
      const subject = 'Your Mega XOXO password was changed';
      const text = 'Your Mega XOXO password was changed. If this was not you, contact ' + DEVELOPER + ' at ' + CONTACT + ' immediately. Mega XOXO is developed by ' + DEVELOPER + '.';
      const html = '<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;padding:28px"><p style="font-size:12px;letter-spacing:.12em;text-transform:uppercase">' + DEVELOPER + '</p><h1 style="font-size:24px">' + BRAND + '</h1><p>Your password was changed successfully.</p><p>If this was not you, contact <a href="mailto:' + CONTACT + '">' + CONTACT + '</a> immediately.</p><p style="font-size:12px;color:#666">' + BRAND + ' is developed by ' + DEVELOPER + '.</p></div>';
      return send({ to, subject, text, html, idempotencyKey: message.idempotencyKey });
    },
    async sendSecurityNotice(message) {
      const to = message && message.to;
      if (typeof to !== 'string' || to.length === 0) throw Error('EMAIL_RECIPIENT_REQUIRED');
      const event = message && message.event;
      const labels = {
        email_changed: 'Your Mega XOXO email was changed',
        provider_linked: 'A sign-in method was linked to your Mega XOXO profile',
        provider_unlinked: 'A sign-in method was removed from your Mega XOXO profile',
        session_revoked: 'A Mega XOXO session was signed out',
        other_sessions_revoked: 'Other Mega XOXO sessions were signed out',
        incident_sessions_revoked: 'Mega XOXO signed out all sessions for security',
      };
      const subject = labels[event] || 'Mega XOXO security notice';
      const safeDetail = String((message && message.detail) || '').slice(0, 240);
      const text = subject + '. ' + (safeDetail ? safeDetail + ' ' : '') + 'If you did not make this change, contact ' + DEVELOPER + ' at ' + CONTACT + '. Mega XOXO is developed by ' + DEVELOPER + '.';
      const html = '<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;padding:28px"><p style="font-size:12px;letter-spacing:.12em;text-transform:uppercase">' + DEVELOPER + '</p><h1 style="font-size:24px">' + BRAND + '</h1><p><strong>' + escapeHtml(subject) + '</strong></p>' + (safeDetail ? '<p>' + escapeHtml(safeDetail) + '</p>' : '') + '<p>If you did not make this change, contact <a href="mailto:' + CONTACT + '">' + CONTACT + '</a>.</p></div>';
      return send({ to, subject, text, html, idempotencyKey: message.idempotencyKey });
    },
    async sendMail(message) {
      const to = message && message.to;
      const subject = message && message.subject;
      const text = message && message.text;
      if (typeof to !== 'string' || to.length === 0) throw Error('EMAIL_RECIPIENT_REQUIRED');
      if (typeof subject !== 'string' || subject.length === 0) throw Error('EMAIL_SUBJECT_REQUIRED');
      if (typeof text !== 'string' || text.length === 0) throw Error('EMAIL_TEXT_REQUIRED');
      return send({ to, subject, text, html: message.html, idempotencyKey: message.idempotencyKey });
    },
  });
}

module.exports = { createResendMailTransport, DEFAULT_FROM, BRAND, DEVELOPER, RESEND_ENDPOINT };
