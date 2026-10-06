# V4.1 support diagnostics and correlation

Mega XO exposes opaque support codes such as `MX-A1B2C3D4E5F60708` for production request failures so a player can report one error without sending credentials or screenshots of private data.

## Player workflow

When an API error reaches the browser:

- the same support ID is available in the `X-Support-ID` header;
- perimeter-owned JSON errors also include `supportId`;
- online error text and the connection-status surface append the support code when one is available.

In **Settings → About → Copy support diagnostics**, the client generates a small JSON report containing only:

- product/client version;
- generation time;
- connectivity state, public error code and last support ID;
- coarse UI context: page, play mode, online/offline match state, waiting/sheet state, theme and reduced-motion state;
- viewport width/height.

It deliberately excludes account/player identifiers, username/tag, email, provider identity, IP address, cookie/session/CSRF values, password/OTP material, request body/query contents, purchase receipts/tokens and wallet contents.

If Clipboard API access is unavailable, the same sanitized JSON is shown in a read-only selectable text area.

## Operator workflow

On the VPS/Tailscale operator path:

    node scripts/operator.js support MX-A1B2C3D4E5F60708

The response contains only:

    id
    at
    method
    route
    status
    code

`route` is normalized before storage, so dynamic match/profile/room IDs and URL query strings are not retained.

The lookup never returns request bodies, response bodies, IP addresses, cookies, player/account IDs or secrets.

## Retention and bounds

Support-correlation rows are operational metadata, not a request log.

- rows older than seven days are deleted by normal maintenance;
- the perimeter additionally caps the index to the newest 5,000 rows;
- application stdout HTTP events use the same opaque support ID and normalized route;
- no support lookup mutation exists.

Do not extend this table with actor IDs, email addresses, raw paths, query strings, IPs or payload excerpts.

## Acceptance

Repository tests prove:

1. error JSON/header use the same `MX-…` value;
2. the stored route has no query contents;
3. a marker placed in a request query is absent from the support row and structured application logs;
4. operator lookup returns only the allowlisted support fields;
5. malformed support IDs are rejected.

During staging incident/operator drills, use one real support code to confirm the operator lookup path works through the loopback/Tailscale administration boundary.
