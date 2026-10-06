# V4 production perimeter hardening and proof

The production security boundary is:

```text
Internet
   |
 TCP 80 / 443
   |
 Caddy edge container
   |
 private Docker bridge
   |
 Node app:8080
   |
 local SQLite
```

Administrative access uses Tailscale. Metrics stay on VPS loopback only.

## Required public exposure

Public Internet may reach:

- TCP 80 — Caddy HTTP redirect / ACME;
- TCP 443 — Caddy HTTPS.

Public Internet must **not** reach:

- TCP 22 — SSH after Tailscale administration is proven;
- TCP 2375/2376 — Docker API;
- TCP 8080 — Node application;
- TCP 9091 — private metrics;
- SQLite/data files;
- Docker socket;
- Caddy admin API.

## 1. Oracle Cloud network rules

At the Oracle VCN/Subnet/NSG/Security List layer:

Allow inbound:

```text
TCP 80  from 0.0.0.0/0
TCP 443 from 0.0.0.0/0
```

If public IPv6 is deliberately enabled, create equivalent IPv6 rules only after validating it end-to-end.

Remove public SSH ingress once all of these are true:

1. Tailscale is connected;
2. you can open a second administrative session over Tailscale;
3. sudo works over that session;
4. reboot/reconnect over Tailscale has been proven.

Never lock yourself out by removing the only working management path.

Do not create ingress for 8080, 9091, 2375, or 2376.

## 2. Host firewall

Keep the host firewall enabled.

Allow public:

```text
80/tcp
443/tcp
```

Allow administration only through the Tailscale interface/address policy appropriate to the VPS.

Do not globally disable `ufw`, `firewalld`, nftables, or Oracle network controls just because Docker is installed.

Because Oracle images differ, V4 deliberately does not auto-edit host firewall rules. The external probe below is the authoritative proof of the resulting exposure.

## 3. Container hardening

V4 Compose requires:

### App

- runs as UID/GID 1000;
- read-only root filesystem;
- drops all Linux capabilities;
- `no-new-privileges`;
- bounded processes, memory and CPU;
- only a small `/tmp` tmpfs;
- Node 8080 is **not** published;
- metrics 9091 publish only to `127.0.0.1`;
- data volume is the only writable persistent application path;
- secrets are mounted through Docker secrets.

### Edge

- read-only root filesystem;
- drops all capabilities then adds only `NET_BIND_SERVICE`;
- `no-new-privileges`;
- Caddy admin API disabled;
- publishes only 80/443;
- deletes the `Server` response header;
- production sets one-year HSTS;
- private repository/runtime paths return 404;
- proxy-to-app uses a private secret header;
- client IP is accepted only from the authenticated edge.

### Backup worker

- no public ports;
- read-only root filesystem;
- drops all capabilities;
- scoped secret mounts;
- read-only SQLite source;
- dedicated backup work/status mounts.

## 4. Run the host-side audit

After production containers are running:

```bash
sudo bash deploy/audit-perimeter.sh /opt/mega-xo
```

The audit checks:

- Compose parses;
- app and edge containers exist;
- read-only root filesystems;
- capability drops;
- no-new-privileges;
- app 8080 is not published;
- metrics are loopback-only;
- edge 80/443 are the public mappings;
- Docker API/app/metrics sensitive ports are not public listeners;
- all secret files are mode 600;
- database directory is private;
- Caddy admin API is off;
- Caddy server fingerprint is suppressed;
- HSTS exists;
- Tailscale is connected.

A `FAIL:` is a launch blocker.

## 5. Run the external probe from another network

Do **not** run this as the only test from the VPS itself. Run it from a laptop/home/mobile network or another external host:

```bash
node scripts/external-perimeter-probe.js \
  play.antimatterinnovations.com \
  ORACLE_PUBLIC_IPV4
```

The probe requires:

Open:

```text
80
443
```

Closed/unreachable:

```text
22
2375
2376
8080
9091
```

It also verifies:

- DNS A record matches the expected VPS IPv4;
- valid public HTTPS;
- `/livez` = 200;
- HSTS is present;
- Caddy `Server` fingerprint is absent;
- CSP frame protection is present;
- `X-Frame-Options: DENY`;
- `/opsz` is 200 and exposes only `{"ok":true}`;
- private source/config/status paths return 404;
- HTTP redirects to the same hostname over HTTPS.

If the external probe can connect to port 22, do not mark the perimeter complete merely because SSH uses keys. Close public SSH after Tailscale recovery access is proven.

## 6. Docker daemon

Never enable Docker's unauthenticated TCP daemon.

Do not expose:

```text
tcp://0.0.0.0:2375
tcp://0.0.0.0:2376
```

Do not mount `/var/run/docker.sock` into the game, edge, or backup containers.

Operator scripts invoke Docker from the trusted host shell only.

## 7. Database and secrets

Expected production permissions:

```text
/opt/mega-xo/secrets/*       600
/opt/mega-xo/data/           700
```

The SQLite database must never be served by Caddy or copied into the web root.

Do not use a public SQL browser, phpMyAdmin-style tool, or remote SQLite filesystem.

## 8. Edge headers

Production Caddy strips its own `Server` header and sets:

```text
Strict-Transport-Security: max-age=31536000
```

The application adds:

- CSP;
- frame denial;
- no-referrer;
- MIME sniffing protection;
- restrictive Permissions Policy;
- no-store on account/API responses.

Do not add `Access-Control-Allow-Origin: *` to the API. Mega XO intentionally uses one same-origin browser/API boundary.

## 9. Completion evidence

Update `docs/V4-OPEN-BLOCKERS.md`:

- EXT-03 COMPLETE after Oracle + host firewall are set correctly;
- the production release evidence under EXT-17 must include both the host audit and outside-in probe.

Record:

- date/time;
- audit exit 0;
- external probe exit 0;
- expected public IPv4;
- public ports 80/443;
- blocked ports 22/2375/2376/8080/9091.

Do not record Tailscale auth keys, server private keys, or secret values.
