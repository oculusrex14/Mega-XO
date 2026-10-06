# V4.1 incident response and secret rotation

This runbook covers credential leakage, account/session compromise, provider compromise, backup credential leakage, and broader security incidents.

The rule is: **contain first, rotate second, validate deliberately, then clear maintenance explicitly**.

## 1. Enter audited incident lockdown

From the deployed repository on the VPS:

```bash
export MEGA_ROOT=/opt/mega-xo
export MEGA_IMAGE=$(cat /opt/mega-xo/current-image)
docker compose --env-file "$MEGA_ROOT/compose.env" -f deploy/compose.yaml \
  exec -T app node scripts/operator.js incident-lockdown \
  --operator YOUR_OPERATOR_ID \
  --reason "Suspected credential compromise under investigation"
```

Lockdown enables maintenance, revokes active sessions, invalidates pending OAuth and OTP attempts, removes pending OTP password material, cancels queued/sending transactional email payloads, and records the action in the immutable operator audit chain.

Check status with:

```bash
docker compose --env-file "$MEGA_ROOT/compose.env" -f deploy/compose.yaml \
  exec -T app node scripts/operator.js incident-status
```

## 2. Preserve evidence without copying secrets

Record only non-secret facts: UTC times, release SHA/digest, audit output, restart counts, redacted health, provider event IDs/statuses, and affected player IDs when required. Never copy session cookies, OTPs, access tokens, API keys, provider private keys, raw database files, or password hashes into tickets/chat/GitHub.

## 3. Rotate supported secrets

Create the replacement in the provider console first and save it in an owner-only temporary file outside the repository:

```bash
sudo bash deploy/rotate-secret.sh /opt/mega-xo SECRET_NAME /root/new-secret
```

Supported names:

```text
resend_api_key
google_client_secret
apple_private_key
proxy_secret
otp_secret
```

The helper validates known formats, atomically replaces the VPS secret, recreates only affected services, restores the previous local value if validation/restart fails, and never prints either secret. R2 access credentials are intentionally excluded because they must be rotated as a pair.

Proxy and OTP secret rotation require active audited incident lockdown. Proxy rotation changes the edge-to-app trust boundary and derived operator key. OTP rotation deliberately invalidates every pre-rotation OTP.

## 4. Resend compromise

Create a replacement Resend key, rotate `resend_api_key`, validate liveness, run the real email acceptance flow, then revoke the old key in Resend. If the leaked key could send mail from the Antimatter Innovations domain, review provider delivery logs for unauthorized sends.

## 5. Google and Apple credentials

For Google, rotate `google_client_secret`, run `provider-web-smoke.js`, complete a real login, then retire the old credential. Mega XO identity remains bound to Google's verified `sub`.

For Apple, create a new Sign in with Apple key, rotate `apple_private_key`, update `APPLE_KEY_ID` if it changed, redeploy/recreate the app, run provider smoke and a real login, then revoke the old Apple key. Do not install a new `.p8` while leaving a mismatched key ID.

## 6. R2 backup credentials

Create a replacement R2 token scoped only to the backup bucket, then rotate the pair atomically:

```bash
sudo bash deploy/rotate-r2-credentials.sh /opt/mega-xo /root/new-r2-access /root/new-r2-secret
```

The helper replaces both values together, recreates the backup worker, runs a Restic repository check, and restores the previous pair if verification fails. Then create/retrieve one fresh snapshot and revoke the old R2 token. Do not delete backup history just because access credentials changed.

## 7. Restic encryption password

Do **not** replace `restic_password` with the generic rotation helper. Use Restic authenticated key management: preserve the current recovery password offline, add a new key/password, prove access and `restic check`, retrieve/verify a snapshot, then remove the old key. Keep the new recovery password outside both Oracle and Cloudflare.

## 8. Proxy and OTP trust roots

Both require incident lockdown.

After proxy rotation run the host perimeter audit and outside-in perimeter probe. After OTP rotation prove that no pre-rotation OTP works and run real signup plus forgot-password OTP acceptance.

## 9. Account/session incident

For one player, use the operator CLI `sessions-revoke` or `hold-on` with an operator ID and meaningful reason. Holds revoke current sessions and prevent normal account use until explicitly cleared. Never alter wallet balances as an incident-response shortcut.

## 10. Recover deliberately

While lockdown remains active, verify app liveness, the immutable audit chain, relevant provider/email flows, backup access, and perimeter health. `/opsz` is expected to remain unhealthy while maintenance is on.

Clear the incident marker first:

```bash
docker compose ... exec -T app node scripts/operator.js incident-clear \
  --operator YOUR_OPERATOR_ID \
  --reason "Credential rotation and acceptance checks completed"
```

Incident clear does not disable maintenance. Only after validation:

```bash
docker compose ... exec -T app node scripts/ops.js maintenance off
sudo bash deploy/check-health.sh /opt/mega-xo
```

## 11. Required external drills

Before marking V4.1 incident operations production-ready, perform staging drills for global lockdown/recovery, proxy rotation, OTP rotation, Resend rotation, R2 credential rotation, and Restic key rotation. Google/Apple key rotation is drilled when those providers are enabled.

Record only non-secret evidence in `docs/V4-OPEN-BLOCKERS.md`.

## 12. Post-incident review

Record the cause, affected systems/data, detection/containment/recovery times, credentials rotated, invalidation counts, unauthorized activity if any, and corrective work. Do not weaken privacy/logging boundaries for convenience.
