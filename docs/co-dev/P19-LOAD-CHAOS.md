# P19 co-development — load and chaos foundations, not G19

P19 formally requires P18 acceptance and fully integrated staging. This
isolated branch owns P19 scripts, tests, a dedicated read-only workflow and
handoff documentation only. The integration agent owns P06+ runtime services
and the authoritative docs/v5/progress.json. No production infrastructure,
public DNS, Oracle/Vercel/Neon provider, or real user data is touched.

## P19-01: explicitly forecast-unknown traffic

- workload-profile.js gives reproducible seeded ILLUSTRATIVE API read, auth,
  socket, move, matchmaking, tournament, worker and sandbox callback weights
  over four tightly capped 1/2/4/8-client virtual tiers.
- Forecast is UNKNOWN, weights are NOT predicted player behavior, unbuilt
  services are explicitly NOT EXECUTED. No external HTTP/WebSocket load tool
  is silently applied to public endpoints.

## P19-02: actual small synthetic PG and Redis measurements

- metrics.js measures monotonic p50/p95/p99, throughput, errors, peak
  concurrency, CPU/heap/RSS and event-loop utilization; errors are included
  in latency and categorized without leaking messages/tokens/player IDs.
- disposable-adapters.js requires explicit test ownership and exact
  loopback control endpoints, rejects provider/prod credentials and caps
  both the operation count and concurrency.
- tests/v5-p19-real-services.test.js runs the ACTUAL P04 guarded API account
  and Core services and P06 real Redis primitives, using 3 synthetic actors
  in a uniquely-owned PG16 test database. It measures four tiny tiers:
  API profile read, economic coin-to-Crown conversion, ephemeral presence
  and Redis rate window. After every tier it audits wallets, ledger,
  outcome and outbox exactly-once invariants and then repeats a committed
  command to prove no extra effect after a lost response.
- .github/workflows/v5-p19-load-chaos.yml has a pure-policy job and a
  real disposable PostgreSQL/Redis integration job using exact reviewed
  container digests and read-only GitHub permissions. It emits only sanitized
  metrics, never raw economic rows, receipts or connection strings.

## Interpretation and limits

Measured throughput reflects one GitHub CI runner's local adapter calls
and MINIMAL three-actor fixture history. It is not Vercel/API socket
latency, Core A/B throughput, Oracle host capability, the future Neon plan,
or a sustainable launch envelope. A 10x benchmark is not a guarantee.
G19 stays OPEN until P18 acceptance, real staging infrastructure, measured
history and controlled failure/recovery observations. No change to bought
Crown spending behavior or gameplay restrictions is introduced.

Do not run tests on V4 production, on non-isolated Oracle resources or
against a public domain. Production data may not be modified, purged or
used to fill fake history. Later independent P19 commits can add isolated
chaos and resource/alert reporting without assuming production targets.


## P19-03: actually executed disposable failure scenarios

- chaos-contract.js lists nine specific P19 faults with separate status and
  G19 refusal. Four can be exercised today on the real PG/Redis adapters;
  the remaining five (full PG outage, Core A/B death/WebSocket reconnect,
  worker crash/catch-up, reordered provider callbacks and pubsub backpressure)
  are NOT EXECUTED until P18 staging has the corresponding real services.
- tests/v5-p19-real-chaos.test.js performs an ACTUAL owned Redis namespace
  wipe, Core service instance reopen and durable retry, duplicate concurrent
  same-key economic commands, and an intentional 75 ms PG read stall. It
  hashes every canonical row across 10 durable tables before/after each
  fault and refuses any mutation. It does NOT kill a process/host, stop PG,
  test network partitions or claim an alert delivery result.
- CI uploads only sanitized scenario IDs, durations, equality fingerprints
  and unresolved scenarios; neither raw identities nor provider secrets
  are retained. A passing synthetic test is never called a G19 acceptance.
