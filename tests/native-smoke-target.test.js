'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {targetFromBadging}=require('../scripts/v5/native-smoke-target.cjs');
test('native smoke launches the artifact application id with its distinct Kotlin activity namespace',()=>{
  const target=targetFromBadging("package: name='online.megaxo.xoxo' versionCode='1'\nlaunchable-activity: name='online.megaxo.prototype.MegaXOActivity' label='Mega XOXO' icon=''\n");
  assert.deepEqual(target,{id:'online.megaxo.xoxo',activity:'online.megaxo.prototype.MegaXOActivity',component:'online.megaxo.xoxo/online.megaxo.prototype.MegaXOActivity'});
});
test('native smoke resolves relative activities and keeps staging identities from the actual APK',()=>{
  assert.equal(targetFromBadging("package: name='online.megaxo.xoxo.staging'\nlaunchable-activity: name='.MegaXOActivity'\n").component,'online.megaxo.xoxo.staging/online.megaxo.xoxo.staging.MegaXOActivity');
});
test('missing or invalid metadata cannot fall back to a guessed launch target',()=>{
  for(const value of ['',"package: name='online.megaxo.xoxo'\n", "package: name='bad id'\nlaunchable-activity: name='.Main'", "package: name='online.megaxo.xoxo'\nlaunchable-activity: name='Main;bad'"]){assert.throws(()=>targetFromBadging(value),/APK_(PACKAGE_ID|LAUNCH_ACTIVITY)_INVALID/);}
});
