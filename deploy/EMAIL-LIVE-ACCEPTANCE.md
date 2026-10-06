# V4 real email delivery acceptance

This proves the complete public email path:

**browser/client → Caddy HTTPS → V4 account API → encrypted mail outbox → Resend → real mailbox → OTP verification**

It must be run on staging before production and again after the first production deployment.

## Prerequisites

- Resend sender domain verified.
- Resend API key installed on the target deployment.
- Target deployment is healthy over real HTTPS.
- A test mailbox or alias you control that has never been used for a Mega XO account on that environment.
- For staging, the generated Basic Auth password file is available on the VPS.

The test script generates two strong temporary passwords in memory. It never prints or writes them to disk. It asks the operator to type the two actual 6-digit OTPs received by email.

## Staging

Run from a trusted machine with Node 24+:

```bash
node scripts/live-email-acceptance.js \
  https://staging.play.antimatterinnovations.com \
  UNUSED_TEST_EMAIL \
  --basic-password-file /secure/path/to/staging-password
```

If running directly on the VPS, the staging password file is:

```text
/opt/mega-xo-staging/secrets/staging_access_password
```

Do not copy that password into GitHub.

## Production

Use a separate unused test alias:

```bash
node scripts/live-email-acceptance.js \
  https://play.antimatterinnovations.com \
  UNUSED_TEST_EMAIL
```

## What the script proves

### Signup ownership

1. creates an anonymous session;
2. requests account creation using the test email and a generated password;
3. verifies that the server returns a pending OTP challenge rather than an account;
4. pauses while the operator checks the real mailbox;
5. verifies the actual OTP;
6. confirms the profile becomes active only after OTP success.

### Password recovery

1. starts a fresh anonymous session;
2. requests **Forgot password** for the same account;
3. pauses for the real reset OTP;
4. verifies that OTP;
5. replaces the password with a second generated password;
6. confirms the reset returns the same player identity.

### Credential invalidation

Finally it proves:

- the original password is rejected;
- the replacement password signs in;
- the same player ID and player tag are restored.

## Mailbox inspection

For both signup and reset emails, manually confirm:

- sender display name is **Mega XO by Antimatter Innovations**;
- sender address is **contact@antimatterinnovations.com**;
- the expected purpose is clear;
- the OTP is 6 digits;
- expiry is stated as 10 minutes;
- the email does not contain a password;
- no development/version commentary appears;
- reply/contact identity is Antimatter Innovations.

For the password-changed notification, confirm it arrives after reset and points users to the Antimatter Innovations support address if the change was unauthorized.

## Failure handling

If the API says the test email already exists, use a fresh mailbox alias. Do not delete production data merely to reuse a test address.

If the OTP email does not arrive:

1. do not repeatedly hammer **resend**;
2. inspect V4 outbox/health state;
3. check Resend dashboard delivery status;
4. check spam/junk folder;
5. check the deployment mail budget;
6. verify the configured sender/domain in Resend;
7. retry only after identifying whether the request, queue, provider delivery, or mailbox placement failed.

Do not add a debug route that exposes OTP values.

## Completion evidence

Update `docs/V4-OPEN-BLOCKERS.md` without recording the email address or OTP:

- EXT-12 after staging signup + reset both pass;
- the production release evidence under EXT-17 after the same acceptance passes against production.

Recommended evidence:

```text
2026-..-.. real email acceptance passed:
signup OTP delivered/verified;
reset OTP delivered/verified;
old password rejected;
same player tag restored.
```
