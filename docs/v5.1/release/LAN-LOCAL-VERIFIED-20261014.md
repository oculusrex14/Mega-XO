# LAN-local private rooms — verified on the real devices (2026-10-14)

Owner requirement: *"same wifi should host let's one person make a room / become a host locally
(his device is the host server), then this room becomes discoverable by anyone on the same network
to join in as. This was for the scenario where wifi is available but no internet is connected."*

## What was wrong

Three deliberate blockers made this impossible, all added for the earlier offline-only shell:

1. The client offered "Same Wi-Fi" as a dead end. `src/party-ui.js` demanded a computer already
   running `server/party-server.js` and told the user to "try again from the host address".
2. The native shell hard-blocked every `/api/*` path inside the WebView, so the client could never
   reach a room server even if one existed.
3. The offline flavor **removed `INTERNET` and `ACCESS_NETWORK_STATE`**, so the app had no network
   capability at all: Android grants a normal app none without `INTERNET`, and `NsdManager` (mDNS
   discovery) refuses to run without it.

## Measured feasibility, before any code

| Check | Result |
| --- | --- |
| Phone ↔ Mac on the same Wi-Fi | phone `192.168.0.111/24`, Mac `192.168.0.8` — same subnet, ping 0% loss |
| Phone → Mac raw TCP to a room server | **HTTP/1.1 200 OK** with the real JSON body |
| Phone → Mac from the WebView | `Failed to fetch` — i.e. policy, not reachability |
| Room rules portability | `src/tournament.js`, `packages/domain/matchmaking.js`, `packages/domain/abuse.js` are pure UMD with **zero Node-only references** |

## What was built

`src/lan/` is the room authority, written once and shared by the Node host and both apps:

- `lan-room-store.js` — the portable store: the same approved rules (`src/tournament.js`), the same
  guest-session and per-(actor, key) idempotency contract as `server/rooms.js`, with an injected
  storage slot and no Node-only dependency. Own SHA-256 and CSPRNG keep digests identical
  everywhere. Private-only, and it exposes no economic mutator at all.
- `lan-room-http.js` — the `/api/party/*` contract in the exact shapes the client speaks, with an
  anti-DNS-rebinding Host gate (loopback / RFC1918 / link-local / IPv6 ULA only), rate limiting,
  body caps, and CORS + `OPTIONS` preflight so the app's cross-origin fetch works.
- `lan-host.js` — publishes `window.MegaLanHost` (instance) and `window.MegaLanRoom` (the same
  object the shell calls). The **shell owns the socket and the discovery record**; the page owns
  every rule, so the approved rules are never reimplemented in Kotlin or Swift.

Frozen natives primitives both shells implement: `window.MegaLanSocket` (`start`/`stop`/`status`)
and `window.MegaLanDiscovery` (`advertise`/`stop`/`browse`).

The client (`src/party-ui.js`) now offers four clear choices — **Pass & play**, **Host on this
Wi-Fi**, **Join a room near me**, **Online private room** — and the two Wi-Fi ones do what they say.

## Verified on real hardware

Android, OnePlus EB2101 (Android 13, SDK 33), app `online.megaxo.prototype`, driven over CDP;
this Mac on the same Wi-Fi.

| Step | Evidence |
| --- | --- |
| Primitives live | `MegaLanSocket` object, `MegaLanDiscovery` object, `MegaLanHost` instance with `open/close/ready/info/handle/discover`, `MegaLanRoom` |
| Hosting starts | `MegaLanHost.open("…",8081)` → `{"ok":true,"port":8081}`; `status()` → `{"listening":true,"port":8081,"origin":"http://192.168.0.111:8081"}` |
| **Mac → phone** capabilities | `GET http://192.168.0.111:8081/api/party/capabilities` → `{"lan":true,"online":false,"publicEnabled":false,…}` |
| **Mac → phone** guest session | `POST /api/party/session` → `{"token":"…","actor":"…","name":"MacGuest"}` |
| **Mac → phone** discovery (no token) | `GET /api/party/discover` → `{"host":true,"rooms":[…]}` |
| **Mac → phone** create a real room | `POST /api/party/command` → `created LlS23jBh code 6AUXA status LOBBY players 1` |
| The phone's own lobby agrees | `MegaLanHost.info()` lists the same room id, code, name, format, clock |
| mDNS/NSD browse | `MegaLanHost.discover(3000)` resolved the advertised host and its rooms |

Two further proofs inside the WebView: a same-origin `fetch('/api/party/capabilities')` and a
direct `fetch('http://192.168.0.111:8081/api/party/capabilities')` both return a clean
`{"lan":true,…}` body.

## Also verified after the first pass

| Defect found by probing the running host | Evidence after the fix |
| --- | --- |
| Relaying a room hosted on another machine returned the chunk framing (`345\r\n{...}`, truncated) | The phone's WebView now fetches the Mac's chunked host and gets 837 bytes of clean JSON; the phone then created a room **on the Mac host** and resolved `MacBook Room` at `http://192.168.0.8:8082` over mDNS |
| A static GET answered `HTTP/1.1 0 Status` (curl: "Unsupported HTTP/1 subversion"). Root cause: AndroidX `WebResourceResponse`'s 3-arg constructor never assigns `mStatusCode` | `GET /` → `HTTP/1.1 200 OK`; `GET /favicon.ico` → `HTTP/1.1 404 Not Found` |
| Hosting died with the process and never returned | After `force-stop`: refused during downtime; after relaunch → `200` with real JSON. The app auto-resumes hosting and re-advertises on the same port |

## Honest limits at the time of writing

- iOS hosting/discovery is implemented by a sibling change and still needs the simulator compile
  and a device pass.
- The two-phone no-internet run — both devices hosting/joining with the internet actually off — is
  still owed; the cross-device proof above used this Mac as the second device.
- `NEARBY_WIFI_DEVICES` is requested with `neverForLocation` on Android 13+ as a precaution;
  whether this device honours it without a runtime prompt is unverified.
- Two guests joining the same phone-hosted room simultaneously has not been exercised.
