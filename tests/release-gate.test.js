'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {gate,parseLedger,REQUIRED}=require('../scripts/release-gate');

function fixture(t,status='COMPLETE'){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mega-release-gate-'));
 fs.mkdirSync(path.join(root,'docs'));
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({version:'4.0.0'}));
 const rows=REQUIRED.map(id=>`| ${id} | area | ${status} | blocker | evidence |`).join('\n');
 fs.writeFileSync(path.join(root,'docs','V4-OPEN-BLOCKERS.md'),rows+'\n');
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return root;
}
test('release gate accepts only matching V4 tag with all mandatory blockers complete',t=>{
 const root=fixture(t);
 const out=gate({tag:'v4.0.0',sha:'a'.repeat(40),root});
 assert.equal(out.approved,true);assert.equal(out.version,'4.0.0');assert.deepEqual(out.mandatoryBlockers,REQUIRED);
});
test('release gate refuses open blockers',t=>{
 const root=fixture(t);
 let text=fs.readFileSync(path.join(root,'docs','V4-OPEN-BLOCKERS.md'),'utf8');
 text=text.replace('| EXT-08 | area | COMPLETE |','| EXT-08 | area | BLOCKED |');
 fs.writeFileSync(path.join(root,'docs','V4-OPEN-BLOCKERS.md'),text);
 assert.throws(()=>gate({tag:'v4.0.0',sha:'b'.repeat(40),root}),/RELEASE_BLOCKERS_OPEN:EXT-08:BLOCKED/);
});
test('release gate refuses tag/package mismatch or missing evidence row',t=>{
 const root=fixture(t);
 assert.throws(()=>gate({tag:'v4.0.1',sha:'c'.repeat(40),root}),/RELEASE_TAG_MUST_MATCH_PACKAGE_VERSION/);
 const file=path.join(root,'docs','V4-OPEN-BLOCKERS.md');
 fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace(/^\| EXT-09 .*\n/m,''));
 assert.throws(()=>gate({tag:'v4.0.0',sha:'c'.repeat(40),root}),/RELEASE_GATE_ROWS_MISSING:EXT-09/);
});
test('blocker ledger parser ignores non-ledger markdown',()=>{
 const rows=parseLedger('# note\n| ID | Area | Status | Blocker | Evidence |\n| EXT-01 | VPS | COMPLETE | none | checked |\n');
 assert.equal(rows.get('EXT-01').status,'COMPLETE');assert.equal(rows.size,1);
});
