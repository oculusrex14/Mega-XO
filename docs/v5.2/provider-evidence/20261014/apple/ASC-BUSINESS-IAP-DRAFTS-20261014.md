# Apple Business handoff and IAP draft receipt — 2026-10-14

**Observed:** 2026-10-14 17:32:01 UTC  
**Scope:** Read-only inspection of the existing Apple Business owner forms and ordinary draft setup in Mega XOXO's existing App Store Connect app record.  
**Evidence handling:** Sanitized field labels, option labels, presence booleans, IDs, and provider statuses only. No screenshots or private form values retained.

## Business owner forms

### Edit Legal Entity

The form was opened and cancelled without saving. It exposed these fields:

| Field | Existing value present? | Control / options |
| --- | --- | --- |
| Name | Yes | Disabled |
| Type | Yes | Disabled; options shown: Corporation, Individual |
| Address 1 | Yes | Editable text |
| Address 2 | No | Editable text |
| City | Yes | Editable text |
| State or Province | Yes | Editable dropdown; Indian state/territory choices |
| Postal Code | Yes | Editable text |
| Country or Region | Yes | Disabled |

No required markers were exposed on the form. The form did not show phone, banking, or tax inputs. No field values are reproduced here.

An **Address Identification Document** prompt also appeared in the Business workflow. It asks for a copy of documentation confirming the provided address. The language field showed **English (Asia)**; **Upload Documents** was empty and **Next** disabled. The prompt was cancelled without uploading a document.

### Digital Services Act compliance

The modal asks the account holder to choose one of the following. Neither radio option was selected and **Next** was disabled; the modal was cancelled without submitting a declaration.

- **“I'm a trader under the DSA”** — Apple says an address, phone number, and email address will be required for display on the EU App Store product page.
- **“I'm not a trader under the DSA or I don't plan to distribute in the EU”** — Apple says no contact information will be displayed on the product page.

Apple's on-screen “Learn more about whether you qualify as a trader” link resolves to [Manage EU Digital Services Act compliance information](https://developer.apple.com/help/app-store-connect/manage-compliance-information/manage-eu-digital-services-act-compliance-information).

### Paid Apps Agreement and payment setup

The existing Business agreements page shows **Paid Apps Agreement — New** and says legal-entity information must be updated before signing. The console did not expose the agreement version or an acceptance link before that update. No agreement was accepted.

The current legal-entity and DSA forms contain no banking or tax fields. Apple's published workflow says the Account Holder signs the Paid Apps Agreement before entering tax and banking information; Apple says banking information is required to receive payment and tax forms are submitted after the Paid Apps Agreement is signed:

- [App Store Connect workflow](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-workflow/)
- [Provide tax information](https://developer.apple.com/help/app-store-connect/manage-tax-information/provide-tax-information/)
- [Enter banking information](https://developer.apple.com/help/app-store-connect/manage-banking-information/enter-banking-information/)
- [Sign and update agreements](https://developer.apple.com/help/app-store-connect/manage-agreements/sign-and-update-agreements/)

These published workflows do not disclose the exact agreement version offered to this account; the account's acceptance flow must reveal it after Apple's legal-entity update is completed.

## In-App Purchase draft records

The existing app record is App Store Connect Apple ID **6822833387**, Mega XOXO, bundle **online.megaxo.xoxo**, under paid Individual Team **6N6C9338NX**. Four approved catalog entries now exist as **Prepare for Submission** drafts:

| Reference name | Product ID | Type | App Store Connect product Apple ID | Status |
| --- | --- | --- | --- | --- |
| 100 Crowns | `crowns_100` | Consumable | `6822841630` | Prepare for Submission |
| 525 Crowns | `crowns_525` | Consumable | `6822841920` | Prepare for Submission |
| 1,100 Crowns | `crowns_1100` | Consumable | `6822841925` | Prepare for Submission |
| Remove Ads | `remove_ads` | Non-Consumable | `6822842392` | Prepare for Submission |

Each detail page showed **no starting price schedule** and **no availability**. Display name/description and review screenshots remain unset; no Add for Review action was taken. ASC says the first IAP must be submitted with a new app version, and a Paid Apps Agreement is required to sell an IAP.

Owner-approved base prices are USD 0.99, 4.99, 9.99, and 3.99 respectively. No price tier was selected because the console's exact localized price equivalence was not confirmed. The paid agreement, app version, review, and public release remain untouched.

## Supersession

This receipt supersedes the earlier **“In-App Purchases”** paragraph in [ASC-APP-READINESS-20261014.md](ASC-APP-READINESS-20261014.md), which recorded the pre-creation state. All other observations in that earlier app readiness receipt remain unchanged.
