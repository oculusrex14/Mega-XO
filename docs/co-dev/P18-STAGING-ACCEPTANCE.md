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

## P18-04 source and private visual evidence

- The approved P00 source baseline already enumerates 21 real client
  files/hashes/sizes. scripts/v5/p18/visual-baseline.js --source-freeze
  checks that no approved code, gameplay, currency utility, theme or legal
  page content has changed without review.
- Private visual captures remain in the owner's restricted evidence store.
  compareCaptures() verifies actual PNG file bytes, file hashes, dimensions,
  complete four-theme screen coverage and distinguishes matching bytes from
  unreviewed visual differences. A screenshot hash match is not proof of
  usability, native accessibility or device parity; real screenshots and
  platform exceptions require independent review.
- scripts/v5/p18/cutover-state-model.js exercises the source-authoritative
  PREPARED -> FROZEN -> IMPORTED -> ARMED -> V5_AUTHORITY process in synthetic
  event traces. It rejects dual writers, changing frozen snapshot hashes,
  nonzero reconciliation differences, post-first-write SQLite rollback and
  missing first-write evidence. These are **model tests**, not a live cutover
  or a permission to activate the staging/production writer.

## Source deviations requiring deliberate G18 review

The current V5 branch contains a prior agent-owned source change to
src/game.js: the AI search clock can be injected while its default preserves
the browser/Node time reading. The P00 source-byte hash therefore differs.
The P18 PR records this in p18-source-freeze.json via --inspect-source and
does NOT silently rewrite P00 hashes, revert agent code, or call it approved.
The later owner G18 visual/gameplay parity decision must review this as a
concrete behavior-equivalence case with actual tests/screenshots.
--source-freeze remains the strict command that fails when bytes diverge.

## P18 integrated staging topology intake

When the agent provides an actual isolated Vercel/Redis/Core/worker staging
inventory, scripts/v5/p18/staging-topology.js --file .artifacts/name.json
validates it against the committed exact staging Neon IDs, the V5 player
audiences, an unassigned staging-only Vercel deployment and sandboxed
email/store/ad callbacks. Any production resource overlap or embedded
credential is refused. The validator has NO network side effects and never
marks the remote inventory actually observed. The owner must subsequently
verify provider-side IAM, callback routing, Tailscale/private-network
isolation and outbound delivery controls from real staging observations.

## Executed synthetic data-transfer and economy parity coverage

The owned-loopback PostgreSQL job now executes five complete existing real
implementation suites instead of two: immutable SQLite snapshot import and
restart/replay, per-actor PostgreSQL reconciliation including swapped-wallet
negative cases, V4 SQLite-vs-V5 PostgreSQL game/economy differential, full P04
account/economy services, and P05 cross-client session/revocation composition.
Every suite must report passing TAP assertions and zero failures/skips.
This does NOT exercise provider-hosted staging or production authority.

## P18-03 controlled complete Redis loss

The P18 disposable job now starts the same digest-pinned Redis 7.4
service used by the current V5 P06 integration workflow. The executor
rejects anything except an explicitly owned loopback Redis endpoint,
and supplies mandatory no-skip flags. It runs the existing real
P06 suite: bounded/isolated namespaces, concurrency/locks,
ticket + revocation consistency, loss/wipe and byte-stable
PostgreSQL wallet/rating truth. A green result remains a
synthetic disposable environment test, not G18 staging execution.
