# V4.1 Oracle/VPS capacity acceptance

This runbook qualifies the single authoritative production coordinator on the actual target hardware without touching staging or production player data.

The harness starts the real production runtime against a disposable temporary SQLite database and exercises authenticated sessions, cloud saves, community reads, real casual matchmaking, authoritative match moves, reconnect-style reads, password-worker contention, and deterministic inflight saturation.

It deliberately does not create a test-only public endpoint.

## Run on the Oracle ARM host

Use the exact immutable release-candidate image and the same resource envelope as the app service:

    docker run --rm --platform linux/arm64 \
      --cpus=2 --memory=2g --pids-limit=256 \
      --tmpfs /tmp:size=1024m,mode=1777 \
      -e MEGA_CAPACITY_CLIENTS=24 \
      -e MEGA_CAPACITY_ACCOUNTS=2000 \
      -e MEGA_CAPACITY_ROUNDS=12 \
      -e MEGA_CAPACITY_MAX_INFLIGHT=32 \
      --entrypoint node \
      ghcr.io/oculusrex14/mega-xo@sha256:<digest> \
      scripts/capacity-acceptance.js | tee capacity-acceptance.json

Run at least three times after the machine has been idle for five minutes. Then repeat at 48 and 64 clients.

Do not mount /opt/mega-xo/data, do not mount a production database, and do not point the harness at a public hostname.

## What the report contains

The JSON report includes:

- route p50/p95/p99/max latency;
- nominal request and unexpected-error counts;
- password verification p50/p95/p99;
- event-loop p99 delay;
- RSS memory;
- database and WAL bytes;
- the number and latency of controlled 503 responses when inflight work is saturated;
- the exact clients/accounts/matches/inflight configuration.

The run is functionally acceptable only when functionalPass is true, nominal traffic has zero unexpected errors, matchmaking creates exactly one match per pair, auth verification succeeds, and the saturation phase produces controlled 503 backpressure while the process remains alive.

## Choosing production limits

Do not choose the largest value that survives once.

Record at least three runs per concurrency level and identify the first level where p95/p99 latency, event-loop delay, RSS, or error rate rises sharply. Keep MEGA_MAX_INFLIGHT, MEGA_MAX_CONNECTIONS, MEGA_MAX_QUEUED, and auth worker count below that degradation point with headroom for backups, Caddy, the OS, and transient bursts.

The harness is hardware-local and does not measure public Internet or TLS latency. Keep deploy/staging-smoke.sh as the live edge/TLS/DNS check.

## Evidence for EXT-31

Record only non-secret facts:

- immutable image digest and Git SHA;
- Oracle VM shape, architecture, allocated CPU and RAM;
- harness config;
- three-run p50/p95/p99 summary;
- event-loop p99 and RSS;
- backpressure onset;
- selected production concurrency limits.

Do not commit cookies, raw account tokens, raw logs, database files or host secrets.
