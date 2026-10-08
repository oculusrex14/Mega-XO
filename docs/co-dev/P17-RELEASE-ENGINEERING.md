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
