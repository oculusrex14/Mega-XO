# Inspection utilities

These are planning-pack utilities, not production deployment scripts. They only read local Git/files and, when requested, fixed public endpoints or fixed SSH inspection commands. They create explicitly requested local evidence files. They never create branches, reset/clean Git, provision providers, change DNS, deploy/restart containers, initialize backups, run database migrations or change player state.

## Read-only preflight

Use an evidence path outside the repository. Existing files are never overwritten.

```sh
python3 /path/to/pack/tools/read-only-preflight.py \
  --repo /path/to/Mega-XO \
  --output /path/to/private-evidence/v5-preflight.json
```

This captures Git state and installed-tool paths, not provider authentication. To add public status/perimeter probes and the known Tailscale SSH alias:

```sh
python3 /path/to/pack/tools/read-only-preflight.py \
  --repo /path/to/Mega-XO \
  --output /path/to/private-evidence/v5-preflight-live.json \
  --public-probes --ssh --ssh-alias command
```

SSH uses batch mode and strict existing host-key verification. It does not enroll a new host key or read any secret/environment file. Fixed remote reads are machine version, Docker names/images/status/ports, monitoring timer state, listening TCP ports and disk usage. Docker inspection may require the already reported `sudo -n` access. Missing access is recorded, not fixed by opening public SSH.

Public probes retain status/header/boolean/hash observations, not page bodies/cookies. Failed DNS from the running environment is not proof the site is globally unavailable. The tool does not verify backup object contents, current provider accounts/plans, or physical devices; the phase-specific checks still apply. Outputs are mode 600 and may contain operational metadata; keep them private.

## Source-change baseline

Capture from the actually selected approved Git commit:

```sh
python3 /path/to/pack/tools/ui-baseline.py capture \
  --repo /path/to/Mega-XO --base VERIFIED_BASE_SHA \
  --output /path/to/private-evidence/approved-source-baseline.json
```

Check current working files:

```sh
python3 /path/to/pack/tools/ui-baseline.py check \
  --repo /path/to/Mega-XO \
  --baseline /path/to/private-evidence/approved-source-baseline.json
```

Exit 0 means no unreviewed protected-source differences; 1 means differences need review; 2 means tool/input error. Capture hashes approved CSS/HTML/assets, selected UI controllers and rule files. It does not package their bytes or expose font files. It detects new protected files surfaced by Git's tracked/nonignored file inventory. It is not a complete import-graph or visual-security audit.

Approved local changes not committed to Git must first be preserved and reconciled with the selected baseline. Do not discard them just to make this check pass. Transport/extraction work can legitimately modify a protected controller or rule module; document the exact change and its parity evidence rather than blanket-excluding the file.

An optional reviewed exception file has this structure:

```json
{
  "changes": [
    {
      "path": "src/community.js",
      "sha256": "EXACT_REVIEWED_NEW_SHA256",
      "reason": "Specific nonvisual transport adaptation or unavoidable platform requirement",
      "evidence": "Commit and executed UI/gameplay parity report reference"
    }
  ]
}
```

Pass it with `--exceptions /path/to/exceptions.json`. Wildcard/path-only exceptions are not supported; the current hash must match. Symlinks require manual review and are not read through. A hash check never replaces screenshots, accessibility/device tests or seeded gameplay parity.

## Package verification

```sh
python3 tools/validate-pack.py .
```

Checks JSON/Python syntax, phase/task identities and dependency cycles, owner-deferred website bypass, relative links, untouched original sources and the complete SHA-256 manifest. `--structure-only` is for authoring before the final checksum manifest exists. No dependencies beyond Python 3.10+ are required.

No implementation or production gate is marked passed by these utilities. Their own QA results in `evidence/package-qa.json` concern this handoff package, not the Mega XO application.
