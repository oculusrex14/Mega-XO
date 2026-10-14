# LAN-local feasibility — measured on the real devices (2026-10-14)

Owner decision: the private lobby must support a host whose phone **is** the server, discoverable by
anyone on the same Wi-Fi **with no internet**. This records the measurement that makes that a known
quantity rather than a hope, before any code is written.

## What was measured

| Check | Command / method | Result |
| --- | --- | --- |
| Mac LAN address | `ipconfig getifaddr en0` | `192.168.0.8` |
| Phone LAN address | `adb shell ip -f inet addr show wlan0` | `192.168.0.111/24` — **same /24 subnet** |
| Mac firewall | `socketfilterfw --getglobalstate` | disabled |
| LAN room server | `PARTY_PORT=8082 node server/party-server.js` | started; `GET /api/party/capabilities` → `{"lan":true,"online":false,...}` |
| Phone → Mac ICMP | `adb shell ping -c2 192.168.0.8` | 2/2 received, 0% loss, ~34 ms |
| Phone → Mac TCP | `adb shell '... nc 192.168.0.8 8082'` | **HTTP/1.1 200 OK** with the real JSON body |
| Phone WebView → Mac HTTP | CDP `fetch('http://192.168.0.8:8082/api/party/capabilities')` | **Failed to fetch** |

## Conclusion

The network path is entirely sound: a device on this Wi-Fi can open a TCP connection to a host on the
same Wi-Fi and receive the LAN room server's real response. The WebView's failure is **policy, not
reachability**, and there are exactly two policy layers to remove:

1. `native/android/app/src/main/AndroidManifest.xml` sets `android:usesCleartextTraffic="false"`, so the
   platform blocks plain-HTTP LAN traffic.
2. `MegaXOActivity.shouldInterceptRequest` hard-blocks any `/api/*` path inside the WebView, and the
   offline flavor installs no transport at all, so `src/party-ui.js` never reaches a room server.

Both are deliberate blockers added for the earlier offline-only shell. The owner has explicitly
authorized removing them for final testing.

## What the LAN room server already provides

`server/party-server.js` + `server/rooms.js` + `server/party-http.js` are already a complete
internet-free room host:

- `RoomStore(db, { lanOnly: true })` — guest sessions (`store.guest(name)` → bearer token), no account
  service, no economy mutation (`lanOnly` refuses public/prize tables with `FREE_PRIVATE_ONLY`).
- The same `createPartyHandler` the online path uses, with `allowedHosts` derived from the machine's own
  IPv4 addresses — so a guest's `Host` header is validated against the real interface list.
- Authority is `src/tournament.js`, which `native/client/bundle.config.json` already ships to both apps.
- Guest identity: anonymous `crypto.randomUUID()` actors with 24 h tokens, capped at 200 sessions —
  nothing that needs the account service.

## The work this implies (Wave 2)

- Port the room host into the app (Android `ServerSocket`-based HTTP; iOS `Network.framework` listener),
  serving the bundled assets plus `/api/party/*` from `src/tournament.js` + a guest store.
- Advertise the room over NSD/Bonjour and browse/discover it, gated to the same Wi-Fi.
- Scope cleartext to private/LAN addresses only (a `network_security_config` limited to RFC1918 ranges
  and `localhost`), never blanket `usesCleartextTraffic="true"`, and add the iOS equivalents
  (`NSLocalNetworkUsageDescription`, `NSBonjourServices`).
- Remove the deliberate `/api/*` hard block so the room client can reach the local host, while keeping
  the existing origin discipline for the trusted game URL.
