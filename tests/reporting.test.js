'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {DurableStore}=require('../server/economy-store');
const {CommunityStore}=require('../server/community-store');
const {migrate}=require('../server/production/migrations');
const {OperatorService}=require('../server/production/operator-service');

function add(c,store,name){
 const a=store.read(),id='u_'+crypto.randomUUID();a.addAccount(id,{verified:true,createdAt:Date.now()});c.ensureProfile(id,a);const row=c.profileRow(id);a.account(id).coins=100;a.account(id).crowns=10;c.write(a);return {id,row};
}
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-report-')),store=new DurableStore(path.join(dir,'db.sqlite')),c=new CommunityStore({store,origin:'https://game.test'});migrate(store.db);
 const reporter=add(c,store,'reporter'),target=add(c,store,'target'),ops=new OperatorService({store,community:c},{secret:'e'.repeat(64)});
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {store,c,reporter,target,ops};
}
test('player reporting is categorized, rate limited, duplicate suppressed and cannot target self',t=>{
 const f=fixture(t);
 const first=f.c.report(f.reporter.id,f.target.id,'cheating','Suspicious repeated impossible moves');
 assert.equal(first.reported,true);assert.equal(first.duplicate,false);
 const again=f.c.report(f.reporter.id,f.target.id,'cheating','Same concern');
 assert.equal(again.duplicate,true);assert.equal(again.id,first.id);
 assert.throws(()=>f.c.report(f.reporter.id,f.reporter.id,'cheating','self'),/CANNOT_REPORT_SELF/);
 assert.throws(()=>f.c.report(f.reporter.id,f.target.id,'invalid','context'),/INVALID_REPORT_CATEGORY/);
 assert.throws(()=>f.c.report(f.reporter.id,f.target.id,'other','short'),/REPORT_DETAIL_REQUIRED/);
});
test('operator can review and resolve reports without automatic punishment or wallet mutation',t=>{
 const f=fixture(t),before=structuredClone(f.c.read().account(f.target.id));
 const report=f.c.report(f.reporter.id,f.target.id,'username','Profile name appears to impersonate support');
 const queue=f.ops.command({action:'report-list',state:'open',limit:10});
 assert.equal(queue.length,1);assert.equal(queue[0].id,report.id);assert.equal(queue[0].target.actor,f.target.id);
 const resolved=f.ops.command({action:'report-resolve',query:report.id,outcome:'no_action',operator:'mod.one',reason:'Reviewed profile and found no policy violation'});
 assert.equal(resolved.state,'reviewed');assert.equal(resolved.outcome,'no_action');
 const after=f.c.read().account(f.target.id);
 assert.equal(after.coins,before.coins);assert.equal(after.crowns,before.crowns);assert.equal(after.rating,before.rating);assert.equal(!!after.suspended,!!before.suspended);assert.equal(!!after.hold,!!before.hold);
 assert.equal(f.ops.command({action:'report-list',state:'open',limit:10}).length,0);
 assert.equal(f.ops.command({action:'report-list',state:'reviewed',limit:10}).length,1);
 assert.throws(()=>f.ops.command({action:'report-resolve',query:report.id,outcome:'action_taken',operator:'mod.one',reason:'Second review must not overwrite history'}),/REPORT_ALREADY_REVIEWED/);
 assert.equal(f.ops.verifyAudit().count,1);
});
test('report detail is bounded and stored without executable markup',t=>{
 const f=fixture(t);
 assert.throws(()=>f.c.report(f.reporter.id,f.target.id,'harassment','<script>alert(1)</script>'),/INVALID_REPORT_DETAIL/);
 assert.throws(()=>f.c.report(f.reporter.id,f.target.id,'harassment','x'.repeat(281)),/INVALID_REPORT_DETAIL/);
 const result=f.c.report(f.reporter.id,f.target.id,'harassment','Repeated unwanted friend requests after being removed');
 const row=f.store.db.prepare('SELECT detail,state FROM v41_reports WHERE id=?').get(result.id);assert.equal(row.state,'open');assert.equal(row.detail,'Repeated unwanted friend requests after being removed');
});
