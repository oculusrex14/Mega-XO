# Friends account-error presentation — 15 October 2026

Base source: `6671d02ae80811534e27b20b61f1a544315fb9b7`, including Main's V5.2 work through
`efeba70`. The two-file change is committed alongside this receipt; this is local functional
acceptance, not a deployed staging or production pass.

The original guest browser observation remained on “Checking your account…” across revisits,
but elapsed time for each Friends visit was not recorded. The indefinite-loading explanation
was not reproduced. The prior observation does not establish that a pending request exceeded
the explicit eight-second account deadline.

A separate defect was reproduced with a failing-first functional test: when that deadline fires,
the app context correctly records `sessionStatus:error`, but Friends renders the confirmed-guest
sign-in prompt and hides the timeout and retry action. `friendsPage` now handles the error before
the guest branch, escapes the account message, and uses the existing account retry action.
Private lists stay unavailable until a linked profile is verified.

Regression coverage verifies unresolved checks remain pending at 7,999ms; explicit anonymous
responses settle across route visits; an eight-second timeout shows the error and retry; retry
can settle as guest; and a late former private profile cannot replace the guest or reveal data.
No backend, account, session cookie, economy, rule, native or provider setting changed.

Validation: `node --test tests/v5-p21-*.test.js tests/v51-p21-*.test.js tests/v52-p21-powers.test.js tests/powers-integration.test.js tests/v5-native-foundations.test.js`
→ **316 pass, 0 fail, 5 skip**. Skips require an owned PostgreSQL/Redis lab. The focused four
Friends/data/app/pages suites also pass 85/85. `git diff --check` passes. Full output is retained
in `friends-merged-regression.log`; no player data or credentials are present.

Deployment: NOT_RUN for this fix. Rollback: revert the scoped renderer and two test hunks.
