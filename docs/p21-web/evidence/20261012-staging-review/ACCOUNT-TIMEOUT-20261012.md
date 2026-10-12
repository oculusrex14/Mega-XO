# R15 staging account timeout — 2026-10-12

Status: **owner-reported defect; signup timeout not independently reproduced**. Main owns API/service diagnosis. No production endpoint was used, and no credentials, OTPs, session identifiers, actor identifiers or raw authenticated traces are included.

## Report and target

The owner tried email continuation at the private V5 staging account page and reported: “The service did not respond in time. Try again.” The owner also said the account exists in V4.1 production. V4.1 identity is not evidence of an account in the isolated V5 staging database; no identity migration was approved or performed by Codex.

Target: `http://100.107.65.122:8081/account`. Prior public-file verification identifies frontend source `f4851a568524846d981b351c659af4a9ee7479be`, bundle `8167f349fb16b303c9347ac544afc3f9c73b9ea5515b0a085a7f40a6d75f3ea3`. Server/API boot SHA is not verified. Main checkout and `origin/V5.1` were `46da760c8c3da1fcec0733ba1b92f8f296762ba4` when source was reviewed.

CUA follow-up could locate only the staging `/game` tab, not the account tab. No form values were inspected, no credential was entered, and no signup retry was submitted. The reported account error remains owner evidence, not a CUA reproduction. A separate app selection timed out; that is a tool availability failure and is not evidence of a website failure or an automatic approval-review rejection.

## Cookie-free endpoint timing

Around 17:23 UTC, two parallel `fetch` probes used the explicit tailnet origin, no Cookie or Authorization header, `redirect: 'error'` and `AbortSignal.timeout(20000)`. Only sanitized status/timing and field-presence facts were output. The response was fully read before elapsed time was measured; cookie/CSRF values were never output or saved.

| Route | Status | Elapsed | Observed facts |
|---|---:|---:|---|
| `/livez` | 200 | 3,991 ms | JSON; `Cache-Control: no-store`; `X-Robots-Tag: noindex, nofollow` |
| `/api/account/session` | 200 | 4,181 ms | JSON; `Cache-Control: private, no-store`; `linked: false`; CSRF field present; empty provider keys; noindex/nofollow |

A session GET can issue an anonymous staging session. This was a bounded staging diagnostic, not a durable signup/login or authenticated acceptance result. One sample is not a latency distribution and cannot identify which request in the owner's continuation timed out.

## Source budget and Main's next diagnosis

The served shared client `src/account-client.js` uses a **4,500 ms** session-bootstrap abort budget with at most two attempts, and an **8,000 ms** request budget with at most two POST attempts and a retained operation key. The observed 4,181 ms bootstrap is close to that client budget. This supports a latency hypothesis, not proof of the reported signup's cause. Do not simply extend the preserved 15-second matchmaking offer TTL or change economy/identity contracts to bypass this failure.

Main should pin the running server/API revision, measure session/email phases with a controlled staging test actor, and distinguish network/event-loop delay, database round trips, password work, OTP dispatch and frontend timeout. Supply a sanitized receipt with route, phase timings, status/error code and exact server/frontend identifiers. Never include email, password, OTP, cookie or CSRF values. Keep outbound email disabled and use the approved private staging OTP channel. After correction, the human completes the credential step privately and Codex resumes supported browser acceptance of profile/session refresh/logout, wallet and online continuity.

## Separate cookie configuration finding

At Main source `46da760`, `apps/api/routes/account.js:256` defines `sessionCookieHeaders()` with an unconditional non-`Secure` `mega_dev_session` cookie carrying the same token as the Secure `__Host-mega_session` cookie. This is required by the current private HTTP staging flow but has no environment guard in the reviewed helper. Main/WebUI should restrict the development fallback to explicitly permitted private HTTP staging and verify HTTPS responses do not emit or accept that fallback. This is a source-review finding before HTTPS/production acceptance; Codex did not inspect cookie values or change backend code.

R15 remains open. Rollback for this diagnostic is no application change; Main retains control of isolated test actor/session cleanup and server recovery.
