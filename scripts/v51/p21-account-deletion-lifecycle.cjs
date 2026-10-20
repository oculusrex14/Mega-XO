'use strict';
/* B4 / SAGAN-004 / F054 lifecycle verifier.
 *
 * Exercises cooling -> cancelled AND cooling -> completed on a disposable loopback PG16 cluster
 * through real API/Core/worker services and the checksummed migration chain. The injected clock
 * advances 30 days; no production clock, account, request or database is modified.
 *
 * Run in GitHub Actions (v6-account-deletion.yml):
 * V5_PG_URL=postgres://postgres@127.0.0.1:5432/postgres V5_PG_DISPOSABLE=1 V5_PG_REQUIRED=1
 * node scripts/v51/p21-account-deletion-lifecycle.cjs
 *
 * Supersedes the previous immediate-disable/queued-only assertions. This is synthetic CI evidence,
 * not staging, browser, provider or device acceptance. Receipt notes identify residual erasure.
 * Never prints login material, OTPs, tokens, account identifiers, raw rows or authenticated traces.
 */
if (process.argv.includes('--origin') || process.env.V5_PG_DISPOSABLE !== '1' || process.env.V5_PG_REQUIRED !== '1') {
 throw Error('DISPOSABLE_LOOPBACK_PG_REQUIRED');
}
const test = require('node:test');
const lab = require('../../tests/v5-pg-lab.js');
const { setupDeletion, exerciseCancellation, exerciseCompletion } = require('../../tests/helpers/deletion-lifecycle.js');
lab.installCleanup(test);
test('B4 lifecycle: cooling -> cancelled; original credentials remain usable', async (t) => {
 if (!(await lab.boot(t))) return;
 const result = await exerciseCancellation(await setupDeletion(t, 'b4_script_cancel'));
 console.log(JSON.stringify({ tool: 'p21-account-deletion-lifecycle', path: 'cancel', ...result }));
});
test('B4 lifecycle: cooling -> completed; Core erasure and worker receipt', async (t) => {
 if (!(await lab.boot(t))) return;
 const result = await exerciseCompletion(await setupDeletion(t, 'b4_script_complete'));
 console.log(JSON.stringify({ tool: 'p21-account-deletion-lifecycle', path: 'complete', ...result }));
});
