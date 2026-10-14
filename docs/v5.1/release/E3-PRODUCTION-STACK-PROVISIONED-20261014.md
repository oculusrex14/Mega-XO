# E3 — production V5 stack provisioned (2026-10-14)

Executed by Main under the owner's 2026-10-14 authorization. The production stack is **built and
provisioned**; it is deliberately **not started**, and the V4 authority is untouched.

## Immutable image

| Field | Value |
| --- | --- |
| Source SHA | `07c9fbabf7107216c8ca727ed7f078d4d8db1c27` |
| Built from | `git archive` of that exact HEAD, `Dockerfile`, on host `command` |
| Local image | `mega-xo-v5-candidate:07c9fbabf7107216c8ca727ed7f078d4d8db1c27` |
| **Image digest** | `sha256:41b8b7a3283647d76cf0929cb809bd072422f722759f1df8484ace06f6b4a792` |
| Size | 393 MB |
| Revision label | `org.opencontainers.image.revision = 07c9fbab…` (verified) |

The image is built locally on the host, so the immutable digest is reproducible from the source
without a registry round trip. No tag is used at deploy time — the digest is.

## Production tree

```
/opt/mega-xo-v5-production/
  src/        # the exact HEAD checkout (build input; not the deploy source)
  bin/        # host tooling (backup/freshness)
  state/      # runtime state
  secrets/    # 0600 secret files (below)
```

`/opt/mega-xo` (live V4) and `/opt/mega-xo-staging` were not touched.

## Secrets placed (all mode 0600, none ever printed)

| File | Bytes | Purpose |
| --- | --- | --- |
| `api_runtime.pw` | 43 | `api_runtime` LOGIN password |
| `core_runtime.pw` | 43 | `core_runtime` LOGIN password |
| `worker_runtime.pw` | 43 | `worker_runtime` LOGIN password |
| `backup_reader.pw` | 43 | `backup_reader` LOGIN password |
| `audit_runtime.pw` | 43 | `audit_runtime` LOGIN password |
| `neon-ca.pem` | 181 304 | Neon TLS root CA (`verify-full`) |
| `core-gateway.secret` | 65 | Core ingress HMAC key (freshly generated, 32 random bytes as hex) |
| `redis-production.url` | 87 | Aiven Valkey production target (`valkey-463b5ea-mega-xo.i.aivencloud.com:14329`) |

The role passwords are the ones provisioned by `provision-pg-roles.js` for the production project
(`docs/v5.1/release/PRODUCTION-PG-PROVISIONED-20261014.md`). The Core HMAC secret is new for
production specifically so that **production and staging cannot share a signing key**.

## Composition

`scripts/v51/v5-production-server.cjs` (committed) is the production entry point. It:

- binds an **exact** production target (`project/branch/db+endpoint`), derives a distinct
  `MEGA_V5_PRODUCTION_*` namespace and a distinct Redis key namespace, and **refuses to start while
  the bound target is `nonserving`**;
- asserts at boot that the API pool is `api_runtime` and holds **no Core handle**, that Core/queue/
  leaderboard/realtime run on `core_runtime`, and that the ticket issuer is `api_runtime`;
- enforces provider classes only from the target file (production.json disables email, store
  notifications and ad rewards);
- requires a loopback bind and 0600 absolute secret files, and never prints a secret.

## Explicitly not done (E4/E5)

- The V5 production process is **not started**; no endpoint is switched; no first production write
  exists; no authority epoch has been recorded.
- The Core ingress for production is not yet given a production route: `core.megaxo.online` still
  fronts the **staging** Core, which must be repointed at cutover so a production API can never
  resolve a staging Core.
- Publishing the image to `ghcr.io` is not required by this deploy path (the host builds locally), so
  the "published release" step of the release workflow is not exercised here.

## Honest status

E3's engineering is **done and reversible**: image digest, least-privilege roles, isolated secrets,
non-crossover namespace and a fail-closed entry point. E4 (fence) and E5 (first write, endpoint
switch, verification) remain, and they are the irreversible pair.
