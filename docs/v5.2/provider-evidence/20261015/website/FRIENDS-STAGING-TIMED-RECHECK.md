# Timed anonymous Friends recheck — 15 October 2026 IST

Observed in Brave through CUA on 14 October 2026 at approximately 22:41–22:42 UTC.
Target: `https://command.tail95c48c.ts.net/friends`. Independently fetched frontend manifest:
source `3752383c4f4f8343ad6aeb00d2434beec3ef96f6`, bundle
`17b1d88e423d2aa4727a086b5908c7e8317b7594bcb7f04ec89a7a06c877bfb8`, 160 files /
3,688,654 bytes. Both health endpoints returned 200 and ready.

The initial navigation showed “Checking your account…”. A second CUA accessibility observation
37,157ms after navigation showed the confirmed guest prompt, “Sign in to find players and manage
your friend requests here”, and Open account. The loading message was gone. No private friend
list was present. No sign-in, account creation, password, OTP, friend mutation or economic action
was attempted. This proves the request eventually settled; it does not measure the exact instant
of settlement or prove it took 37 seconds.

This supersedes the inferred indefinite-loading defect in the earlier guest receipt. It does not
supersede that historical screenshot/text observation. The separate eight-second timeout error
presentation defect is reproduced and locally fixed in `d582dfe`; that code is not on this deployed
bundle and is not claimed as a staging pass.

A benign result screenshot was retained locally in ignored `.artifacts/v52-provider/screenshots/`.
Authenticated two-actor friends/challenges, matchmaking, WSS and settlement remain NOT_RUN for
this V5.2 browser pass.
