#!/usr/bin/env node
'use strict';

/* MXA-PRICE-NOTICE (2026-10-19): the owner's published term is that a price change is
 * announced by email BEFORE it takes effect. This operator script makes that real:
 *
 *   node scripts/v5/price-change-notice.cjs --notice-id 2026-11-19 --effective 2026-11-19T02:29:59+05:30 \
 *        --subject 'Mega XOXO prices change on 19 November' --body-file notice.txt
 *   (add --confirm <notice-id> to actually send; without it the script is a dry run)
 *
 * Read-only against the production database (verified email identities only); sends via the
 * Resend transport like the OTP mail, rate-limited, with a per-notice sent ledger so a rerun
 * never double-sends. The sent ledger lives next to the Dodo evidence (0600). Never prints
 * addresses or secrets; the summary counts only. */
const fs = require('node:fs');
const path = require('node:path');

function arg(name) { const i = process.argv.indexOf('--' + name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null; }
const NOTICE_ID = arg('notice-id');
const EFFECTIVE = arg('effective') || '';
const SUBJECT = arg('subject') || null;
const BODY_FILE = arg('body-file');
const CONFIRM = arg('confirm');
const PRIVATE_DIR = process.env.DODO_PRIVATE_DIR || '/Users/oculus/Downloads/Mega-XO-private-evidence/dodo';
const DB_URL_FILE = process.env.PRICE_NOTICE_DB_URL_FILE || '/Users/oculus/Downloads/Mega-XO-private-evidence/v5-neon-production/credentials.json';
if (!NOTICE_ID || !process.argv.includes('--notice-id')) { process.stderr.write('usage: --notice-id <id> [--effective <iso>] [--subject <s>] [--body-file <f>] [--confirm <notice-id>]\n'); process.exitCode = 1; process.exit(process.exitCode); }
const creds = JSON.parse(fs.readFileSync(DB_URL_FILE, 'utf8'));
const { Client } = require('pg');
const { TransactionalEmail } = require(path.resolve(__dirname, '../../server/email-provider.js'));

(async () => {
  const client = new Client({ connectionString: creds.migration_url, ssl: { rejectUnauthorized: true }, application_name: 'price-change-notice' });
  await client.connect();
  const r = await client.query("SELECT DISTINCT lower(subject) AS email FROM identity.identities WHERE provider = 'email' ORDER BY 1");
  await client.end();
  const emails = r.rows.map(row => String(row.email)).filter(email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  const ledgerPath = path.join(PRIVATE_DIR, 'price-notice-' + NOTICE_ID + '.sent.jsonl');
  const sent = new Set();
  if (fs.existsSync(ledgerPath)) for (const line of fs.readFileSync(ledgerPath, 'utf8').split('\n')) { try { sent.add(JSON.parse(line).email); } catch {} }
  const pending = emails.filter(email => !sent.has(email));
  process.stdout.write('notice=' + NOTICE_ID + ' recipients=' + emails.length + ' already_sent=' + sent.size + ' pending=' + pending.length + ' mode=' + (CONFIRM === NOTICE_ID ? 'SEND' : 'DRY-RUN') + '\n');
  if (CONFIRM !== NOTICE_ID) { process.stdout.write('dry run: no emails sent. Re-run with --confirm ' + NOTICE_ID + ' to send.\n'); return; }
  const apiKey = fs.readFileSync(path.join(PRIVATE_DIR, 'api.key'), 'utf8').trim();
  const email = new TransactionalEmail({ apiKey });
  if (!email.enabled()) throw Error('EMAIL_DELIVERY_NOT_CONFIGURED');
  const bodyText = BODY_FILE ? fs.readFileSync(BODY_FILE, 'utf8') : null;
  let ok = 0, failed = 0;
  for (const address of pending) {
   try {
    await email.sendPriceChangeNotice({ to: address, noticeId: NOTICE_ID, subject: SUBJECT || undefined, bodyText });
    fs.appendFileSync(ledgerPath, JSON.stringify({ email: address, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
    ok++;
   } catch (error) { failed++; process.stderr.write('FAILED ' + error.message + ' (index ' + ok + ' of ' + pending.length + ')\n'); }
   await new Promise(resolve => setTimeout(resolve, 700)); /* stay well inside the provider budget */
  }
  process.stdout.write('sent=' + ok + ' failed=' + failed + '\n');
  if (failed) process.exitCode = 1;
})().catch(error => { process.stderr.write(String(error && error.message || error) + '\n'); process.exitCode = 1; });

