# P17 independent co-development

The isolated co-dev/v5-release-engineering branch owns only new additive
release tooling, tests and CI; the integration agent owns P04+ persistence,
identity, contracts and docs/v5/progress.json. P17 G17 is not complete early.

- scripts/v5/ci-impact.js classifies NUL-delimited git changes, including
  shared/unknown paths as full fan-out. It NEVER skips existing full Node,
  UI or live PostgreSQL CI. Native CI is a separate required gate once its
  P20 PR is integrated into the active V5 branch.
- scripts/v5/release-source-candidate.js hashes the checked-in SQL ledger
  and protocol/native packaging contracts for an exact commit. It creates a
  reproducible SOURCE_ONLY_NOT_DEPLOYABLE manifest, not a release, with zero
  invented service digests, Vercel deployment IDs, provider credentials or
  reported acceptance.
- .github/workflows/v5-release-engineering.yml runs on V5-platform and
  PRs against that branch using read-only checkout, no signing secrets,
  no database/infra provider connections and no deployment credentials.

The future integration owner must prove separate ARM64/AMD64 Core/worker
images, Vercel production-configured staged deploys, real compatibility
and schema migrations under an owner-held lock, trustworthy per-component
CI, staging rollback rehearsals and owner-approved secret-scoped release
contexts before G17 acceptance. No production action is enabled here.

## Early P17 compatibility policy (not release authorization)

- scripts/v5/release-compatibility.js reads only named .artifacts JSON
  operator-observation and contract-range files, and makes a DRY-RUN decision.
  It rejects unknown authority, unfenced V4 writers, schema/protocol mismatch,
  release-version reuse and non-compatible PostgreSQL rollback.
- A successful decision always says COMPATIBLE_CONTRACTS_ONLY with
  authorizesDeployment=false. It neither proves the operator observation,
  nor stages/promotes Vercel, applies a migration or transfers authority.
- scripts/v5/ci-safety-audit.js ensures this PR-only source CI is read-only
  with exact action SHA pins, no provider secrets and bounded artifacts.
  Do not apply its PR-only rules to the separate historical V4 tag publisher.

Later P17 integration must verify actual service digests, exact production
Vercel build, approved environment reviewer policy, schema/wire compatibility,
stable CLI pins and a prior compatible PostgreSQL fallback. No live resource,
credentials, signed store artifact or provider approval was invented here.

## Immutable artifact references (structural only, no production action)

The source-only candidate is not a deployable release. When P08-P11 publish
actual independent API/Core/worker artifacts, the owner can use
scripts/v5/release-artifact-references.js to validate the reference envelope.
It requires: an actual-looking production-configured Vercel deployment ID
staged without domain assignment, distinct immutable GHCR digests with
linux/amd64 and linux/arm64 for Core and worker, the SAME exact source
commit for each component, and three named CI run references at that commit.

This validation is deliberately labeled structural only. JSON can lie
about an image digest or a CI run ID; the owner must independently verify
GHCR manifest/pull availability, signed provenance, GitHub CI conclusions,
Vercel project/environment and a compatible PostgreSQL fallback before any
deployment, promotion or rollback. PR jobs have no credentials to do so.

## Read-only remote CI evidence

`scripts/v5/release-verify-github-ci.js` optionally fetches the three exact GitHub Actions run IDs from the GitHub API, rejects other SHA/repo/workflow/event, pending or failed results, and still refuses to authorize deployment. It is not invoked on a source-only PR because no real service artifact descriptor exists yet. Unit tests use injected offline API fixtures. Remote GHCR, Vercel and protected environment checks remain separate future work.
