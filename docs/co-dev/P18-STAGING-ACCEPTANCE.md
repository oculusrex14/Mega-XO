# P18 preparatory staging acceptance harness (co-developer)

This dedicated branch implements independent P18 foundations **before** G17.
P18 G18 cannot pass until the integrated Vercel/Neon/Redis/Core/worker staging
platform is deployed, isolated and observed. P06+ implementation and the
authoritative docs/v5/progress.json remain owned by the integration agent.

## Implemented

1. scripts/v5/p18/staging-isolation.js checks that the actual committed dev,
   staging and dormant-production Neon inventories have distinct IDs/hosts,
   runtime role limits and disabled outbound provider effects. These are
   declarative static checks, **not** actual remote provider observation.
2. scripts/v5/p18/acceptance-registry.js maps all five P18 tasks to the
   project's A01-A40 acceptance matrix, with status NOT_EXECUTED_IN_STAGING.
3. scripts/v5/p18/stage-evidence.js validates exact source/environments,
   per-case results and required evidence references without credentials.
   Even all five reported PASS results are only ALL_PASS_CLAIMS_UNVERIFIED.
   The integration owner must review real staging facts; this tool cannot
   mark G18 accepted or modify the program's progress ledger.
4. scripts/v5/p18/disposable-service-journeys.js runs REAL pre-existing P04
   SQL-backed account/social/save/economy and P05 actor/refresh tests on an
   exclusively owned, ephemeral LOOPBACK PostgreSQL16 database. It refuses
   Neon/production URLs, missing ownership markers, provider credentials,
   zero test counts, failures and skipped assertions. Its sanitized reports
   explicitly state that live staging has NOT been tested.
5. .github/workflows/v5-p18-acceptance.yml runs read-only fixture/static CI
   and a separate owned PostgreSQL 16 service job. Only sanitized JSON evidence
   is retained; no raw rows, signing keys, receipts or provider tokens.

## Integration requirements to execute P18 properly

- V5-18-01: operator checks actual Vercel/Neon/Redis/Core/worker target IDs,
  permissions, callbacks, provider/email sandboxing and prevented production
  effects; execute negative access probes after G17 is accepted.
- V5-18-02: execute retained browser and real native-style account, link,
  recovery, friends, saves, revocation, privacy and device journeys against
  the INTEGRATED staging platform. Static fixtures are not cross-device proof.
- V5-18-03: exercise ranked/casual/direct/tournament, receipt/SSV fixtures,
  Worker retries and Core restarts, with exact wallet/rating/escrow invariants.
- V5-18-04: compare four themes on real browser/native viewports against
  the private P00 screenshots; preserve approved gameplay, Crown utility and
  ad placement. Native exceptions require actual screenshots and approval.
- V5-18-05: rehearse import/reconcile/read-only handover on ISOLATED COPIES;
  demonstrate abort-before-first-write and PG-only recovery after first write.
  Neither production V4 nor dormant V5 production writer may be touched.

P21 website remains deferred. Co-dev never edits P04+ runtime service paths,
docs/v5/progress.json, payment/ad policy, or any production service.
