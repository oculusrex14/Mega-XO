'use strict';

/* LR17 (2026-10-16): the one-time research-consent surface. The API/service/DB contract already
 * exists (GET/POST /api/account/research; adult-band-only research enforced by learning.consent;
 * withdrawal via the 0052 semantics) — this module is the missing player-facing card, rendered only
 * in the signed-in account panel. Necessary operations and optional research are explained
 * separately; research is never preselected; withdrawal is one control away. */

function escape(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function researchConsentCard(context) {
  const state = context.researchConsent;
  if (!state) return '';
  const busy = context.researchBusy === true;
  const disabled = busy ? ' disabled' : '';
  const message = context.researchMessage ? '<p class="pg-form-message" role="status" aria-live="polite">' + escape(context.researchMessage) + '</p>' : '';
  const open = !state.recorded || context.researchOpen === true;
  if (!open) {
    const allowed = state.research === true && state.withdrawn !== true;
    const status = allowed
      ? 'Optional research is allowed for your account. You can withdraw at any time; your account and gameplay are never affected.'
      : 'Optional research is not allowed for your account. You can change this at any time; gameplay is never affected.';
    return '<div class="pg-consent" data-research-consent><h3>Optional research</h3><p class="mx-muted">' + escape(status) + '</p>' + message
      + '<div class="pg-actions"><button class="pg-text-button" type="button" data-account-action="research-edit"' + disabled + '>Change</button></div></div>';
  }
  const band = typeof context.researchAgeBand === 'string' && context.researchAgeBand ? context.researchAgeBand : 'adult';
  const option = (value, label) => '<option value="' + value + '"' + (band === value ? ' selected' : '') + '>' + label + '</option>';
  return '<div class="pg-consent" data-research-consent><h3>Your data, your choice</h3>'
    + '<p><strong>Needed to operate the game:</strong> accounts, matchmaking, security and fraud-prevention records. This happens for everyone and is covered by the Privacy Policy.</p>'
    + '<p><strong>Optional research, a separate choice:</strong> allow your gameplay records to be used for optional Mega XOXO game research. Declining changes nothing about your account or gameplay, and research use never feeds advertising.</p>'
    + '<label for="research-age-band">Your age band</label><select id="research-age-band"' + disabled + '>'
    + option('adult', 'Adult (18 or older)') + option('youth', 'Under 18') + option('unknown', 'Prefer not to say')
    + '</select><p class="mx-muted">Optional research is only available to adult accounts; a youth or undisclosed band records a decline.</p>'
    + message + '<div class="pg-actions"><button class="mx-button primary" type="button" data-account-action="research-allow"' + disabled + '>Allow optional research</button>'
    + '<button class="pg-text-button" type="button" data-account-action="research-decline"' + disabled + '>No thanks</button></div></div>';
}
