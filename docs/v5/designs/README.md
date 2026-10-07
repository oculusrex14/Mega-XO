# V5 phase designs (implementation inputs)

These are detailed design reports consumed by later implementation slices; they are not completion claims. Verified/design/provider-pending statements carry inline classifications where produced by their scouts. Normative sources remain AGENT-GOAL.md, the implementation pack, specs and docs/v5/ARCHITECTURE.md; where a design marks a decision [D], a later accepted implementation may record a superseding decision in docs/v5/DECISIONS.md.

- `p02-schema-design.md` — normalized Neon PostgreSQL authority schema, roles, migration ledger (inputs for V5-02-02/03/04).
- `p03-extraction-design.md` — constructor-free deterministic SQLite→PostgreSQL extraction, reconciliation algebra and evidence plan (V5-03-01..06).
- `p05-session-design.md` — actor-centric sessions, Ed25519 access tokens, refresh families, durable one-use realtime tickets (V5-05-01..06).
- `p06-ephemera-design.md` — managed Redis/Valkey primitives, key/TTL matrix, wipe-survival invariants and provider selection matrix (V5-06-01..04).
