# Mega XO P1-6 legal/privacy approval checklist

Status: **OPEN — repository package prepared, formal approval outstanding**  
Draft date: 2026-10-07

This checklist is the handoff between repository implementation and Antimatter Innovations' legal/store approval process.

The repository can implement controls and draft disclosures. It cannot decide governing law, statutory obligations or legal sufficiency on behalf of Antimatter Innovations.

## A. Public document approval

Review and approve:

- [ ] `public/privacy.html`
- [ ] `public/terms.html`
- [ ] `public/support.html`
- [ ] `public/privacy-choices.html`
- [ ] `public/delete-account.html`
- [ ] `docs/legal/DATA-INVENTORY-RETENTION.md`
- [ ] `docs/legal/COOKIE-AND-CONSENT.md`
- [ ] `docs/legal/STORE-PRIVACY-DECLARATIONS.md`

After approval:

- remove all "Draft / not yet effective" notices;
- replace the draft date with effective/last-updated dates;
- change privacy/terms robots metadata from `noindex,nofollow` to the approved publication posture;
- assign immutable version IDs;
- set `MEGA_PRIVACY_POLICY_VERSION`;
- set `MEGA_RETENTION_POLICY_VERSION`;
- record non-secret approval evidence in `docs/V4-OPEN-BLOCKERS.md`.

## B. Legal identity and contract terms

The final documents must resolve:

- [ ] exact legal/developer entity name behind "Antimatter Innovations";
- [ ] legally required registered/business/contact address;
- [ ] privacy/controller contact details and whether a DPO/representative is required;
- [ ] final minimum user age and parental-consent rules;
- [ ] launch jurisdictions/countries;
- [ ] governing law and dispute venue;
- [ ] mandatory local consumer-rights language;
- [ ] refund/cancellation language consistent with Apple/Google and local law;
- [ ] virtual-currency treatment and expiry/refund rules;
- [ ] suspension/moderation appeal process;
- [ ] notice/acceptance process for future Terms/Privacy changes.

Paid-entry competition remains outside this approval package and stays disabled under EXT-26.

## C. Retention approval

Assign an approved maximum duration and rationale for:

- [ ] purchase/replay/refund records;
- [ ] operator/security audit records;
- [ ] moderation reports/outcomes;
- [ ] account-deletion receipts;
- [ ] encrypted disaster-recovery backups;
- [ ] legal holds and hold-release procedure.

Confirm that the Restic prune schedule and restore procedure implement the approved backup duration before setting `MEGA_RETENTION_POLICY_VERSION`.

## D. Privacy rights and requests

For the actual launch jurisdictions, determine:

- [ ] required access/export rights;
- [ ] correction rights;
- [ ] deletion/erasure rights;
- [ ] objection/restriction rights where applicable;
- [ ] portability requirements;
- [ ] advertising/sale/share opt-outs where applicable;
- [ ] response deadlines;
- [ ] identity-verification procedure;
- [ ] authorized-agent/guardian handling;
- [ ] appeal/complaint route;
- [ ] regulatory authority disclosures if required.

Map each approved right either to an in-product control or to the support process.

## E. Children/age position

Before launch:

- [ ] decide whether Mega XO is directed to children, a general audience, or age-restricted;
- [ ] align App Store/Play age and target-audience declarations;
- [ ] decide whether parental consent is required in any launch region;
- [ ] review advertising configuration for child/teen restrictions;
- [ ] ensure account creation and profiling do not request unnecessary child data.

Do not enable a child-directed advertising configuration merely from repository defaults.

## F. Processor/vendor review

Approve the production processor/vendor register and applicable agreements for:

- [ ] Oracle Cloud hosting;
- [ ] Cloudflare R2 encrypted backups;
- [ ] Resend transactional email;
- [ ] Google identity / Play Billing / AdMob as enabled;
- [ ] Apple identity / StoreKit as enabled;
- [ ] uptime/availability monitoring;
- [ ] any future analytics/crash/support SDK.

For each provider, record:

- purpose;
- data categories;
- regions/subprocessors;
- retention;
- security/DPA terms;
- international-transfer mechanism if required.

## G. App Store / Google Play declarations

Before submission:

- [ ] review the exact native binary/SDK list;
- [ ] finalize Apple App Privacy answers;
- [ ] finalize Google Play Data safety answers;
- [ ] enter the approved Privacy Policy URL;
- [ ] enter the external account-deletion URL in Play Console;
- [ ] verify in-app account deletion on both platforms;
- [ ] verify Sign in with Apple token revocation on account deletion if Apple login ships;
- [ ] ensure declarations cover third-party SDK collection;
- [ ] re-check declarations whenever SDKs or data practices change.

## H. Cookie/advertising consent

Before any advertising or non-essential tracking is enabled:

- [ ] confirm which launch regions require consent/opt-out controls;
- [ ] decide personalized vs non-personalized/limited ad posture;
- [ ] approve UMP/privacy-options behavior and copy;
- [ ] confirm no ad request occurs before the required consent state;
- [ ] document whether web functional cookie/local-storage use needs any banner in launch regions;
- [ ] prohibit new web trackers without legal/privacy release review.

## I. Production acceptance

P1-6 is complete only when:

- [ ] approved public Privacy Policy is live;
- [ ] approved Terms are live;
- [ ] Support and Privacy choices pages are live;
- [ ] account deletion is enabled with approved policy/retention versions;
- [ ] live deletion acceptance passes;
- [ ] data export acceptance passes;
- [ ] store privacy/data-safety declarations are submitted and accepted;
- [ ] the effective provider/SDK list matches the disclosures;
- [ ] `EXT-21`, relevant portions of `EXT-25`, `EXT-29` and `EXT-30` have their required non-secret evidence.

Until then, the repository should describe P1-6 as **implementation/draft complete, legal approval pending** rather than "legally complete."
