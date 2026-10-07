# V4 immutable production release runbook

This runbook publishes and deploys the first V4 backend release only after the external launch gates are complete.

The release signal is a signed-by-process Git tag such as **`v4.1.0`**. The tag must match `package.json.version` exactly.

## 1. Mandatory release gates

Before creating a tag, update `docs/V4-OPEN-BLOCKERS.md` with non-secret evidence and mark these rows **COMPLETE**:

```text
EXT-01 through EXT-05
EXT-07 through EXT-16
EXT-27 through EXT-30
```

`EXT-06` (Google/Apple production credentials) is intentionally not a backend-release gate because V4 can launch with verified email only while those providers remain disabled. Enabling them later requires their own acceptance gates.

`EXT-17` is the release itself and therefore remains BLOCKED until this runbook completes.

The CI release gate in `scripts/release-gate.js` refuses a tag when:

- the tag is not `v4.x.y`;
- the tag does not exactly equal `v<package.json.version>`;
- the Git SHA is missing/invalid;
- any mandatory blocker row is missing;
- any mandatory blocker is not `COMPLETE`.

## 2. Freeze the release commit

On the V4.1 branch:

```bash
git switch V4.1
git pull --ff-only
git status --short
```

Expected: no local modifications.

Record the exact SHA:

```bash
git rev-parse HEAD
```

The exact SHA must already have a green GitHub Actions run including:

- full Node regression;
- invariants;
- balance/economy/monetisation models;
- seeded production workload;
- Chromium flows;
- deployment shell checks;
- amd64 image acceptance;
- ARM64 image acceptance.

Do not tag an unvalidated follow-up commit.

## 3. Confirm version/tag

For the V4.1 release:

```text
package.json version = 4.1.0
Git tag              = v4.1.0
```

Before later releases, bump `package.json.version` in a separate reviewed commit and rerun exact-head validation.

Run the gate locally:

```bash
GITHUB_REF_NAME=v4.1.0 \
GITHUB_SHA=$(git rev-parse HEAD) \
node scripts/release-gate.js
```

Expected:

```json
{"approved":true,...}
```

## 4. Create and push the tag

Only after the gate succeeds:

```bash
git tag -a v4.1.0 -m "Mega XO V4.1.0 production backend"
git push origin v4.1.0
```

Do not retag or force-move a published production tag.

If the tagged commit is wrong, create a new patch version instead.

## 5. What GitHub Actions does

For a valid V4 tag, CI:

1. reruns the production release gate;
2. reruns full source validation;
3. builds and accepts both amd64 and arm64 containers;
4. logs into GHCR with the scoped GitHub token;
5. publishes one multi-architecture image;
6. attaches build provenance and SBOM metadata;
7. records the immutable GHCR digest;
8. uploads `immutable-release.json`;
9. creates the matching GitHub Release with the immutable digest and Git SHA.

Expected image form:

```text
ghcr.io/oculusrex14/mega-xo@sha256:<64 lowercase hex>
```

Never deploy:

```text
:latest
:V4
:v4.1.0
:sha-...
```

Those tags can help humans discover an image but the VPS deployment reference is always the immutable digest.

## 6. Verify the published image on the Oracle VPS

From the V4.1 repository on the VPS:

```bash
sudo bash deploy/verify-release.sh \
  ghcr.io/oculusrex14/mega-xo@sha256:IMAGE_DIGEST \
  TAGGED_GIT_SHA \
  4.1.0
```

The verifier checks:

- immutable digest syntax;
- successful pull;
- OCI revision label equals the expected Git SHA;
- runtime `MEGA_RELEASE` equals the expected Git SHA;
- package version equals the expected release version;
- pulled architecture matches the VPS architecture.

Do not deploy after a verification failure.

## 7. Deploy by digest

Production:

```bash
sudo bash deploy/release.sh \
  /opt/mega-xo \
  ghcr.io/oculusrex14/mega-xo@sha256:IMAGE_DIGEST
```

The release script:

- takes an exclusive deploy lock;
- validates Compose/configuration;
- drains active work;
- takes a pre-deployment SQLite online snapshot;
- never runs two coordinators against the same database;
- starts the new image;
- requires liveness/readiness;
- restores the previous **application image** if the new one cannot become ready;
- never silently rewinds the live database.

If a schema rollback requires data restoration, use the explicit restore runbook with downtime.

## 8. Post-deploy acceptance

Run on the VPS:

```bash
sudo bash deploy/audit-perimeter.sh /opt/mega-xo
sudo bash deploy/check-health.sh /opt/mega-xo
```

From a separate machine outside the VPS/network:

```bash
node scripts/external-perimeter-probe.js \
  play.antimatterinnovations.com \
  ORACLE_PUBLIC_IPV4
```

Then run the real email acceptance against production using a dedicated test mailbox alias:

```bash
node scripts/live-email-acceptance.js \
  https://play.antimatterinnovations.com \
  UNUSED_TEST_EMAIL
```

Do not use a real customer's account.

Confirm:

- HTTPS is valid;
- `/livez` = 200;
- `/opsz` = 200;
- backup freshness is healthy;
- UptimeRobot monitors are green;
- local systemd health timer is active;
- signup OTP arrives;
- reset OTP arrives;
- old test password is rejected after reset;
- same player profile returns with the new password.

## 9. Mark the release complete

Update `docs/V4-OPEN-BLOCKERS.md`:

```text
EXT-17 = COMPLETE
```

Non-secret evidence should include:

- Git tag;
- Git SHA;
- GHCR immutable digest;
- GitHub Actions run ID;
- production deploy timestamp;
- host perimeter audit pass;
- external perimeter probe pass;
- `/opsz` healthy;
- real email acceptance pass.

Never put secret values or OTPs in the ledger.

## 10. Roll forward, do not mutate releases

For any production correction after V4.1.0:

1. make a new source commit;
2. bump patch version;
3. rerun tests;
4. complete any new blockers;
5. publish a new tag;
6. deploy its new immutable digest.

Never force-push V4 release tags and never overwrite an already-published GHCR release identity.
