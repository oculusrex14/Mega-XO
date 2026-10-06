# V4 tasks 11-14 repository checkpoint

This checkpoint records repository-side readiness only. It does not claim that Oracle, Hostinger, Resend live acceptance, provider consoles, native stores, devices, or legal/compliance work have been completed.

Implemented:

- fail-closed V4 production tag gate tied to the external blocker ledger;
- immutable multi-arch GHCR release manifest, provenance/SBOM, GitHub Release handoff;
- VPS-side immutable image revision/version/architecture verification;
- real signup + password-reset Resend acceptance client with masked OTP input;
- production Caddy server-fingerprint suppression;
- host-side container/permission/network perimeter audit;
- outside-in public port + HTTPS/private-path probe;
- current Google OIDC web authorization contract (`openid profile`, PKCE, state, nonce, `sub` identity);
- live Google/Apple web authorization configuration smoke;
- explicit post-backend billing/ad/privacy/deletion/device/compliance gates;
- pinned GitHub Actions;
- pipefail-protected validation pipelines;
- syntax validation for operator handoff tooling.

External execution and evidence remain in `docs/V4-OPEN-BLOCKERS.md`.

A release tag must not be created merely because this checkpoint passes CI.
