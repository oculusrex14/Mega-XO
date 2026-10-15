# Vercel deployment state and the native identity conflict (2026-10-15)

Goal priority (3) — "take over Vercel deployment … with real Oracle Core connectivity, receipts and
rollback" — read from the live provider state rather than assumed.

## What exists now

| Project | Id | Root | Production URL | Live |
| --- | --- | --- | --- | --- |
| `mega-xo-api` | `prj_y2zGwwGwk3zVdP6sevw5S3z5qN65` | `apps/api` | `https://api-azure-beta-73.vercel.app` | `/livez` → `200 {"status":"ok","live":true,"ready":true}` |
| `mega-xo-web` | — | — | `https://web-nine-phi-f2vlp4rde0.vercel.app` | `/` → `200` |

Both are in the owner's existing `oculusrex14s-projects` (Hobby). No plan upgrade was made.

## Finding 1 — the deployed API has no database pool (real blocker)

```
GET https://api-azure-beta-73.vercel.app/api/account/session
→ 409 {"error":"NO_DATABASE_POOL_OR_ACCOUNTS_SERVICE"}
```

`/livez` answers 200 because liveness does not need the database, but **no real V5 account route can
serve**. Cause: `vercel env ls` shows `MEGA_PG_TARGET_B64` scoped to **Preview, Development** only —
there is no Production-scoped database target — and `MEGA_CORE_URL` is likewise Development/Preview.
So the production deployment cannot compose the accounts service.

This is the honest state: the API project is deployed but not backed by a database in Production.
Enabling it is a cutover-adjacent action (it points production traffic at real data), so it belongs
with the single-writer decision, not before it.

## Finding 2 — the DEPLOYED native identities conflict with my alignment

The live association files on that deployment declare:

| Surface | Deployed value |
| --- | --- |
| Android package | **`com.antimatterinnovations.megaxo`** |
| Android fingerprint | **`14:6D:E9:D6:0F:7B:D1:72:3B:86:70:E8:6B:0A:86:B1:24:F2:88:18:C4:0D:02:D0:6A:40:06:50:57:3E:CA:3F`** — a REAL certificate, not the placeholder |
| iOS appID | `TEAMID.com.antimatterinnovations.megaxo` |

Meanwhile I aligned this branch's association route and both native targets to the owner-requested
**`online.megaxo.xoxo`**. Two different permanent identities now exist, and the deployed one carries a
**real upload certificate fingerprint** — which means Codex has registered real app identifiers, and
the Android release keystore behind that fingerprint is **not** the upload key I created earlier.

**I am not going to silently overwrite Codex's deployed registration with my branch's value.** Which
identity is permanent is the owner's call, and picking wrong means shipping an app whose
app-links/universal-links never associate and whose store record does not match its package.

## What must be decided before either lane proceeds

1. **Permanent Android package id**: `online.megaxo.xoxo` (owner-requested, currently in this branch)
   or `com.antimatterinnovations.megaxo` (registered by Codex, with a real certificate fingerprint)?
2. **The Android upload key.** If `com.antimatterinnovations.megaxo` is permanent, the release AAB must
   be signed with the key whose fingerprint is `14:6D:E9:D6:…` — I must not create or use a different
   keystore, or the association and Play App Signing setup break. That keystore is not on this machine.
3. **The iOS bundle id** must match whichever app id is registered in App Store Connect and in the
   `appIDs` entry, or universal links will not work.

Until that is resolved, this branch carries the owner-requested id (which is the more defensible
default, being the owner's explicit request) and the association route **still keeps the certificate
fingerprint as a clearly-labelled placeholder**, because I do not hold a certificate whose fingerprint
should be published.
