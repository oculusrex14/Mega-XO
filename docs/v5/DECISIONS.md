# V5 decisions

Decisions are scope/configuration choices, not implementation or deployment evidence. Original pack D01–D13 remain in `Mega-XO-V5-Implementation-Pack/SCOPE-AND-DECISIONS.md`.

| ID | Decision | Basis and boundary |
|---|---|---|
| V5-D001 | Pin integration base to `455b8ec9ea4070b4410d78f9eea2aaa06d32c0b2`, not the pack's older SHA | Current local/remote V4.1 head has successful exact-head Actions run `37658524961`; retain release application SHA separately |
| V5-D002 | Keep supplied goal/pack/handoff originals unchanged; store current corrections in `docs/v5/` | Full pack integrity validator passed; historical observations and checksum manifest must remain auditable |
| V5-D003 | `progress.json` is the mutable machine-readable ledger; `TODO.md` is its readable projection | Retain every original phase, task action/verification/dependency and acceptance case; do not treat plan statuses as proof |
| V5-D004 | Preserve the shipped v4.1.2 guest-auth semantics as part of the approved baseline | Owner-reported fix and EXT-17; no outage banner/401 polling regression; known pre-existing opsz test failure is not rerun to confirm |
| V5-D005 | Complete P00–P20, defer P21, continue P22–P23, measure P24 | Latest scope overrides historical foundation-only/new-website-first instructions; P21 is not a P22 prerequisite |
| V5-D006 | Preserve existing browser/native assets and product contracts while replacing hosting/persistence/transports | PRODUCT precedence patches; no redesign, balance change, bought-Crown restrictions, archived frames or abuse auto-punishment |
| V5-D007 | Keep V4.1/main/tags/production unchanged during setup; branch only after preceding P00 gates | No V5 branch exists at entry; source progress files are local/uncommitted until a verified V5 checkpoint |
| V5-D008 | Use T9 first for bulky artifacts/caches if internal storage becomes insufficient; discover DGX before use | Owner authorization and measured 22 GiB internal/858 GiB T9 free; filesystem suitability and actual DGX target still need inspection; no data moved |
| V5-D009 | Never equate uploaded/submitted/approved/production-enabled or local/staging/device verification | Goal and acceptance evidence contract; provider safety/legal prompts are not answered on the owner's behalf |

Architecture is fixed to Vercel stateless account/social/read API, Neon durable truth, managed Redis/Valkey ephemera, Oracle Game Core/worker, direct realtime and independent encrypted R2 backups. Concrete resource IDs, plans, regions, native identifiers/signing and numeric operating targets remain inventory/measurement decisions, not invented setup defaults.
