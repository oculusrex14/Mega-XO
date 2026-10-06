# V4.1 mail-domain security acceptance

Mega XO sends transactional mail as `contact@antimatterinnovations.com` while Google Workspace also receives normal Antimatter Innovations mail on the same domain. Provider "domain verified" badges are prerequisites, not proof of the complete public DNS/authentication posture.

## Repository controls

Production configuration binds `MEGA_EMAIL_FROM` to `MEGA_EMAIL_DOMAIN`. The default domain is:

    antimatterinnovations.com

If the From address drifts to another domain, startup fails with `EMAIL_FROM_DOMAIN_MISMATCH`.

The DNS audit is:

    npm run mail:audit

It reads public DNS only. It never reads the Resend API key, Google credentials, message contents or DKIM private keys.

## Configure the audit from provider consoles

Before running the audit, copy only the **public DNS hostnames/requirements** shown by the current Google Workspace and Resend consoles.

Example shell variables:

    export MEGA_EMAIL_DOMAIN=antimatterinnovations.com
    export MEGA_MAIL_RETURN_PATH_DOMAIN=send.antimatterinnovations.com
    export MEGA_MAIL_DKIM_HOSTS='GOOGLE_DKIM_HOST,RESEND_DKIM_HOST'
    export MEGA_MAIL_APEX_SPF_INCLUDES='_spf.google.com'
    export MEGA_MAIL_RETURN_SPF_INCLUDES='amazonses.com'
    export MEGA_MAIL_MX_SUFFIXES='google.com'
    export MEGA_DMARC_MIN_POLICY='quarantine'
    export MEGA_DMARC_REQUIRE_RUA=true
    npm run mail:audit

Do not guess DKIM selectors. Use the exact public record hostnames that the provider consoles currently instruct you to publish. The audit accepts either TXT-key or CNAME DKIM publication.

## What the audit requires

- exactly one SPF record at the organizational domain;
- the expected Google Workspace SPF include on that SPF record;
- at least one expected Google Workspace MX target;
- a return-path domain that is the same domain or a subdomain of the organizational domain;
- exactly one SPF record at the return-path domain with the expected provider include;
- an MX record at the return-path domain;
- every configured Google/Resend DKIM hostname to resolve as published;
- exactly one DMARC record;
- DMARC policy at least as strong as `MEGA_DMARC_MIN_POLICY`;
- `pct=100`;
- syntactically valid SPF/DKIM alignment modes;
- an aggregate-reporting `rua` destination unless explicitly disabled.

The JSON output intentionally contains record counts, policy/alignment facts and DKIM presence/type only. It does not echo full DKIM public keys.

## Live-message acceptance

DNS publication is necessary but not sufficient. After the DNS audit passes, execute `deploy/EMAIL-LIVE-ACCEPTANCE.md` and inspect the received message headers.

For signup OTP, password-reset OTP and password-change notice, record only that:

- Header From is `contact@antimatterinnovations.com`;
- SPF reports PASS;
- DKIM reports PASS and the signing domain aligns with the From organizational domain;
- DMARC reports PASS;
- the observed return-path matches the configured aligned return-path design;
- normal Google Workspace inbound/outbound mail still functions.

Do not paste full message headers into GitHub because they can contain mailbox addresses, provider message IDs, routing metadata and IP information.

## DMARC rollout

A repository default cannot decide organizational mail policy. Set `MEGA_DMARC_MIN_POLICY` to the approved Antimatter Innovations posture for the acceptance run. If the domain is still in a monitored `p=none` rollout, record that as an unresolved external decision instead of weakening the release evidence silently.

Before moving from monitoring to quarantine/reject, confirm Google Workspace, Resend, and every other legitimate Antimatter Innovations sender is represented and aligned.

## Evidence for EXT-35

Record non-secret facts only:

- date/time;
- domain and return-path hostname;
- provider DKIM hostname names, not key contents;
- `npm run mail:audit` exit code and summarized checks;
- approved DMARC policy;
- live message SPF/DKIM/DMARC PASS;
- confirmation that Google Workspace mail remained functional.

Hostinger/Google Workspace/Resend console changes stay external to the repository.
