# V4 production VPS bootstrap runbook

Production origin: **https://play.antimatterinnovations.com**

This runbook prepares the Oracle ARM VPS without exposing Node, SQLite, metrics, secrets, or operator routes to the public internet.

## 1. Required facts before changing DNS

Record these from the Oracle Cloud console:

- public IPv4 address of the VPS;
- instance architecture: ARM64 / aarch64;
- Oracle subnet / NSG / Security List attached to the instance;
- the Tailscale hostname or Tailscale IP used for administration.

Do not guess the public IP. Do not create an AAAA record unless IPv6 is actually configured and reachable on the VPS.

## 2. Run the non-destructive VPS preflight

From a clone of this repository on the VPS:

```bash
sudo bash scripts/vps-preflight.sh /opt/mega-xo
```

The preflight changes nothing. It verifies:

- Linux ARM64;
- Docker daemon and Docker Compose v2;
- Tailscale connectivity;
- local filesystem suitable for SQLite;
- at least 10 GiB free;
- clock synchronization when available;
- TCP 80 and 443 are not already occupied;
- the pinned Node ARM64 image can run.

Stop if any line begins with `FAIL:`.

## 3. Oracle network ingress

At the Oracle Cloud network layer, allow inbound TCP:

- 80 from the internet;
- 443 from the internet.

Do **not** expose:

- 8080 (Node application);
- 9091 (metrics);
- SQLite/data paths;
- Docker daemon ports.

Keep SSH/operator access private through Tailscale where practical.

The host firewall must also allow 80/443. Use the firewall already installed on the VPS; do not disable it globally.

## 4. Connect Hostinger DNS

In Hostinger DNS for `antimatterinnovations.com`, add:

| Type | Name | Points to | TTL |
| --- | --- | --- | --- |
| A | `play` | **the Oracle VPS public IPv4** | 300 |

Do not change the existing Google Workspace or Resend records.

Only add an AAAA record for `play` after confirming public IPv6 works end-to-end.

Confirm resolution before enabling production traffic:

```bash
getent ahostsv4 play.antimatterinnovations.com
```

The returned public IPv4 must match the Oracle VPS.

## 5. Initialize the deployment directory

The host does not need Node installed. Use the pinned Node image:

```bash
cd /path/to/Mega-XO

sudo docker run --rm --platform linux/arm64 \
  -v "$PWD:/src:ro" \
  -v /opt/mega-xo:/opt/mega-xo \
  -w /src \
  node@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 \
  node scripts/init-vps.js \
  play.antimatterinnovations.com \
  /opt/mega-xo \
  production
```

Expected result:

```json
{"initialized":true,"root":"/opt/mega-xo","stage":"production","origin":"https://play.antimatterinnovations.com","secretsPrinted":false}
```

The initializer creates private directories, independent random OTP/proxy/restic secrets, empty placeholders for external credentials, and release state. It refuses to overwrite an existing initialized deployment.

## 6. Install production secrets without putting them in shell history

Run:

```bash
sudo bash deploy/install-secrets.sh /opt/mega-xo
```

The script securely prompts for the Resend API key, verifies the generated OTP/proxy/Restic secrets, enforces owner-only permissions, and never prints secret values.

If Google or Apple sign-in is enabled later, install their private credentials from owner-only source files:

```bash
sudo bash deploy/install-secrets.sh /opt/mega-xo \
  --resend-file /root/resend-key \
  --google-file /root/google-client-secret \
  --apple-file /root/AuthKey_PRIVATE.p8
```

Only file **paths** appear on the command line; secret values do not.

Never put any secret in:

- GitHub;
- `.env.example`;
- browser JavaScript;
- screenshots;
- chat messages;
- Docker build arguments.

## 7. Verify generated production configuration

These files should exist:

```text
/opt/mega-xo/app.env
/opt/mega-xo/compose.env
/opt/mega-xo/backup.env
/opt/mega-xo/secrets/otp_secret
/opt/mega-xo/secrets/proxy_secret
/opt/mega-xo/secrets/resend_api_key
/opt/mega-xo/secrets/google_client_secret
/opt/mega-xo/secrets/apple_private_key
/opt/mega-xo/secrets/restic_password
/opt/mega-xo/data/
/opt/mega-xo/backup-status/
/opt/mega-xo/releases/
```

Permissions for secret files must be owner-only:

```bash
sudo find /opt/mega-xo/secrets -maxdepth 1 -type f -printf '%m %u:%g %p\n'
```

Expected mode: `600`.

## 8. What is intentionally not done by bootstrap

Bootstrap does not:

- publish a release image;
- start the production game;
- configure Google or Apple credentials;
- enable purchases, ads, or paid entry;
- create an off-box backup account;
- change Oracle firewall rules automatically;
- change Hostinger DNS automatically;
- expose admin/metrics endpoints publicly.

The first production start happens only after a validated ARM64 image has passed CI and is addressed by immutable GHCR digest.

## 9. Pinned infrastructure images

Application base:

```text
node@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
```

Caddy edge:

```text
caddy@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f
```

Changing either digest is a reviewed dependency update and must rerun amd64 + arm64 container acceptance.
