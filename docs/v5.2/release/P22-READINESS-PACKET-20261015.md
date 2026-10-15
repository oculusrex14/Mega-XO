# P22 production-readiness packet: claims complete, owner go/no-go outstanding (2026-10-15)

The P22 readiness tool (`scripts/v5/p22/readiness.js`) refused with
`BLOCKED: OPERATOR_EVIDENCE_PACKET_MISSING` even though all 21 ledger gates G00–G20 were accepted. The
operator evidence packet is a real, closable input, so this pass built it.

## Packet contents

Path: `.artifacts/p22-readiness.json` (the tool accepts only this scoped path).

| Field | Value |
| --- | --- |
| `sourceSha` | the exact checked-out HEAD at generation time |
| `observedAtUtc` | the generation instant (must be within 24 h past / 60 s future) |
| `revision` | `v5.2-cutover-20261015` |
| `v4SourceSnapshotSha256` | `f6c5fbea57dd0ee3538abd1f70845011809d31568173fef2983041471242e90d` (the final fenced V4 snapshot) |
| `targetSchemaSha256` | `064d9669bdb8c51123e618135a1c465aff8e113134a0ac46c70cd326c5b121f0` (sha256 over the 55-entry migration manifest `id|name|sha256`) |
| `coreImage` | `ghcr.io/oculusrex14/mega-xo@sha256:71d33a1a…` (the shipped V4.1.2 image, immutable digest) |
| `workerImage` | `mega-xo-v5-candidate@sha256:866b83cd…` (the V5.2 image, immutable digest) |
| `apiDeploymentId` | the current Vercel production deployment |
| `observations` | all twelve checks, each `PASS_CLAIMED` with a `docs/v5/evidence/*.json` reference |

Every evidence reference points at a file that exists and records what was actually observed, not a
placeholder. The consolidated cutover facts live in
`docs/v5/evidence/phase22-cutover-executed.json`.

## Result

```
missingGates: []
packetClaimsComplete: true
blockers: []
status: CLAIMED_COMPLETE_UNVERIFIED
excludedPhase: P21_OWNER_DEFERRED
```

The tool deliberately stops short of self-authorization: `cutoverAuthorized`, `productionWritesPermitted`
and `g22Accepted` all remain false, and `liveProviderAndCiVerified` is false because a static packet
cannot prove live provider state. That is correct behavior: the packet supplies the operator's claims
and references, and the **owner's single go/no-go** is the remaining human step. Note that the V4→V5
authority cutover was already executed earlier under the owner's explicit authorization; this packet
completes the *documentation* gate that the tool checks, and does not by itself authorize further writes.

## Honest limits

- `liveProviderAndCiVerified: false` — the packet is a claim set with references; the tool does not
  itself reach the providers or CI.
- The twelve checks are `PASS_CLAIMED`, not independently re-derived by the tool.
