'use strict';
// Read the built APK's identity instead of assuming its application id equals its Kotlin namespace.
function targetFromBadging(badging) {
  const id = /^package: name='([^']+)'/m.exec(badging)?.[1];
  const name = /^launchable-activity: name='([^']+)'/m.exec(badging)?.[1];
  if (!id || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(id)) throw Error('APK_PACKAGE_ID_INVALID');
  if (!name || !/^\.?[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(name)) throw Error('APK_LAUNCH_ACTIVITY_INVALID');
  const activity = name.startsWith('.') ? id + name : name.includes('.') ? name : id + '.' + name;
  return { id, activity, component: id + '/' + activity };
}
module.exports = { targetFromBadging };
if (require.main === module) {
  try {
    const target = targetFromBadging(require('node:fs').readFileSync(0, 'utf8'));
    process.stdout.write(target.id + ' ' + target.component + '\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
