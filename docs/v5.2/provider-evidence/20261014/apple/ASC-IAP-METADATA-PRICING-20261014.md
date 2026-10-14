# Apple IAP metadata and base-price setup — 2026-10-14

**Observed:** 2026-10-14 17:52:33 UTC
**Scope:** Existing App Store Connect draft IAPs for Mega XOXO.
**Evidence handling:** Sanitized record IDs, store metadata, price schedule, status, and UI-confirmed behavior only; no screenshots or private account values retained.

## App and team

- App Store Connect app: **Mega XOXO**, Apple ID `6822833387`
- Bundle identifier: `online.megaxo.xoxo`
- Paid Individual team: `6N6C9338NX`
- All work used the four existing IAP records; no duplicate record was created.

## Existing products

| Product ID | Apple ID | Type | English (U.S.) display name | English (U.S.) description | U.S. base price |
| --- | --- | --- | --- | --- | ---: |
| `crowns_100` | `6822841630` | Consumable | 100 Crowns | 100 Crowns for Mega XOXO. | USD $0.99 |
| `crowns_525` | `6822841920` | Consumable | 525 Crowns | 525 Crowns for Mega XOXO. | USD $4.99 |
| `crowns_1100` | `6822841925` | Consumable | 1,100 Crowns | 1,100 Crowns for Mega XOXO. | USD $9.99 |
| `remove_ads` | `6822842392` | Non-Consumable | Remove Ads | Auto interstitials removed; opt-in rewarded ads remain. | USD $3.99 |

The owner approved the four U.S. base prices. Each schedule uses United States (USD) as its base. App Store Connect generated comparable prices for 174 other countries or regions; examples observed for India were ₹99.00, ₹499.00, ₹999.00, and ₹399.00 in the same order as the table. These are storefront prices shown by Apple, not proceeds. Apple states a schedule takes effect only after IAP approval and when the app is Ready for Sale.

## Current release state

- All four records remain **Prepare for Submission**.
- IAP availability is still unconfigured; none was enabled for sale.
- No IAP or app was submitted for review. The first non-consumable requires submission with a new app version.
- Family Sharing remains off. No screenshot, offer code, tax-category change, Paid Apps Agreement, banking, or tax action was made.

## Supersession

This receipt supersedes the IAP metadata, price, and availability statements in `ASC-BUSINESS-IAP-DRAFTS-20261014.md` and the earlier pre-setup IAP paragraph in `ASC-APP-READINESS-20261014.md`. The records are existing drafts with metadata and base-price schedules saved; release availability and review remain incomplete.
