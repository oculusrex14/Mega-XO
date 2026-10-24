'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {Client}=require('pg');
const lab=require('./v5-pg-lab.js');
const {unchanged}=require('../deploy/v5/v5-change-check.js');
lab.installCleanup(test);

test('database-local backup clock covers actual writes, late commits, DDL, sequences and missing guards',async t=>{
  if(!await lab.boot(t))return;
  const database=await lab.createDatabase('backup_clock');
  const admin=new Client({connectionString:lab.dbUrl(database)});
  const writer=new Client({connectionString:lab.dbUrl(database)});
  const other=new Client({connectionString:lab.dbUrl(database)});
  const reader=new Client({connectionString:lab.dbUrl(database)});
  await Promise.all([admin.connect(),writer.connect(),other.connect(),reader.connect()]);
  // Production's P15 dump deliberately excludes the private learning schema.
  const probe=async()=> (await reader.query('SELECT ops.backup_change_probe(true) AS token')).rows[0].token;
  const baseline=token=>({format:'mega-v5-backup-watermark/v2',target:'fixture',backupId:'v5-p15-fixture',token});
  const same=(before,after)=>unchanged(baseline(before),{token:after},'fixture');
  try{
    await admin.query('CREATE TABLE ops.backup_clock_fixture(id integer PRIMARY KEY,value integer NOT NULL)');
    await reader.query('SET ROLE backup_reader');
    const initial=await probe();
    assert.equal(initial.covered,true);
    assert.equal(initial.revisions.length,64);
    // Read-only maintenance and zero-row DML must not create self-induced change.
    await admin.query('UPDATE ops.backup_clock_fixture SET value=2 WHERE false');
    assert.equal(same(initial,await probe()),true);
    await admin.query('INSERT INTO ops.backup_clock_fixture VALUES(1,0)');
    assert.equal(same(initial,await probe()),false);
    const beforeLate=await probe();
    await writer.query('BEGIN');
    await writer.query('UPDATE ops.backup_clock_fixture SET value=1 WHERE id=1');
    assert.equal(same(beforeLate,await probe()),true,'in-progress change is invisible just as to pg_dump');
    await other.query('INSERT INTO ops.backup_clock_fixture VALUES(2,1)');
    const dumpWatermark=await probe();
    await writer.query('COMMIT');
    assert.equal(same(dumpWatermark,await probe()),false,'late older transaction must force next backup');
    const beforeAbort=await probe();
    await writer.query('BEGIN');
    await writer.query('UPDATE ops.backup_clock_fixture SET value=5');
    await writer.query('ROLLBACK');
    assert.equal(same(beforeAbort,await probe()),true);
    await admin.query('TRUNCATE ops.backup_clock_fixture');
    assert.equal(same(beforeAbort,await probe()),false);
    const beforeDdl=await probe();
    await admin.query('ALTER TABLE ops.backup_clock_fixture ADD COLUMN extra text');
    assert.equal(same(beforeDdl,await probe()),false);
    await admin.query('CREATE SEQUENCE ops.backup_clock_sequence');
    await admin.query('GRANT SELECT ON SEQUENCE ops.backup_clock_sequence TO backup_reader');
    const beforeSeq=await probe();
    await admin.query("SELECT setval('ops.backup_clock_sequence',25,false)");
    assert.equal(same(beforeSeq,await probe()),false,'uncalled last_value cannot be hidden as NULL');
    const seq25=await probe();
    await admin.query("SELECT nextval('ops.backup_clock_sequence')");
    assert.equal(same(seq25,await probe()),false,'is_called changes even when last_value stays 25');
    // Disabling the guard must fail open to a dump even if an administrator
    // disables DDL events and bypasses the clock (runtime roles cannot do this).
    await admin.query('ALTER EVENT TRIGGER mega_backup_ddl DISABLE');
    await admin.query('ALTER TABLE ops.backup_clock_fixture DISABLE TRIGGER backup_change_row');
    const uncovered=await probe();
    assert.equal(uncovered.covered,false);
    assert.equal(same(uncovered,uncovered),false);
    await admin.query('ALTER EVENT TRIGGER mega_backup_ddl ENABLE ALWAYS');
    await admin.query('SELECT ops.backup_enroll_tables()');
    assert.equal((await probe()).covered,true);
    await reader.query('RESET ROLE');
    await reader.query('SET ROLE api_runtime');
    await assert.rejects(reader.query('UPDATE ops.backup_change_clock SET revision=0'),/permission denied/);
    await assert.rejects(reader.query('SELECT ops.backup_enroll_tables()'),/permission denied/);
  }finally{await Promise.allSettled([admin.end(),writer.end(),other.end(),reader.end()]);}
});
