/* Presentation only. Main owns powers/v1, rewarded settlement and match mutation. */
(function (root) {
  'use strict';
  const KINDS = Object.freeze(['undo', 'hint', 'undoBlock', 'tacticalBlock']);
  const LABELS = Object.freeze({ undo: 'Undo / Undo Request', hint: 'Tactical Power', undoBlock: 'Undo Block', tacticalBlock: 'Tactical Block' });
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const unavailable = reason => ({ available: false, reason, inventory: null, eligibility: null, pacing: null });
  const reader = value => value && value.version === 'powers/v1' && ['inventory', 'eligibility', 'request', 'apply', 'pacing'].every(name => typeof value[name] === 'function');
  const bindingKey = binding => binding && typeof binding.actorId === 'string' && binding.actorId && typeof binding.matchId === 'string' && binding.matchId && integer(binding.revision)
    ? JSON.stringify([binding.actorId, binding.matchId, binding.revision]) : '';
  function allowedSummary(summary) {
    if (!summary || !['bot', 'casual'].includes(summary.mode)) return false;
    const flags = [summary.ranked, summary.staked, summary.challenge, summary.tournament, summary.lan, summary.rated, summary.quote?.rated, summary.terms?.ranked, summary.terms?.staked, summary.terms?.challenge, summary.terms?.tournament, summary.terms?.lan, summary.terms?.rated];
    if (flags.some(flag => flag !== undefined && flag !== false)) return false;
    if (summary.terms?.source !== undefined && !['queue', 'bot'].includes(summary.terms.source)) return false;
    if (summary.quote?.currency !== undefined && summary.quote.currency !== null) return false;
    if (summary.terms?.stake !== undefined && summary.terms.stake !== 0) return false;
    if (summary.terms?.stakes !== undefined && summary.terms.stakes !== 0) return false;
    const contributions = summary.quote?.contributions;
    if (contributions !== undefined && (!Array.isArray(contributions) || contributions.length !== 2 || contributions.some(value => value !== 0))) return false;
    return true;
  }

  function read(adapter, summary) {
    if (!reader(adapter)) return unavailable('adapter-unavailable');
    try {
      const inventory = adapter.inventory();
      const eligibility = adapter.eligibility(summary);
      const pacing = adapter.pacing();
      if (!inventory || (inventory.version !== undefined && inventory.version !== 'powers/inventory/v1') || !KINDS.every(kind => inventory[kind] && integer(inventory[kind].available) && integer(inventory[kind].reserved))) return unavailable('invalid-inventory');
      const undo = eligibility?.undo;
      if (!undo || typeof undo.eligible !== 'boolean' || typeof undo.reason !== 'string' || !integer(undo.ply) || !integer(undo.charges) || undo.charges > 2 || !integer(undo.perMatchUsed) || undo.perMatchUsed > 2) return unavailable('invalid-eligibility');
      if (!pacing || !integer(pacing.rewardedShownToday) || pacing.rewardedDayCap !== 10 || pacing.rewardedShownToday > 10 || !integer(pacing.nextEligibleAt)) return unavailable('invalid-pacing');
      // Copy only frozen public fields. Never retain advice hidden in an extra field.
      return {
        available: true, reason: '',
        inventory: Object.fromEntries(KINDS.map(kind => [kind, { available: inventory[kind].available, reserved: inventory[kind].reserved }])),
        eligibility: { undo: { eligible: undo.eligible, reason: undo.reason, ply: undo.ply, charges: undo.charges, perMatchUsed: undo.perMatchUsed } },
        pacing: { rewardedShownToday: pacing.rewardedShownToday, rewardedDayCap: 10, nextEligibleAt: pacing.nextEligibleAt },
      };
    } catch { return unavailable('reader-failed'); }
  }

  const resultCopy = reason => ({
    NO_FILL: 'No ad was available. No item was earned; an ad that was not shown uses no daily slot.',
    FAILED_TO_PRESENT: 'The ad could not open. No item was earned; an ad that was not shown uses no daily slot.',
    SKIPPED: 'The shown ad was skipped. It uses a daily exposure slot and earns no item.',
    PENDING: 'Reward confirmation is pending. Check the bank before trying again.',
    RECONNECT_REQUIRED: 'Reconnect to check the bank and current match before trying again.',
    FEATURE_OFF: 'Rewarded powers are currently unavailable.',
    BLOCKED: 'The opponent blocked the request. No Tactical suggestion is revealed.',
    STALE_REVISION: 'The match changed. Refresh before using an item; technical attempts must preserve earned items.',
  })[reason] || 'The action was not confirmed. Refresh the bank before retrying; technical attempts must preserve earned items.';

  /** verifyContext is a host integration gate, not a new powers/v1 protocol field.
   * It defaults to false until Main supplies verified actor/match/feature binding. */
  function createController({ getAdapter = () => root.MegaPowers, getMatchSummary = () => null, getBinding = () => null, getContext = getMatchSummary, verifyContext = () => false, onChange = () => {}, now = Date.now } = {}) {
    let destroyed = false, sequence = 0, pending = null, uncertain = false, outcome = '', cached = unavailable('adapter-unavailable');
    let currentAdapter = null, currentKey = '';
    const allowedMode = () => allowedSummary(getMatchSummary());
    const contextKey = () => {
      const binding = bindingKey(getBinding());
      return binding ? JSON.stringify([binding, getMatchSummary()]) : '';
    };
    function refresh({ notify = false } = {}) {
      if (destroyed) return view();
      let adapter, key;
      try { adapter = getAdapter(); key = contextKey(); } catch { adapter = null; key = ''; }
      if (adapter !== currentAdapter || key !== currentKey) {
        sequence += 1; pending = null; uncertain = false; outcome = '';
        currentAdapter = adapter; currentKey = key;
      }
      try { cached = !allowedMode() ? unavailable('mode-ineligible') : !reader(adapter) ? unavailable('adapter-unavailable') : !authorityReady() ? unavailable('context-unverified') : read(adapter, getMatchSummary()); }
      catch { cached = unavailable('reader-failed'); }
      if (notify) onChange();
      return view();
    }
    function authorityReady() {
      try { return !!currentKey && contextKey() === currentKey && getAdapter() === currentAdapter && allowedMode() && getMatchSummary()?.status === 'PLAYING' && verifyContext(getMatchSummary(), currentAdapter) === true; } catch { return false; }
    }
    function can(kind, operation) {
      // Only Undo has a frozen eligibility shape. Separate counters/hints stay closed.
      if (destroyed || pending || uncertain || kind !== 'undo' || !cached.available || !authorityReady() || !cached.eligibility.undo.eligible) return false;
      if (operation === 'request') return cached.pacing.rewardedShownToday < 10 && cached.pacing.nextEligibleAt <= now() && cached.inventory.undo.available === 0 && cached.inventory.undo.reserved === 0 && cached.eligibility.undo.charges === 0;
      return cached.inventory.undo.reserved === 0 && (cached.inventory.undo.available > 0 || cached.eligibility.undo.charges > 0);
    }
    function view() {
      let summary;
      try { summary = getMatchSummary(); } catch { summary = null; }
      const current = authorityReady();
      const safe = current || !cached.available ? cached : unavailable('context-unverified');
      return { ...safe, hidden: !allowedSummary(summary), mode: summary?.mode, pending: current ? pending?.operation || (uncertain ? 'confirmation' : null) : null, outcome: current ? outcome : '', canRequestUndo: can('undo', 'request'), canApplyUndo: can('undo', 'apply'), authorityReady: current };
    }
    function stillCurrent(active) {
      try { return !destroyed && pending === active && sequence === active.sequence && getAdapter() === active.adapter && contextKey() === active.key && authorityReady(); }
      catch { return false; }
    }
    async function request(kind = 'undo') {
      refresh();
      if (!can(kind, 'request')) return { earned: false, reason: 'UNAVAILABLE', entitlement: null };
      const active = { operation: 'request', sequence: ++sequence, adapter: currentAdapter, key: currentKey };
      pending = active; outcome = 'Waiting for confirmed reward. No item has been added by this page.'; onChange();
      let result;
      try { if (!stillCurrent(active)) throw new Error('STALE_CONTEXT'); result = await active.adapter.request(kind, getContext()); }
      catch { result = { earned: false, reason: 'RECONNECT_REQUIRED', entitlement: null }; }
      if (!stillCurrent(active)) { refresh({ notify: !destroyed }); return { earned: false, reason: 'STALE_CONTEXT', entitlement: null }; }
      pending = null;
      const valid = result && typeof result.earned === 'boolean' && typeof result.reason === 'string' && (result.entitlement === null || (typeof result.entitlement === 'string' && result.entitlement.length > 0)) && (!result.earned || result.entitlement !== null);
      const confirmed = valid ? { earned: result.earned, reason: result.reason, entitlement: result.entitlement } : { earned: false, reason: 'INVALID_RESULT', entitlement: null };
      uncertain = ['PENDING', 'RECONNECT_REQUIRED', 'INVALID_RESULT'].includes(confirmed.reason);
      // A reward response never increments bank counts or automatically uses an item.
      outcome = confirmed.earned ? 'Reward confirmed. The bank below shows the authority’s latest inventory; refresh if confirmation is still pending.' : resultCopy(confirmed.reason);
      refresh(); onChange();
      return confirmed;
    }
    function apply(kind = 'undo') {
      refresh();
      if (!can(kind, 'apply')) return { applied: false, reason: 'UNAVAILABLE', revision: null };
      const active = { operation: 'apply', sequence: ++sequence, adapter: currentAdapter, key: currentKey };
      pending = active;
      let result;
      try { result = active.adapter.apply(kind, getContext()); }
      catch { result = null; }
      if (!stillCurrent(active)) { refresh({ notify: !destroyed }); return { applied: false, reason: 'STALE_CONTEXT', revision: null }; }
      pending = null;
      const valid = result && typeof result.applied === 'boolean' && typeof result.reason === 'string' && integer(result.revision);
      const confirmed = valid ? { applied: result.applied, reason: result.reason, revision: result.revision } : { applied: false, reason: 'INVALID_RESULT', revision: null };
      uncertain = confirmed.applied || ['PENDING', 'RECONNECT_REQUIRED', 'INVALID_RESULT', 'STALE_REVISION'].includes(confirmed.reason);
      outcome = confirmed.applied ? 'Power application confirmed. Waiting for the authoritative match state.' : resultCopy(confirmed.reason);
      refresh(); onChange();
      return confirmed;
    }
    refresh();
    return Object.freeze({ refresh, view, request, apply, destroy() { destroyed = true; sequence += 1; pending = null; uncertain = false; outcome = ''; cached = unavailable('retired'); currentKey = ''; currentAdapter = null; } });
  }

  function render(view = { hidden: false, mode: 'bot', available: false }) {
    if (view.hidden) return '';
    const counts = view.available ? view.inventory : null;
    const undo = view.available ? view.eligibility.undo : null;
    const pacing = view.available ? view.pacing : null;
    const chargeCopy = undo ? `${undo.charges} of 2 earned charges available` : 'Earned charges unavailable';
    const unavailableCopy = view.reason === 'context-unverified' ? 'Powers are unavailable. Your current account and match could not be verified.' : ['invalid-inventory', 'invalid-eligibility', 'invalid-pacing', 'reader-failed'].includes(view.reason) ? 'Power information could not be verified. Refresh the bank to check again.' : 'Powers are unavailable. The verified powers service has not loaded.';
    const status = view.outcome || (view.pending ? 'Waiting for authority confirmation.' : !view.available ? unavailableCopy : !view.authorityReady ? 'Inventory loaded. Power actions are unavailable until this match is verified.' : !undo.eligible ? 'Powers are unavailable for the current match state.' : 'Choose whether to use an earned item.');
    return `<section class="gb-powers" aria-label="Optional powers" data-gb-powers>
      <div class="gb-powers-heading"><div><span class="gb-powers-eyebrow">OPTIONAL POWERS</span><h2>${view.mode === 'bot' ? 'Bot Undo' : 'Undo Request'}</h2></div><span class="gb-powers-badge">${view.available ? 'Inventory reported' : 'Unavailable'}</span></div>
      ${view.mode === 'bot' ? `<div class="gb-powers-charges" aria-label="${escape(chargeCopy)}">${[0, 1].map(i => `<span class="gb-powers-charge${undo && undo.charges > i ? ' gb-powers-charge--earned' : ''}" aria-hidden="true">${undo ? undo.charges > i ? '↶' : '·' : '?'}</span>`).join('')}<p>${escape(chargeCopy)}<small>One earned package supports up to two player decisions in a Bot match.</small></p></div>` : '<p class="gb-powers-copy">An Undo Request can be blocked by the opponent’s Undo Block. A token does not guarantee a rewind.</p>'}
      <p class="gb-powers-status" role="status" aria-live="polite" aria-atomic="true">${escape(status)}</p>
      <div class="gb-powers-actions"><button type="button" data-gb-power="apply"${view.canApplyUndo ? '' : ' disabled'}>${view.mode === 'bot' ? 'Use earned Undo' : 'Use Undo Request'}</button><button type="button" data-gb-power="request"${view.canRequestUndo ? '' : ' disabled'}>Choose rewarded ad</button><button class="gb-powers-refresh" type="button" data-gb-power="refresh">Refresh bank</button></div>
      <details class="gb-powers-details"><summary>Power bank and ad rules</summary><div class="gb-powers-details-body">
        <dl class="gb-powers-bank">${KINDS.map(kind => `<div><dt>${LABELS[kind]}</dt><dd>${counts ? `${counts[kind].available} available · ${counts[kind].reserved} reserved` : 'Unavailable'}</dd></div>`).join('')}</dl>
        <p>Rewarded ads are optional, including with Remove Ads. A completed ad must earn its described item. Unused earned items remain banked; technical failures must preserve them.</p>
        <p>${pacing ? `${pacing.rewardedShownToday} of ${pacing.rewardedDayCap} shown today (UTC). ${pacing.nextEligibleAt > Date.now() ? 'The next rewarded ad is still in cooldown.' : 'The authority reports no current cooldown.'}` : 'Daily exposure and cooldown status are unavailable.'} All rewarded types share 10 shown ads per UTC day and at least 2 minutes between exposures. A skipped shown ad earns nothing; no-fill or an ad that never opens uses no exposure slot.</p>
        <div class="gb-powers-casual"><label>Casual rules<select disabled aria-describedby="gb-powers-casual-note"><option value="no-power" selected>No powers</option><option value="powered">Powered Casual</option></select></label><p id="gb-powers-casual-note">Powered Casual selection is unavailable until the verified match service supports the disclosed rules. Ordinary no-power Casual remains available through Play modes.</p></div>
        <p>Powered Casual allows three Undo Request initiations per player and one successful rewind for the match. Tactical Power has three initiations and two uses per player; Tactical Block has three activations and two successful blocks. Undo Block and Tactical Block are separate items. Bot never secretly acquires counter powers.</p>
        <div class="gb-powers-counters"><button type="button" disabled>Undo Block</button><button type="button" disabled>Tactical Power</button><button type="button" disabled>Tactical Block</button></div>
        <p>Tactical Power recommends one legal square using Expert. You may choose any legal square. The suggestion stays hidden until the counter window settles; a blocked request reveals no suggestion. Counter controls are unavailable until authoritative resolution is supported.</p>
      </div></details>
    </section>`;
  }
  root.MegaWebPowers = Object.freeze({ createController, render });
})(globalThis);
