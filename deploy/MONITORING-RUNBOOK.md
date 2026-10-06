# V4 production monitoring and alerting runbook

V4 uses two independent monitoring paths:

1. **External:** UptimeRobot checks public endpoints from outside Oracle.
2. **Local:** a systemd timer on the VPS checks private health, backup age, disk pressure, and container restart state, then sends a Resend operations email on health transitions.

Neither path exposes private metrics to the Internet.

## Public health endpoints

### `/livez`

```text
https://play.antimatterinnovations.com/livez
```

Returns 200 when the public edge can reach the running application process.

It is intentionally shallow. It does not claim backups, disk space, matchmaking workers, or maintenance state are healthy.

### `/readyz`

```text
https://play.antimatterinnovations.com/readyz
```

Returns 200 only when the application is ready to accept normal work.

### `/opsz`

```text
https://play.antimatterinnovations.com/opsz
```

Returns only:

```json
{"ok":true}
```

or HTTP 503 with:

```json
{"ok":false}
```

It becomes unhealthy when:

- the application is not ready;
- maintenance/draining/worker health is bad;
- the last successful off-box backup is at least 30 minutes old;
- local database storage has less than 1 GiB free;
- local database storage is at least 90% used.

No disk size, backup ID, email state, account count, release metadata, or internal counters are exposed publicly.

## 1. Configure free external monitoring

As of October 2026, UptimeRobot's Free plan supports 5-minute HTTPS checks and can be used for commercial projects.

Official references:

- https://uptimerobot.com/pricing/
- https://help.uptimerobot.com/en/articles/11360876-what-is-a-monitoring-interval-in-uptimerobot

Create two HTTP(S) monitors:

### Monitor A — public liveness

- Name: `Mega XO Production - Liveness`
- URL: `https://play.antimatterinnovations.com/livez`
- Interval: 5 minutes
- Expected result: HTTP 200
- Alert contact: an Antimatter Innovations-controlled destination.

### Monitor B — operational health

- Name: `Mega XO Production - Operational Health`
- URL: `https://play.antimatterinnovations.com/opsz`
- Interval: 5 minutes
- Expected result: HTTP 200
- Alert contact: the same controlled destination.

Interpretation:

| Liveness | Operational | Meaning |
| --- | --- | --- |
| UP | UP | Normal |
| UP | DOWN | App is reachable but maintenance, backup freshness, disk, or worker health needs attention |
| DOWN | DOWN | Edge/VPS/network/application process may be unavailable |
| DOWN | UP | Treat as monitor inconsistency and investigate |

Do not put secrets, Basic Auth credentials, private IPs, or query tokens in monitor URLs.

## 2. Install local five-minute monitoring

Only after production is deployed, Resend is configured, and off-box backups are running:

```bash
sudo bash deploy/install-monitoring.sh /opt/mega-xo
```

The installer:

- copies a fixed monitoring asset set into the deployment root;
- verifies current health before enabling the timer;
- installs `mega-xo-health.service`;
- installs `mega-xo-health.timer`;
- runs every five minutes;
- sends an operations email only when state changes from healthy to unhealthy or back to healthy.

The local monitor checks:

- private application health;
- required off-box backup freshness;
- disk usage via the private operator command;
- app container exists/runs;
- edge container exists/runs;
- app/edge Docker restart count is no more than 3;
- backup worker is running once an S3 backup repository is configured.

Alert email:

```text
From: Mega XO Ops <contact@antimatterinnovations.com>
To: contact@antimatterinnovations.com
```

The Resend API key is loaded from the owner-only VPS secret file and is not printed.

## 3. Inspect local monitoring

Timer:

```bash
sudo systemctl status mega-xo-health.timer
sudo systemctl list-timers mega-xo-health.timer
```

Latest runs:

```bash
sudo journalctl -u mega-xo-health.service -n 100 --no-pager
```

Manual health check:

```bash
sudo /opt/mega-xo/ops-bin/host-health-monitor.sh /opt/mega-xo
```

## 4. Test alerts before inviting users

Do this only before public launch or during an announced maintenance window.

Turn maintenance on:

```bash
export MEGA_ROOT=/opt/mega-xo
export MEGA_IMAGE=$(cat /opt/mega-xo/current-image)
docker compose --env-file /opt/mega-xo/compose.env -f deploy/compose.yaml exec -T app node scripts/ops.js maintenance on
```

Run the local monitor manually:

```bash
sudo systemctl start mega-xo-health.service
```

Expected:

- local monitor exits unhealthy;
- one operations alert email arrives;
- `/livez` remains 200;
- `/opsz` returns 503.

Turn maintenance back off:

```bash
docker compose --env-file /opt/mega-xo/compose.env -f deploy/compose.yaml exec -T app node scripts/ops.js maintenance off
sudo systemctl start mega-xo-health.service
```

Expected:

- one recovery email arrives;
- `/opsz` returns 200 after backups/disk/app are healthy.

If desired, leave maintenance on long enough for one UptimeRobot 5-minute cycle to prove the external alert too, then immediately restore service.

## 5. Incident triage

If **liveness is down**:

1. Connect through Tailscale.
2. Check Oracle instance/network status.
3. Check Docker daemon.
4. Check edge and app container state.
5. Review redacted application logs.
6. Do not restore a database merely because the process is down.

If **liveness is up but operational health is down**:

1. Run `deploy/check-health.sh /opt/mega-xo`.
2. Check backup age and backup worker.
3. Check disk usage.
4. Check maintenance state and worker health.
5. Check container restart counts.
6. Resolve the cause before suppressing alerts.

If **backup freshness is bad**:

1. do not delete old backups first;
2. inspect R2 credentials/network/budget;
3. run one explicit backup attempt;
4. run a repository check;
5. verify the newest snapshot can be retrieved.

## 6. What the free external monitor does not provide

The free UptimeRobot plan currently checks at 5-minute intervals. It is not second-by-second incident detection and its dedicated SSL-expiry monitoring features may differ by plan.

V4 therefore treats it as a launch-appropriate external outage signal, not as a full observability platform.

Private detailed counters remain on the loopback-only metrics/status port and must never be published merely to gain richer free dashboards.

## 7. Completion evidence

Update `docs/V4-OPEN-BLOCKERS.md`:

- EXT-15 complete after both UptimeRobot monitors are active and a test alert is received.
- EXT-16 complete after the local systemd monitor is active and both unhealthy + recovery Resend emails are proven.

Do not record monitor API keys or alert-provider credentials in GitHub.
