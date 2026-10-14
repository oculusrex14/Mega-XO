# UptimeRobot synthetic delivery drill

This is an external synthetic status-code probe, not a production outage and not a production health pass. Root authorized creation after the selected email recipient was checked against the two approved owner mailboxes; the match result was **true**. The address is intentionally omitted.

## Monitor configuration

- Monitor ID: `804274475`
- Name: `mxo-alert-delivery-drill-20261014`
- Type: HTTP/S
- Initial URL: `https://httpbin.org/status/503`
- Interval: 5 minutes (free default)
- Email alert: enabled; no delay and no repeat
- SMS, voice, and push: disabled/unavailable
- Existing monitor IDs `804201831`, `804201842`, and `804264653` were not changed; their incidents/history remain intact.
- Review links: [drill monitor](https://dashboard.uptimerobot.com/monitors/804274475) · [incident record](https://dashboard.uptimerobot.com/incidents/368806727742428850)

## Event log

| Observed at (UTC) | Monitor state | Provider event / notification |
|---|---|---|
| 2026-10-14 17:05:16 | Preparing; “Your monitor is starting now”; no incident yet | Awaiting first scheduled probe |
| 2026-10-14 ~17:08 | Down | Actual incident `368806727742428850`; root cause `503 Service Unavailable`; started 2026-10-14 22:36:15 GMT+5:30. UptimeRobot activity log recorded the Down email as sent successfully at 22:36:17. |
| 2026-10-14 17:14:18 | Up on `https://httpbin.org/status/200`; incident resolved | Same incident resolved at 22:40:32 GMT+5:30 after 4m17s. UptimeRobot activity log recorded the recovery email as sent successfully at 22:40:34. |
| 2026-10-14 17:22:07 | Still Up on `/status/200`; active; checked every 5 minutes | Final state check; monitor is not paused and the incident history remains present. |

After the incident was recorded, only this monitor’s URL was changed from `/status/503` to `/status/200`; the name, type, 5-minute interval, email alert, receiver, delay, and repeat settings were left as configured. The monitor remains enabled and healthy at `/status/200`; the incident and event history were preserved. Existing monitors were not changed.

The Gmail connector first returned a reauthentication requirement. Verification then used the existing Brave Gmail session and its account chooser to select the already-signed-in inbox matching the UptimeRobot recipient. `recipient_inbox_match: true`; no address is recorded here. A narrow search for this exact monitor and UptimeRobot returned two matching Inbox alert rows: Down at 22:36 and Up/recovery at 22:40 local time on 14 October. The displayed minute-level receipt times match the provider activity entries. No message was opened; no body, code, or unrelated message was read.

The synthetic notification drill is complete: UptimeRobot recorded both Down and Up events and successful provider-side sends, and both corresponding alert rows were confirmed in the exact recipient Inbox. This proves the UptimeRobot synthetic monitoring and email-delivery path only; it is not a production outage, a production health pass, or evidence of production recovery. No Test Notification was used as a substitute for either real incident message. No monitor was deleted.
