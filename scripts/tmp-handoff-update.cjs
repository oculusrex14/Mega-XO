const fs=require('fs');
const p='/Users/oculus/.codex/worktrees/v52-monetization/Test XO/docs/v5.2/MAIN-AGENT-HANDOFF-MONETIZATION-20261016.md';
let s=fs.readFileSync(p,'utf8');
const oldHeading='## 4. Paddle (final global PG) - status and next steps';
const newSection=['## 4. Global PG decision - Polar primary, Paddle fallback (owner-approved 2026-10-16)','','- DECISION: Polar is the primary global PG. Fees are tied with Paddle at the headline rate for new accounts (5% plus 50 cents) and cheaper at volume (Pro: 20 USD/mo at 3.8% plus 40 cents; Growth: 100 USD/mo at 3.6% plus 35 cents). India payouts are direct-to-bank over Stripe Connect with small payout fees, and the owner has ALREADY completed the Polar payout-account setup (bank linked). Paddle remains a fallback: a flat 5% plus 50 cents with NO non-US-card surcharge (Polar adds 1.5% for non-US cards - relevant for an international audience), but its India payouts need a Payoneer intermediary and its payout setup is locked behind account verification (owner is In progress). Revisit Paddle if the non-US surcharge shows up badly in real statements.','','- Polar account: Antimatter Innovations on polar.sh, business onboarding submitted, payout account configured (bank linked). API key still needed: Polar dashboard > Developer > API keys - create it and pipe it to secrets/polar.env on the VPS (mode 600, never committed; same no-print pipeline as Cashfree).'].join('\n');
if(!s.includes(oldHeading))process.exit(4);
s=s.replace(oldHeading,newSection);
fs.writeFileSync(p,s);
console.log('patched');
