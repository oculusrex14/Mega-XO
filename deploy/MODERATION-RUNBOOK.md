# V4.1 moderation operations

V4.1 provides player reporting without automated punishment. Reports are evidence for human review; moderation actions are separate audited operator commands.

## Player report categories

- `cheating` — suspected unfair/automated play;
- `username` — username/profile presentation;
- `harassment` — unwanted targeting/harassment through available social interactions;
- `unsportsmanlike` — disruptive conduct;
- `other` — requires useful explanatory context.

Players cannot report themselves. Report text is limited to 280 characters and rejects markup/control characters. Each account is limited to five reports per UTC-sized 24-hour rate window, with duplicate suppression for the same open category/target.

## Review reports

From the running app container on the VPS:

```bash
node scripts/operator.js report-list --state open --limit 50
```

Review the target profile, relevant match evidence available in the authoritative state, prior report history, and operator audit history as appropriate. Do not request passwords, OTPs or session cookies from the reporter.

## Resolve a report

Resolution outcomes are intentionally narrow:

```text
no_action
action_taken
duplicate
```

Example:

```bash
node scripts/operator.js report-resolve rp_REPORT_ID \
  --outcome no_action \
  --operator mod.one \
  --reason "Reviewed available evidence; no policy violation established"
```

Resolving a report does not automatically suspend, hold, change rank, or change wallet balances.

If action is warranted, perform it separately so it receives its own immutable audit record:

```bash
node scripts/operator.js hold-on PLAYER_TAG \
  --operator mod.one \
  --reason "Temporary security/moderation hold pending review"
```

or, for an approved suspension:

```bash
node scripts/operator.js suspend PLAYER_TAG \
  --operator mod.one \
  --reason "Confirmed policy violation under approved moderation policy"
```

Never use wallet/rating changes as a moderation tool.

## Audit

```bash
node scripts/operator.js audit PLAYER_TAG --limit 100
node scripts/operator.js audit-verify
```

The operator audit table is append-only in normal operation; database triggers reject update/delete attempts and each entry is chained to the previous record with an HMAC-backed hash.

## Policy approval

A complete proposed conduct/evidence/action/appeal policy is drafted at `docs/legal/MODERATION-POLICY-DRAFT.md`.

Before public moderation operations are considered complete, Antimatter Innovations must approve that draft (or an edited replacement), including suspension durations, appeal handling, retention periods and authorized operator roles. Record an immutable policy version when approved.

This approval remains tracked in `docs/V4-OPEN-BLOCKERS.md`; repository code does not silently convert the draft into an effective punishment policy.

## Privacy

Reports submitted by a player appear in that player's personal data export. Reports filed *about* a player are not exposed in that export because doing so can reveal reporter/moderation information; access/retention treatment remains part of the approved privacy/moderation policy.
