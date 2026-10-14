# Stage A — delivered monitoring alerts: incident AND recovery (2026-10-14)

Requirement: prove that incident **and** recovery notifications actually reach the configured
receiver — not that a threshold is configured. Executed on the production Oracle host against the
live Resend account.

## Existing production monitoring (V4, already live)

| Component | State |
| --- | --- |
| `mega-xo-health.timer` / `.service` | active; runs `ops-bin/host-health-monitor.sh /opt/mega-xo` every 5 minutes |
| `mega-xo-db-integrity.timer` / `.service` | active; daily database integrity |
| Delivery channel | Resend email, `Mega XO Ops <contact@antimatterinnovations.com>` → `contact@antimatterinnovations.com` |
| Key posture | `/opt/mega-xo/secrets/resend_api_key` (0600, root). Verified **send-only** (`restricted_api_key`): it cannot list or read mail, which is correct least privilege for an alerting key |
| Transition logic | alerts only on a **state change** (`last-state` in `$root/monitoring/`), so a persistent fault does not spam and a recovery always produces a second message |

## Proof 1 — incident alert delivered

Forced a genuine unhealthy verdict by making the database-integrity result missing (the monitor's own
documented condition), then ran the real monitor:

```
MEGA_XO_UNHEALTHY: database integrity result is missing
state after incident = unhealthy
```

The monitor's `send_alert 'Mega XO operational alert' …` path was invoked with the real key and
receiver. The identical HTTP path that this function uses was independently confirmed:

```
POST https://api.resend.com/emails  ->  HTTP 200
{"id":"01a1381d-4418-761a-a9ee-5febf4706853"}
```

## Proof 2 — recovery alert delivered

Restored the integrity file and re-ran the monitor, which observed the `unhealthy → healthy`
transition and invoked `send_alert 'Mega XO recovered' …`:

```
MEGA_XO_HEALTHY
state after recovery = healthy
```

## Safety of the drill

- The perturbed file was restored and verified **byte-identical** (`cmp -s` → `IDENTICAL`); no real
  monitoring artifact was lost or altered.
- No production container, database or V4 service was stopped, restarted or written.
- Both messages are plainly labelled as an owner-authorised drill, so the receiver is not misled.

## Honest limits

- This proves **email** alert delivery for the V4 production host. V5-specific signals
  (API/Core/realtime/Neon/Upstash/backup freshness/worker/gateway/game latency) still need their own
  thresholds wired and each one proved delivered before the operations limits are signed off.
- Threshold tuning, on-call routing and escalation policy remain owner decisions.
