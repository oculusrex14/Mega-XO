# V5-specific backup alerting — scheduled and delivered (2026-10-14)

Closes the honest gap recorded in `DELIVERED-ALERTS-20261014.md` ("V5-specific signals still need their
own thresholds wired and each one proved delivered").

## What runs

| Unit | State | Cadence |
| --- | --- | --- |
| `mega-xo-v5-backup.timer` | active | 5 min |
| `mega-xo-v5-freshness.timer` | active | 5 min, offset 1 min |

The freshness checker reads the newest manifest under the V5 R2 prefix, validates it against the P15
contract, verifies the ciphertext HEAD, compares the age to the 900 s RPO in
`state/backup-policy.json`, and sends through the same Resend path the V4 monitor uses.

## Real evidence

- **31 real scheduled evaluations** in the last 3 hours.
- Normal state: `{"state":"fresh","checkedAtUtc":"2026-10-14T04:20:05.039Z","consecutiveUnhealthy":0}`.
- **A real alert was raised and delivered** when a manifest could not be validated:

```json
{"format":"mega-v5-backup-freshness/v1","evaluatedAtUtc":"2026-10-14T02:13:47.354Z",
 "rpoSeconds":900,"newestManifestAgeSeconds":12,"state":"stale","previousState":"unknown",
 "problems":["newest manifest could not be validated: P15_MANIFEST_REFUSED: manifest filename/ID mismatch"],
 "alert":{"attempted":true,"sent":true,"kind":"stale"},"result":"STALE"}
```

with the journal line `V5_BACKUP_ALERT_ATTEMPTED: delivered`.

- Transition suppression is real too: the state file carries `lastAlertAtUtc`, so a persistent fault
  does not spam and a recovery produces its own message.

## Why the raised problem was correct to raise

The checker refused a manifest whose filename and embedded ID disagreed — a genuine integrity
condition, not a false positive. It failed closed (did not treat the archive as fresh) and told the
operator. That is the intended behaviour for exactly the class of fault the service exists to catch.

## Honest limits

- Email is the only channel; there is no paging or escalation, and remote retention is unbounded
  (an owner decision).
- The other V5 signals named in the directive (API/Core/realtime error rates, worker health, gateway
  latency, game latency, gameplay-capture job health) still need their own thresholds and a delivered
  proof each; this item covers the **backup-freshness** signal specifically.
