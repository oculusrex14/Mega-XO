'use strict';
// Runs in the existing audit workflow's v51-audit-* glob, on owned disposable PG16 only.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const lab = require('./v5-pg-lab.js');
const { createCommerceService } = require('../packages/services/commerce.js');
const { createCoreService } = require('../packages/services/core.js');
const { createPromotionOperatorService } = require('../packages/services/promotion-operator.js');
const { createPromotionAuditDelivery } = require('../packages/services/promotion-audit.js');
const { createCommerceIngressService } = require('../packages/services/commerce-ingress.js');
const { hash, VERSION } = require('../packages/services/promotion-allocation.js');
const { readPromotionMetrics } = require('../packages/services/promotion-metrics.js');
const DAY = 86400000, START = Date.parse('2026-11-01T12:00:00Z');
lab.installCleanup(test);

test('promotion enforcement: real Core transactions, all providers, due process and audit delivery', async t => {
 if (!await lab.boot(t)) return;
 const db = await lab.createDatabase('promotion_enforcement');
 await lab.seedActors(db);
 const admin = await lab.adminClient(db);
 t.after(() => admin.end());
 await admin.query('UPDATE monetization.promotion_policies SET effective_at = $1 WHERE policy_version = $2', [new Date(START - DAY).toISOString(), VERSION]);
 const pool = lab.poolsFor(db).core;
 let clock = START, calls = 0;
 const verifies = new Map();
 const products = ['crowns_100','crowns_525','crowns_1100','remove_ads','mega_pass'];
 const priceId = crypto.randomUUID();
 const fakeCreate = async (provider, input) => {
  calls++;
  const id = provider === 'dodo' ? 'cks_' + crypto.randomBytes(12).toString('hex') : provider === 'polar' ? crypto.randomUUID() : 'mxo_' + crypto.randomBytes(12).toString('hex');
  verifies.set(provider === 'cashfree' ? input.orderId : id, { status: provider === 'cashfree' ? 'PAID' : 'succeeded', currency: provider === 'cashfree' ? 'INR' : 'usd', amount: provider === 'cashfree' ? Number(input.amount) : 499, metadata: { actor: input.actor, product_id: input.storeProductId || input.productId } });
  return provider === 'cashfree' ? { orderId: input.orderId, paymentSessionId: 'session_' + id }
   : { checkoutId: id, checkoutUrl: 'https://checkout.example.test/' + id };
 };
 const commerce = await createCommerceService(pool, {
  now: () => clock, purchasesEnabled: true, eligible: () => true, verifyPromotionAcceptance: async () => true,
  dodoProvider: { createCheckout: input => fakeCreate('dodo',input), verifyCheckout: async id => verifies.get(id), isProductId: v => v.startsWith('pdt_'), isSessionId: v => v.startsWith('cks_'), supportedCurrency: v => ['usd','inr'].includes(v) ? v : null },
  dodoCatalog: Object.fromEntries(products.map(id => [id,{productId:'pdt_' + id,prices:{usd:499,inr:25000}}])),
  dodoSuccessUrl: 'https://megaxo.online',
  polarProvider: { createCheckout: input => fakeCreate('polar',input), verifyCheckout: async id => verifies.get(id) },
  polarCatalog: Object.fromEntries(products.map(id => [id,{priceId,amountCents:499}])), polarSuccessUrl: 'https://megaxo.online',
  cashfreeProvider: { createOrder: input => fakeCreate('cashfree',input), verifyOrder: async id => verifies.get(id), newOrderId: () => 'cfmx' + crypto.randomBytes(12).toString('hex'), isOrderId: () => true },
  cashfreeCatalog: Object.fromEntries(products.map(id => [id,'250.00'])), cashfreeReturnUrl: 'https://megaxo.online',
 });
 const core = await createCoreService(pool, { now: () => clock });
 const operators = await createPromotionOperatorService(pool, { now: () => clock, authorize: async p => ['operator:one','operator:two'].includes(p.actor) });
 t.after(() => { commerce.close(); core.close(); operators.close(); });
 const first = {scope:'operator',actor:'operator:one'}, second = {scope:'operator',actor:'operator:two'};
 const wallet = async actor => (await admin.query('SELECT coins,crowns,purchased_coins,purchased_crowns,reserved_coins,reserved_crowns FROM economy.wallets WHERE actor_id = $1',[actor])).rows[0];
 const create = (provider, key, pack='crowns_1100') => provider === 'dodo'
  ? commerce.createDodoCheckout('svc_alice',key,pack,{email:'synthetic@example.test'})
  : provider === 'polar' ? commerce.createPolarCheckout('svc_alice',key,pack,{})
   : commerce.createCashfreeOrder('svc_alice',key,pack,{email:'synthetic@example.test',phone:'9999999999'});

 await t.test('reserve across native and all web providers; race cannot take payment beyond cap', async () => {
  for (let i=0;i<19;i++) await commerce.reservePromotionCheckout('svc_alice','native-'+i,'crowns_1100',i%2?'apple':'google');
  const attempts = await Promise.allSettled(['dodo','polar','cashfree'].map((p,i)=>create(p,'race-'+i)));
  assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1,attempts.filter(r=>r.status==='rejected').map(r=>r.reason.message).join(', '));
  assert.equal(calls,1,'only one provider may create a payable checkout');
  for (const r of attempts.filter(r=>r.status==='rejected')) assert.match(r.reason.message,/PROMOTION_ALLOCATION_CAP/);
  assert.equal((await commerce.status('svc_alice')).promotionAllocation.remaining,0);
  for (const pack of ['crowns_100','crowns_525','crowns_1100']) {
   for (const provider of ['dodo','polar','cashfree']) await assert.rejects(create(provider,'blocked-'+provider+'-'+pack,pack),/PROMOTION_ALLOCATION_CAP/);
   for (const provider of ['apple','google']) await assert.rejects(commerce.reservePromotionCheckout('svc_alice','blocked-'+provider+'-'+pack,pack,provider),/PROMOTION_ALLOCATION_CAP/);
  }
  assert.equal(calls,1);
 });
 await t.test('spend, convert and actual provider refund do not replenish allocation', async () => {
  const row = (await admin.query('SELECT provider,provider_object_id FROM monetization.commerce_create_requests WHERE actor_id=$1 AND state=$2',['svc_alice','READY'])).rows[0];
  const bobBefore = await wallet('svc_bob');
  if(row.provider==='dodo') await commerce.dodoOrderStatus('svc_alice',row.provider_object_id);
  else if(row.provider==='polar') await commerce.polarOrderStatus('svc_alice',row.provider_object_id);
  else await commerce.cashfreeOrderStatus('svc_alice',row.provider_object_id);
  assert.equal((await wallet('svc_alice')).purchased_crowns,'1100');
  await core.run({actor:'svc_alice',scope:'player'},'spend-convert',{type:'convert',from:'crowns',amount:10});
  await commerce.powerSpend('svc_alice','power','hint');
  if(row.provider==='dodo') await commerce.refundDodoOrder(row.provider_object_id);
  else if(row.provider==='polar') await commerce.refundPolarOrder(row.provider_object_id);
  else await commerce.refundCashfreeOrder(row.provider_object_id);
  assert.equal((await admin.query('SELECT sum(crowns) AS n FROM monetization.promotion_allocations WHERE actor_id=$1',['svc_alice'])).rows[0].n,'22000');
  assert.deepEqual(await wallet('svc_bob'),bobBefore);
  await assert.rejects(commerce.reservePromotionCheckout('svc_alice','after-all-effects','crowns_100','apple'),/PROMOTION_ALLOCATION_CAP/);
  assert.equal(calls,1);
 });
 let order, acceptance, lot, packet, command;
 await t.test('published policy requires verified disclosure/acceptance before provider I/O', async () => {
  const policyHash = 'a'.repeat(64);
  await admin.query('UPDATE monetization.promotion_policies SET published_at=$1,rule_hash=$2 WHERE policy_version=$3',[new Date(START-DAY).toISOString(),policyHash,VERSION]);
  await assert.rejects(commerce.createDodoCheckout('svc_bob','missing-accept','crowns_1100',{}),/PROMOTION_ACCEPTANCE_REQUIRED/);
  acceptance = await commerce.acceptPromotionPolicy('svc_bob',{policyVersion:VERSION,ruleHash:policyHash,remaining:22000,disclosureReceipt:'signed-test-disclosure'});
  order = await commerce.createDodoCheckout('svc_bob','accepted-order','crowns_1100',{promotionAcceptanceHash:acceptance.acceptanceHash});
  assert.equal((await commerce.dodoOrderStatus('svc_bob',order.checkoutId)).paid,true);
  assert.equal((await wallet('svc_bob')).purchased_crowns,'1100');
  await commerce.dodoOrderStatus('svc_bob',order.checkoutId);
  assert.equal((await wallet('svc_bob')).purchased_crowns,'1100','settlement replay never adds provenance twice');
  lot = (await admin.query('SELECT * FROM monetization.promotion_lots WHERE actor_id=$1',['svc_bob'])).rows[0];
  assert.ok(lot);
 });
 await t.test('power ledger source is admitted by the real migrated database', async () => {
  await admin.query("INSERT INTO economy.ledger (entry_id,actor_id,currency,amount,reason,source,at) VALUES ('power:source-probe','svc_carol','crowns',-2,'Synthetic coverage probe','power',$1)",[new Date(clock).toISOString()]);
 });
 await t.test('private metrics SQL runs read-only and retains exact queries and frozen rows', async () => {
  const report=await readPromotionMetrics(pool,{actor:'svc_bob',launchStart:new Date(START-DAY).toISOString(),launchEnd:new Date(clock).toISOString(),now:clock,sourceSha:'c'.repeat(40)});
  assert.equal(report.signals.qualifyingCrowns,1100);
  assert.equal(report.signals.S3.enabled,false);
  assert.equal(report.signals.automaticRestriction,false);
  assert.equal(report.evidence.queries.length,4);
  assert.equal(report.evidence.frozenRows.purchases.length,1);
 });
 await t.test('private command requires case evidence, elapsed notice and actual second approval', async () => {
  clock += 11*DAY;
  packet = {
   transactions:[{grantId:lot.grant_id,allocationId:lot.allocation_id,providerOrderRef:order.checkoutId,verifiedPrice:{amount:499,currency:'usd'},priceVerificationHash:'b'.repeat(64)}],response:null,
   evidence:{policyHash:'a'.repeat(64),acceptanceHash:acceptance.acceptanceHash,sourceSha:'c'.repeat(40),sql:'SELECT * FROM frozen synthetic evidence WHERE actor_id=$1',params:['svc_bob'],snapshotAt:new Date(START).toISOString(),frozenRows:[{grantId:lot.grant_id,crowns:1100}],provenance:'verified synthetic order and matching grant'},
   notice:{rule:VERSION,transactions:order.checkoutId,figures:'Proposed 100 Crowns',appealRoute:'/appeals',inAccountReceipt:'delivered-in-account',emailReceipt:'delivered-email',deliveredAt:new Date(START).toISOString()},
   decision:{finding:'proven_breach',basis:'independent-evidence',reason:'Synthetic proven breach of accepted rule',reference:'decision:one',reviewer:first.actor,secondReviewer:second.actor,decidedAt:new Date(clock).toISOString(),appealUntil:new Date(clock+30*DAY).toISOString(),amounts:[{grantId:lot.grant_id,crowns:100,coins:0}]},
  };
  command={caseId:'case-one',targetActor:'svc_bob',approvedAmounts:packet.decision.amounts,policyVersion:VERSION,reasonCode:'proven-promotion-breach',evidenceHash:hash(packet),decisionReference:packet.decision.reference};
  await assert.rejects(operators.recordCase({scope:'player',actor:'svc_bob'},{...command,packet}),/OPERATOR_REQUIRED/);
  await operators.recordCase(first,{...command,packet});
  await assert.rejects(operators.confiscatePromotionBenefits(first,command),/SECOND_REVIEWER_REQUIRED/);
  await operators.approveForfeiture(second,command);
  const ingress=createCommerceIngressService({commerce});
  await assert.rejects(ingress.command({op:'confiscate_promotion_benefits',actor:'svc_bob'}),/INVALID_COMMERCE_OP/);
 });
 await t.test('concurrent operator retries debit once, preserve opponent, and commit journal/outbox/outcome', async () => {
  const opponent = await wallet('svc_alice');
  const results=await Promise.all([operators.confiscatePromotionBenefits(first,command),operators.confiscatePromotionBenefits(second,command)]);
  assert.deepEqual(results[0],results[1]);
  const after=await wallet('svc_bob');
  assert.equal(after.crowns,'1100'); assert.equal(after.purchased_crowns,'1000');
  assert.deepEqual(await wallet('svc_alice'),opponent);
  assert.equal(await lab.scalar(db,"SELECT count(*) FROM economy.ledger WHERE entry_id='confiscation:case-one:crowns'"),'1');
  assert.equal(await lab.scalar(db,"SELECT count(*) FROM ops.outbox WHERE outbox_id='promotion.audit:confiscation:case-one'"),'1');
  await assert.rejects(operators.confiscatePromotionBenefits(first,{...command,reasonCode:'changed'}),/IDEMPOTENCY_CONFLICT/);
  assert.equal(await lab.scalar(db,'SELECT refunded_at FROM monetization.dodo_orders WHERE checkout_id=$1',[order.checkoutId]),null);
 });
 await t.test('over-recovery and injected journal failure roll back the entire transaction', async () => {
  const before = await wallet('svc_bob');
  for (const [id,amount] of [['too-much',5000],['rollback',50]]) {
   const p=structuredClone(packet);p.decision.amounts[0].crowns=amount;
   const cmd={...command,caseId:id,approvedAmounts:p.decision.amounts,evidenceHash:hash(p)};
   await operators.recordCase(first,{...cmd,packet:p});await operators.approveForfeiture(second,cmd);
   if(id==='rollback') await admin.query("CREATE FUNCTION economy.promotion_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entry_id='confiscation:rollback:crowns' THEN RAISE EXCEPTION 'synthetic-journal-failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER promotion_test_fail BEFORE INSERT ON economy.ledger FOR EACH ROW EXECUTE FUNCTION economy.promotion_test_fail()");
   await assert.rejects(operators.confiscatePromotionBenefits(first,cmd),id==='too-much'?/BENEFITS_NOT_HELD/:/synthetic-journal-failure/);
   assert.deepEqual(await wallet('svc_bob'),before);
   assert.equal(await lab.scalar(db,'SELECT count(*) FROM monetization.promotion_events WHERE case_id=$1',[id]),'0');
  }
 });
 await t.test('audit uses its separate role, serializes concurrent appends and is replay safe', async () => {
  await admin.query('ALTER ROLE audit_runtime LOGIN');
  const { createPgPool }=require('../packages/db/pg/pool.js');
  const u=new URL(lab.dbUrl(db));
  const auditPool=createPgPool({host:u.hostname,port:Number(u.port),database:db,user:'audit_runtime',role:'audit_runtime',label:'test',service:'promotion-audit-test',revision:'promotion',allowLocalNoTls:true,pool:{max:2},budget:lab.BUDGET});
  t.after(()=>auditPool.end());
  const audit=createPromotionAuditDelivery(auditPool,{secret:'synthetic-audit-secret-for-test-only',now:()=>clock});
  const results=await Promise.all([audit.deliver({eventId:'confiscation:case-one'}),audit.deliver({eventId:'confiscation:case-one'})]);
  assert.deepEqual(results[0],results[1]);
  assert.equal(await lab.scalar(db,'SELECT count(*) FROM audit.operator_audit'),'1');
  await assert.rejects(pool.query('SELECT * FROM audit.operator_audit'),/permission denied/);
 });
 await t.test('successful appeals restore through compensating entries without renewing allocation', async () => {
  const cmd={caseId:'case-one',appealReference:'appeal-upheld:one',appealEvidenceHash:'d'.repeat(64),reviewer:first.actor,secondReviewer:second.actor,reason:'Synthetic successful appeal'};
  await operators.restorePromotionBenefits(first,cmd);await operators.restorePromotionBenefits(second,cmd);
  assert.equal((await wallet('svc_bob')).crowns,'1200');
  assert.equal((await wallet('svc_bob')).purchased_crowns,'1100');
  assert.equal(await lab.scalar(db,"SELECT count(*) FROM economy.ledger WHERE entry_id='compensation:case-one:crowns'"),'1');
  assert.equal((await commerce.status('svc_bob')).promotionAllocation.remaining,20900);
 });
});
