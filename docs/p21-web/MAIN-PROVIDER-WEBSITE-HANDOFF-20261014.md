# Final provider / website coordination — 14 October 2026

Codex checkpoint against `V5.1` source `78b258224d799d8e29e6d7b6cae1bb25dcbe1758`. Main's current execution board is in its preserved checkout at `docs/v5.1/release/EXECUTION-BOARD-20261014.md`; Codex has not edited or committed that Main-owned file.

## Authority and ownership

The owner's new final-provider directive authorizes the gated website/backend production release and day-one gameplay collection. It supersedes historical requests for another general launch approval. Main remains the sole production cutover operator. Store public distribution, purchases of services, training/model promotion, and bypassing security/privacy/recovery gates are excluded. Native real advertising remains disabled until consent, device, ownership and provider gates pass.

The approval of collection scope does not supply missing numeric retention windows or demonstrate user-choice delivery. Current capture-off notices remain truthful until the backend contract and policy are actually enabled. Do not relabel old lab receipts as current production acceptance.

## Main integration requirements

1. **A02 email:** reuse the existing verified `antimatterinnovations.com` sender `contact@antimatterinnovations.com`. The existing Resend key is sending-only and domain-restricted; preserve V4's key and delivery. Current V5 staging routes codes to the private sink and has no live Resend transport. Wire the V5 transport under protected key custody, then give Codex its exact reachable staging origin, process/boot/source identity, frontend manifest/hash and email-enabled state. The owner approved two receiving mailboxes; their addresses are in the private local handoff, not public evidence. Test real delivery plus verification, consumed/expired-code denial, reset/change notification, limits and honest provider failure. Never return OTPs over HTTP or log them in acceptance evidence.
2. **B05 HTTP routing:** P21 browser requests are same-origin. `apps/web/vercel.json` currently has no `/api/*` or `/auth/*` upstream rewrites. Confirm the production API project/deployment and complete Origin/CSRF/cookie contract before Codex adds the precise website-side routing. A separately deployed API returning healthy reads is insufficient proof of browser signup/session continuity.
3. **B05 WSS:** `apps/web/realtime.js` opens same-origin `/realtime/v1`. The public Core edge presently exposes only signed `/ingress/*`, and Vercel HTTP Functions are not the WebSocket server. Supply the verified public ticket-authenticated WSS endpoint, permitted website Origins, routing and actor/session-isolation contract. Codex can integrate an explicit trusted endpoint after this contract is fixed; do not expose private Core paths or trust client actor headers.
4. **A05 choice:** supply the authenticated gameplay-research status/choice endpoint, response/error schema and withdrawal semantics. Bind the actor from the validated session; never accept an unsigned actor field. Confirm how changing the choice invokes suppression, erasure/export revocation and restore-journal fences. Codex owns the website notice/control and signed-in loading/error/confirmation states after this contract is available.
5. **A05 policy:** supply approved purpose/version and numeric capture/export/journal/backup retention, storage/encryption references and effective collection state. The current source release gate still requires all 15 current evidence entries and exact deployed source/rules/privacy-epoch binding. Codex will align public notices to implemented behavior and record browser evidence, without modifying Main's learning/training files.
6. **AdMob SSV:** verified real app/unit IDs are in the Codex provider checkpoint. Reward metadata is exactly `1 cosmetic_reward`. Legacy source has `/api/monetization/admob-ssv`; the current Vercel API has no such handler. Supply the V5 public callback after signature verification, authenticated ticket/actor/ad-unit binding, unique transaction/idempotency and authoritative Cosmetic Credit eligibility are integrated. No client grant, Coins/Crowns grant or staging callback may be configured as a production reward path.
7. **A04 monitoring:** Codex is verifying external monitors and authorized receivers. Main supplies safe Core health semantics and instrumented host/process/Neon/Redis/backups/outbox/capture targets, plus an isolated controlled-failure hook. A monitor record alone is not delivered incident/recovery proof. Avoid exposing operational secrets through health routes.
8. **E release:** provide the final production process/image/source identities, separate non-staging DB/Core/Redis/session/signing environment receipt, recovery/fence evidence and agreed release window after gates pass. Codex then applies the agreed website/domain routing, runs browser smoke tests against the same production authority, and releases indexing only after public acceptance. The current `core.megaxo.online` staging route is explicitly unsuitable for a production API.

## Current read-only hosting observations

- Vercel account scope `oculusrex14s-projects`, Hobby plan. The owner's current non-commercial hobby scope is retained; no upgrade or charge was made. Vercel's [Hobby documentation](https://vercel.com/docs/plans/hobby) limits that plan to non-commercial personal use. Preparing disabled mobile ad units does not activate commercial serving; revisit hosting if commercial activity begins.
- Existing website project `mega-xo-web` (`prj_PBLPF0V2wDsVC5hV83im2EatwKbI`), API project `mega-xo-api` (`prj_y2zGwwGwk3zVdP6sevw5S3z5qN65`). No duplicate projects created.
- Website project read shows root directory unset, build command `node ../../scripts/p21/build-web.js --output apps/web/dist`, output `dist`, no Git connection. Reconcile deploy working-directory/root behavior before a new deployment; do not assume a Git-root build has the intended input.
- Vercel website's current alias is `web-nine-phi-f2vlp4rde0.vercel.app`. Provider labels its old deployment `target: production`, but this is **not** evidence of the new public game release: source metadata is `888e542b9265c0d78855441953bedb868cacbea6`, `gitDirty: 1`, and the canonical domain is absent. Preserve this distinction.
- API environment-name inventory has Preview/Development values only; no production configuration was installed by Codex. Secret values are excluded from this handoff.
- Hostinger zone: apex A `2.57.91.91` (parked), `www` CNAME `megaxo.online.`, `core` A `129.80.67.164`; no `api` record. Preserve the existing Core record and unrelated records. No DNS mutation or nameserver change performed.
- Vercel default high-severity alert rule `ar_default` has team-owner notifications enabled. This is configuration only: no actual incident/notification/recovery delivery proved.
- Staging `/readyz` returned HTTP 200 with `live:true, ready:true`. This health check is not authenticated-game or production acceptance.

### Delivered preparation since the first checkpoint

- Code commit `6532a1e0536c5f620b4d3c4929d2f1198d18beaa` contains AdMob's console-authorized seller row at `public/app-ads.txt`, explicit builder inclusion and Vercel text/plain header. Prepared clean frontend hash `4eb558b78ca46fdcaf062218d1eaa387d75c43dfde7d69c7afde5736ac1f589e`, 153 files / 3,547,793 bytes; all 256 affected website tests pass. The currently served frontend remains source `5897497`, hash `31cdb4d3…`, 152 files. No hot restart performed during Main's B03.
- Free external TCP monitor `prelaunch-core-tcp443`, ID `804264653`, initially Up. This is port reachability only; Main still supplies a safe application-health hook.
- Both UptimeRobot DOWN/UP **test** messages were observed in the approved receiving inbox after owner sign-in. Receiver values remain private. Controlled staging outage/recovery and broader service monitors remain open.
- Manual anonymous Brave practice passed the six-move tutorial/Beginner handoff, legal keyboard moves and five browser appearances. This is not authenticated multi-account, real-phone or novice-study acceptance.

## Coordination limitation

The Luna browser agent found Terminal running, but computer-use safety review rejected opening it. No Main message was typed, queued or sent, and no research action was interrupted. This file is the durable coordination handoff; do not claim the Main task received a direct message.

Rollback for this checkpoint: documentation only; preserve all provider records and the existing staging/production services. AdMob unit creation is separately documented and does not enable the runtime SDK or serving.
