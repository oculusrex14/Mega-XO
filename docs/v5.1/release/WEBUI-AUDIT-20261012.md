# Independent WebUI readiness audit - 12 October 2026

## Ownership and source boundary

Owner: ChatGPT WebUI. Integration owner: Main agent. Initial inspected V5.1 HEAD: `4e345fa1a90c5ba619cc2de6c8ce4eb03590d3e9`.

This is the coordination record for R01-R02 and independent regression/protocol review. WebUI owns this document, new `scripts/v51-readiness-*` tools, new `tests/v51-readiness-*` tests, and the new read-only `.github/workflows/v51-webui-readiness-audit.yml`. Changes to shared implementation files require a separate explicit handoff. Main retains the CI01/CI02 fixtures, service/native integration and training operator. Codex retains P21/browser/provider work. Original source ledgers are read-only inputs during this slice; audit overlays must not silently close their acceptance contracts.

No remote feature branch, force push, main/V4.1 change, deployment, provider mutation, model approval or production-data operation is authorized by this audit.

## Initial observations (not release acceptance)

- The open-work register contains newer Main-agent CI01/CI02 repair, isolated-composition, online-journey and GPU experiment notes than the consolidated CI checkpoint. Review the actual patches and matching runs before superseding the two historical failures.
- The register also appends cells beyond its declared Markdown table schema. A machine-checked evidence overlay is needed to avoid lost or misassociated status notes.
- Historical COMPLETE/DONE/checked labels remain source assertions, not staging/device/provider/production acceptance.
- A local `git ls-remote` failed because the WebUI execution container cannot resolve github.com. Connected GitHub reads/writes work. No local checkout, test run, SSH/device/provider check is claimed at this checkpoint.

## Audit worklist

| ID | State | Deliverable |
| --- | --- | --- |
| R01-W01 | IN_PROGRESS | Recompute all original phase/task/acceptance, bot and P21 inventories from an exact tracked source snapshot; retain IDs, hashes and unchecked requirements. |
| R01-W02 | IN_PROGRESS | Evidence-aware dispositions, stale-claim corrections and actionable cross-owner defects. |
| R02-W01 | IN_PROGRESS | Independently review Main's CI01/CI02 patches and exact-SHA broad-service/dedicated-skip evidence. |
| R02-W02 | PLANNED | Read-only, secret-free reproducible audit artifacts and regression checks; do not replace original required suites. |
| R01-W03 | PLANNED | Independent bot legal-action/value/symmetry/leakage/promotion/operator and tutorial-protocol review. |

Tests: NOT_RUN in this initial coordination commit. Subsequent checkpoints below must include exact commits, commands, target environments, outcomes and remaining gates. R01 and R02 remain PARTIAL until their complete exit conditions are evidenced.
