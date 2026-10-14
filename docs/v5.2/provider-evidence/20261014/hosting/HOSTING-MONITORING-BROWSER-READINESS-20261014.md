# V5.2 hosting and monitoring browser evidence

Initial read-only snapshot from 14 October 2026, approximately 16:45–17:01 UTC (22:15–22:31 IST), using the existing signed-in Brave UptimeRobot tab and a separate Brave tab for public/staging pages. This snapshot predates the separately authorized synthetic drill documented in [UPTIMEROBOT-DRILL-20261014.md](UPTIMEROBOT-DRILL-20261014.md). During this snapshot, no monitor, DNS, hosting, backend, account, or project configuration was changed. No screenshot, private mailbox content, email address, credentials, or authenticated trace is stored here.

## UptimeRobot state

Dashboard: [monitor list](https://dashboard.uptimerobot.com/monitors) and [incidents](https://dashboard.uptimerobot.com/incidents).

The dashboard showed three monitors. Their edit forms showed email alert enabled, with no delay or repeat; SMS, voice, and app push were unavailable/disabled. The email recipient is redacted. No connected integration or team recipient was visible in the inspected monitor settings. This establishes configured alert routing, not end-to-end delivery. I did not press **Test Notification**, read the mailbox, or clear/alter incident history.

| Monitor | Current observed state | Incident/history |
|---|---|---|
| [804201831 — mega-xo-livez](https://dashboard.uptimerobot.com/monitors/804201831) | HTTP monitor at `https://play.antimatterinnovations.com/livez`; checked every 5 minutes; Down, `T/O Connection Timeout` | Incident `366226076302585910`; began 7 Oct 2026, 19:41:40 GMT+5:30; still ongoing, displayed duration 7d 2h 40m |
| [804201842 — mega-xo-opsz](https://dashboard.uptimerobot.com/monitors/804201842) | HTTP monitor at `https://play.antimatterinnovations.com/opsz`; checked every 5 minutes; Down, `T/O Connection Timeout` | Incident `366226391762247720`; began 7 Oct 2026, 19:42:55 GMT+5:30; still ongoing, displayed duration 7d 2h 39m |
| [804264653 — prelaunch-core-tcp443](https://dashboard.uptimerobot.com/monitors/804264653) | TCP port 443 on `core.megaxo.online`; checked every 5 minutes; Up for over 15 hours at observation; dashboard showed 100% for 24 hours, 7 days, and 30 days, with zero incidents | This is a TCP-port check only; it does not establish signed Core health, HTTPS/API correctness, WebSocket health, worker health, or recovery-notification delivery |

The two older incidents remain active and historical records remain intact. The separate Core monitor is currently green, but it cannot substitute for the two stale HTTP checks or an application-level health check.

The new-monitor form offered HTTP/website monitoring at the free 5-minute interval. The 15-second/1-minute checks and SSL/domain-expiration monitor were marked Premium in the account UI. The official [UptimeRobot pricing page](https://uptimerobot.com/pricing/) lists the Free plan at $0 with 50 monitors and 5-minute checks. At the time of this initial snapshot, three monitors existed and the separately authorized drill monitor had not yet been created.

## Initial safe incident/recovery drill candidate (superseded by authorized drill)

At the time of this initial snapshot, no drill had been run and the candidate below was awaiting root review. Root later authorized and completed the distinct free HTTP monitor drill; the addendum records the actual incident, recovery, and matching Inbox receipts. The candidate avoided all production endpoints:

1. Create it at the free 5-minute interval against `https://httpbin.org/status/503` (expected HTTP failure/Down).
2. After the UptimeRobot Down incident is visible and the owner confirms the alert arrived through the already-approved mailbox, edit that same monitor’s URL to `https://httpbin.org/status/200` (expected Up/recovery).
3. Confirm the incident resolves and the recovery alert arrives. Leave the monitor on `/status/200` to preserve its incident record; do not delete it as part of the drill.

The [httpbin endpoint documentation](https://httpbin.org/legacy) states that `/status/:code` returns the requested HTTP status. Brave navigation to `/status/503` returned the browser’s non-2xx navigation failure, while `/status/200` loaded successfully. This is a synthetic monitor-state and notification-pipeline drill against a third-party test service, not a production outage and not evidence that production recovery has been tested. The target is not owner-operated; root reviewed the external synthetic target and explicitly authorized the real notification drill.

## Public and staging browser checks

| URL | Browser observation | What this proves / does not prove |
|---|---|---|
| `https://megaxo.online/` | Loads Hostinger’s “Parked Domain name on Hostinger DNS system” page | HTTPS page load with no certificate interstitial; canonical game site is not publicly serving here |
| `https://megaxo.online/privacy` | Same Hostinger parked page | Public privacy route is not the product policy |
| `https://megaxo.online/app-ads.txt` | Same Hostinger parked page | Public app-ads route does not return the seller declaration; MIME type was not independently inspected |
| `https://api.megaxo.online/` | Brave navigation failed with `net::ERR_NAME_NOT_RESOLVED` | No HTTP/TLS state could be verified from this browser/network |
| `https://core.megaxo.online/` | Brave navigation failed with `net::ERR_BLOCKED_BY_CLIENT` | Browser/client blocked the navigation; this is not an origin or certificate result |
| `https://command.tail95c48c.ts.net/` | Staging homepage rendered over HTTPS with the Mega XOXO logo, navigation, offline practice preview, and online-mode sign-in links | The staged browser page is reachable; no browser certificate interstitial appeared |
| `https://command.tail95c48c.ts.net/game` | Local “Play against Bot” game loaded, with Easy selected, five theme choices, keyboard instructions, and a sign-in link for online play | Anonymous offline game path works; no online session or account was created |

On the staging homepage, one legal local preview move was accepted, the bot responded, and **Reset practice preview** restored the initial board. On `/game`, one legal X move and the bot’s O response were accepted; **Reset board** restored zero moves. These actions were local offline practice only; no identity, account, ranking, wallet, or competitive state was touched.

The rendered pages showed no visible error overlay. Structured browser-console logs and certificate-chain details were not available from this CUA inspection, so no claim about console cleanliness, TLS configuration quality, or static asset network errors is made. The browser’s `ERR_BLOCKED_BY_CLIENT` result for Core was left intact; no extension/security setting was bypassed.

The supplied V5.2 handoff records staging’s served frontend manifest as build `5897497493617e1f389af1626451899831045840`, SHA-256 `31cdb4d302a12182b709c7430b389d79a42a706001360fab56afb3dd22028b7c`, 152 files / 3,547,734 bytes. That handoff evidence was not re-derived from the browser. Treat the staging visit as a guest-path smoke check only, **not V5.2 acceptance**. The handoff also records that public privacy and app-ads routes are parked; this browser pass independently observed the same result.

## Remaining proof needed

- Main’s current application-health, signed Core, WebSocket, workers/queues, database/cache/backups, and production authority evidence.
- Public DNS/TLS verification for `api.megaxo.online` and `core.megaxo.online` from a permitted route not blocked by this Brave client.
- V5.2 public deployment, actual `/privacy` and text `app-ads.txt` delivery, MIME verification, and authenticated/online acceptance against the activated V5.2 authority.
