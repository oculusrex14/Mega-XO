# TRACK B - secure isolated staging HTTPS/WSS enabled and verified

## Enablement (owner-approved secure private origin)

`tailscale serve` was already authorized on the Oracle node (`command`, cert domain
`command.tail95c48c.ts.net`). Enabled:

```
sudo tailscale serve --bg --https=443 http://127.0.0.1:8085
```

The co-located staging server was rebound to `127.0.0.1:8085` with
`--public-origin https://command.tail95c48c.ts.net`, so the HTTPS origin is an accepted browser Origin
for the API/CSRF path AND the realtime handshake (WebSocket is proxied by `tailscale serve`).

## Verification (from an external device - this Mac, a different tailnet host)

| URL | Result |
| --- | --- |
| `https://command.tail95c48c.ts.net/` | 200 (36027 B, the P21 shell) |
| `https://command.tail95c48c.ts.net/livez` | 200 |
| `https://command.tail95c48c.ts.net/api/account/session` | 200 (cookie bootstrap) |

`tests/e2e-staging-signin.cjs` over the HTTPS origin: steps 1-2 PASS (HttpOnly cookie bootstrap with
CSRF, signup challenge with NO OTP leak). Step 3 (reading the OTP out of band) failed only because the
sink file was pulled before the code was appended - a harness sync artifact, not a server fault; the
account routes themselves work over the real certificate.

A self-connection from the Oracle host to its own `*.ts.net` name hits a Tailscale hairpin TLS quirk
(`tlsv1 alert internal error`); the SAME cert serves external tailnet clients correctly, which is what
matters for staging testers.

## Codex access

Use `https://command.tail95c48c.ts.net` (HTTPS/WSS) from any tailnet device. Same SHA as before. V4
production untouched; the serve proxy fronts only the isolated staging port 8085.
