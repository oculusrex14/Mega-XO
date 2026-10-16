# V5.2 independent security review — Main (2026-10-16)

**Scope.** The security-sensitive surfaces of the newly merged V5.2 consolidation candidate
(`origin/V5.2`, head `911fad8` at review start; fixes applied on top). This is Main's independent
audit, performed against the code, not the PR authors' comments. A dedicated independent reviewer
(security-reviewer subagent) produced the raw findings; every one was re-verified by Main at
file:line before acting.

**Method.** Source reading of the merged commerce/payment/deploy surface + the LR06 core security
suites executed on the merged head. No production change, no live provider calls, no secrets read.

## Executed evidence (merged head)

| Suite set | Result |
| --- | --- |
| LR06 core: v5-p13-security, v5-p11-session-boundary, v5-p05-tickets, production-auth, provider-authorization, v51-audit-ticket-boundary, v52-web-oauth | 36 pass / 0 fail / 12 env-gated skips |
| Merged-PR security: deploy-production-guards, mail-resend, commerce-ingress, apple-team-association, compose-fence, store-pg-adapter, r2-list-pagination | 36 pass / 0 fail |
| Advanced #29: cashfree-v5, commerce-ingress, rate-limit, metrics, v5-production-server | 35 pass / 0 fail |
| Security regression set after the fixes | 43 pass / 0 fail |

## Findings and dispositions

| ID | Sev | Surface | Disposition |
| --- | --- | --- | --- |
| SEC-V52-ACTOR-OVERRIDE | **HIGH** | `core-gateway.js:981` | **FIXED** (commit `4d4caa8`) |
| SEC-V52-IDEMPOTENCY-KEY-PRECEDENCE | LOW | `apps/api/routes/monetization.js:37` | **FIXED** (same commit) |
| SEC-V52-SSV-UNLIMITED-DOS | MEDIUM | `apps/api/routes/monetization.js` + facade | Reviewed — owner decision (below) |
| SEC-V52-CASHFREE-IDEMPOTENCY-RACE | MEDIUM | `packages/services/commerce.js:564` | Reviewed — owner decision (below) |

### HIGH — actor override at the signed trust boundary (FIXED)

`/ingress/commerce/command` did:

```js
commerce.command({ actor: actorHeader, opKey: opKeyHeader, ...input })
```

The request-supplied `command` spreads last, so a signed caller placing `actor` inside the command
overrode the signed session actor. The top-level guard only re-checks `parsedBody.actor`, and
`commerce-ingress` then trusts `input.actor` for the player ops — so a caller could act on an
arbitrary player (ticket/claim/permit/purchase/cosmetic) for that actor. CWE-284/CWE-287.

**Fix:** the signed header is authoritative — the untrusted input spreads first, then the headers
are forced (`{ ...input, actor: actorHeader, opKey: opKeyHeader }`). This is defense-in-depth: the
current API route already strips `actor` from forwarded commands, but the trust boundary must not
depend on every caller doing so. A regression test asserts the spread order and was proven to fail
on the old code.

### LOW — idempotency key precedence (FIXED)

`opKeyFrom` read `Idempotency-Key`/`X-Opkey` before `body.key`, contradicting its own documented
contract ("a body.key wins over the header"). A client whose header drifted from its body key would
change the idempotency identity. Now body-first.

### MEDIUM — actor-free SSV/webhook lanes are unthrottled (owner decision)

`/api/monetization/admob-ssv` is public and unauthenticated by design (Google calls it), and
`/api/monetization/cashfree/webhook` likewise; only the per-actor `command` lane is wrapped by
`monetizationLimiter`. Neither actor-free lane is rate limited, so the ingress ECDSA verification is
unbounded. A per-actor limiter cannot apply (there is no actor). A correct fix needs an
**IP/edge-based limit policy** (Caddy `rate_limit` or a durable IP-window limiter) — a trust-model
and threshold decision that belongs with the owner, not a unilateral code change. Also note the
`ssv` facade signature is currently `(raw)` while the route calls `lane.ssv(raw)` after checking
`lane.ssv` exists — the interface shape should be reconciled regardless.

### MEDIUM — Cashfree createOrder before the idempotency fence (owner decision)

`createCashfreeOrder` calls `provider.createOrder` (external I/O) **before** the transaction that
enforces the `(actor, op_key)` unique constraint. Two concurrent creates with one key both call the
provider; the loser's transaction records nothing (`ON CONFLICT DO NOTHING`) and returns the
winner's row, orphaning one provider-side payment session. It does **not** double-grant (settlement
is still keyed and idempotent), so the impact is orphaned/confusing provider orders. A correct fix
is a reserve-then-create flow (insert a PENDING order under the unique fence, then call the
provider) — an economic-flow change that needs an owner-level call on the order state model.

## Not verifiable from the repo alone

- Live AdMob SSV end-to-end grant (needs the AdMob console URL registered + real ad units).
- Real Cashfree settlement/refund (needs KYC-approved live credentials).
- Device-lane security: key attestation and the store signing chain (LR08/LR20, device-gated).
- `/opsz` backup-freshness and the LR18 retention-timer misdirection are host/ops items, tracked
  separately (`LR18-RETENTION-DR-LIVE-20261016.md`), not source-auditable here.

## Residual

The two MEDIUM items and the LR18 P0 retention-redirect are recorded as owner-actionable. No
security check was weakened to reach green; the two fixes strictly tighten the audited surfaces.
