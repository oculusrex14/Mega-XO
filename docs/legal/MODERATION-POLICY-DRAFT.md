# Mega XO moderation and player conduct policy — draft

Status: **DRAFT FOR ANTIMATTER INNOVATIONS APPROVAL**  
Draft date: 2026-10-07

This document is the proposed policy behind Mega XO's existing report, hold, suspension and appeal tooling. It is an operational/product policy draft, not an automatic punishment engine.

## 1. Player conduct

Players must not:

- use bots, solvers, scripts, modified clients or automation to gain an unfair competitive advantage;
- collude, win-trade, intentionally manipulate tournament placements, ratings or leaderboards;
- use multiple accounts to evade restrictions or manipulate competitive outcomes;
- exploit bugs, race conditions, duplicate/replay behavior or service faults for advantage;
- harass, threaten or repeatedly target another player through available social features;
- use hateful, sexual, threatening, impersonating or otherwise clearly inappropriate profile names/presentation;
- abuse the report/support systems or knowingly submit fabricated reports;
- attempt account theft, credential/OTP collection, payment fraud or other attacks on players or the service;
- evade an active account suspension or security hold.

Normal strategic play, resigning a lost game, playing quickly, winning repeatedly, using bought Crowns, or having an unusual play style is **not by itself a violation**.

## 2. Report categories

The product exposes these fixed categories:

- `cheating`
- `username`
- `harassment`
- `unsportsmanlike`
- `other`

Free-text detail is supporting context, not proof by itself.

## 3. Evidence standard

Moderation actions should rely on the strongest available evidence, such as:

- authoritative match/tournament records;
- repeated-pair, concentrated-forfeit or automation review flags;
- server/operator audit records;
- multiple independent reports showing the same pattern;
- verified abuse of account/payment/reward protocols;
- profile content visible in the service;
- explicit admissions made through support.

A single behavioral heuristic, one unusually fast match, one loss, one resignation, one report, or one high-value Crown entry should not automatically establish a violation.

Review flags are leads for human review. They must not independently alter Elo, wallet balances or tournament results.

## 4. Recommended action ladder

### No action

Use when evidence does not establish a policy violation, is too ambiguous, or describes permitted play.

### Warning / support guidance

Use for low-severity first incidents where a clear explanation is sufficient and no security hold is needed.

The current operator backend does not need a special gameplay mutation for a warning; communication can occur through support while the report is resolved.

### Temporary hold

Use when immediate protection is necessary while evidence is reviewed, including suspected account compromise, payment/reward fraud or a competitive-integrity investigation.

A hold is not a final finding. It prevents sensitive/economy activity while preserving evidence.

### Temporary suspension

Recommended baseline after approval:

- 24 hours for a low-severity confirmed first competitive/conduct violation;
- 7 days for a repeated or material violation;
- 30 days for serious repeated abuse, deliberate competitive manipulation or substantial service abuse.

These durations are proposed defaults and require Antimatter Innovations approval before being represented as effective public policy.

### Permanent suspension

Reserve for severe or repeated conduct such as:

- sustained cheating/botting after prior enforcement;
- organized collusion/fraud;
- account/payment attacks;
- serious threats/harassment;
- repeated suspension evasion;
- behavior that creates a material security risk to other users or the service.

Permanent action should receive a second reviewer where operationally practical.

## 5. Competitive results and currency

Moderation is not a manual economy tool.

Operators must not arbitrarily:

- grant or remove Coins/Crowns;
- rewrite Elo;
- choose a tournament winner;
- transfer one player's funds to another.

Existing server settlement/refund/revocation rules remain authoritative.

If a live event is affected by an account hold or service fault, use the existing deterministic review/void/refund paths rather than manual wallet editing.

## 6. Appeals

Proposed public appeal path:

`contact@antimatterinnovations.com`

An appeal should include:

- Mega XO player tag;
- approximate date/time;
- the relevant support/reference code if available;
- a short explanation.

Players should never send passwords, OTPs, session cookies, private keys or full payment-card information.

Recommended handling:

1. a reviewer who did not make the original permanent-suspension decision should review the appeal where staffing permits;
2. review the original evidence plus material new information;
3. record the outcome/reason in the operator audit;
4. restore access if the action cannot be supported by the approved evidence standard.

## 7. Report resolution

Repository-supported report outcomes remain:

- `no_action`
- `action_taken`
- `duplicate`

The report outcome and any account hold/suspension remain separate audited actions.

## 8. Privacy and retention

The final approved retention schedule must define durations for:

- open reports;
- resolved report metadata;
- moderation evidence;
- suspension/appeal records;
- operator audit history.

Account deletion already removes reports submitted by the deleting player and strips free-text detail from reports targeting the deleted player while preserving only the minimum pseudonymous integrity evidence supported by the deletion implementation.

Do not put passwords, OTPs, session cookies, raw receipts or unrelated private data into moderation reasons.

## 9. Authorized operators

Before public launch, Antimatter Innovations must name the roles/people allowed to:

- review/resolve reports;
- apply/release account holds;
- suspend/unsuspend accounts;
- inspect operator audit history.

Use individual operator identifiers. Do not share a generic moderator identity in audit records.

## 10. Approval checklist

Before marking this policy effective:

- [ ] approve player-conduct language;
- [ ] approve action ladder and suspension durations;
- [ ] approve permanent-suspension review standard;
- [ ] approve appeal path and expected response process;
- [ ] approve moderation/report retention durations;
- [ ] name authorized moderator/operator roles;
- [ ] align Privacy Policy/Terms with the approved moderation policy;
- [ ] publish any player-facing conduct/appeal text required for launch;
- [ ] run the staging moderation/operator drill under EXT-28/29.

Once approved, record an immutable policy version and update `deploy/MODERATION-RUNBOOK.md` and `docs/V4-OPEN-BLOCKERS.md`.
