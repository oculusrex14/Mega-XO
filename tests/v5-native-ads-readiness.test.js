'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const { resolveCommerceAdsConfig, bindAdMobVerifier } = require('../scripts/v51/v5-production-server.cjs');
const code = (expected) => (error) => error && error.code === expected;

const policy = {
  MEGA_ACCOUNT_DELETION_ENABLED: 'true',
  MEGA_PRIVACY_POLICY_VERSION: 'privacy-2026-10',
  MEGA_RETENTION_POLICY_VERSION: 'retention-2026-10',
  MEGA_AD_CONSENT_VERSION: 'ump-2026-10',
};
const rewardedUnit = 'ca-app-pub-1234567890123456/1234567890';
const interstitialUnit = 'ca-app-pub-1234567890123456/0987654321';

test('V5 AdMob config defaults off and rejects invalid modes, units, or unapproved policy state', () => {
  assert.deepEqual(resolveCommerceAdsConfig({}).mode, 'off');
  assert.throws(() => resolveCommerceAdsConfig({ MEGA_AD_MODE: 'enabled' }), code('INVALID_AD_MODE'));
  assert.throws(() => resolveCommerceAdsConfig({ ADMOB_ANDROID_REWARDED_UNIT: 'test-unit' }), code('INVALID_ADMOB_UNIT'));
  assert.throws(() => resolveCommerceAdsConfig({
    ...policy, MEGA_AD_MODE: 'rewarded', MEGA_ACCOUNT_DELETION_ENABLED: 'false',
    ADMOB_ANDROID_REWARDED_UNIT: rewardedUnit,
  }), code('ADS_REQUIRE_PRIVACY_RELEASE'));
  assert.throws(() => resolveCommerceAdsConfig({
    ...policy, MEGA_AD_MODE: 'rewarded', MEGA_AD_CONSENT_VERSION: '',
    ADMOB_ANDROID_REWARDED_UNIT: rewardedUnit,
  }), code('ADS_REQUIRE_CONSENT_RELEASE'));
  assert.throws(() => resolveCommerceAdsConfig({
    ...policy, MEGA_AD_MODE: 'rewarded',
  }), code('ADMOB_ANDROID_REWARDED_UNIT_REQUIRED'));
  assert.throws(() => resolveCommerceAdsConfig({
    ...policy, MEGA_AD_MODE: 'hybrid', ADMOB_ANDROID_REWARDED_UNIT: rewardedUnit,
  }), code('INCOMPLETE_ADMOB_UNITS'));
});

test('rewarded/hybrid configuration preserves exact platform units and binds verified SSV suffixes', async () => {
  const rewarded = resolveCommerceAdsConfig({
    ...policy, MEGA_AD_MODE: 'rewarded', ADMOB_ANDROID_REWARDED_UNIT: rewardedUnit,
  });
  assert.equal(rewarded.adUnits.android.rewarded, rewardedUnit);
  const hybrid = resolveCommerceAdsConfig({
    ...policy, MEGA_AD_MODE: 'hybrid', ADMOB_ANDROID_REWARDED_UNIT: rewardedUnit,
    ADMOB_ANDROID_INTERSTITIAL_UNIT: interstitialUnit,
  });
  const verify = bindAdMobVerifier(async () => ({ actor: 'actor', adUnit: '1234567890' }), hybrid);
  assert.equal((await verify('signed-provider-query')).adUnit, rewardedUnit);
  const wrongUnit = bindAdMobVerifier(async () => ({ adUnit: '1111111111' }), hybrid);
  await assert.rejects(wrongUnit('signed-provider-query'), code('UNCONFIGURED_ADMOB_UNIT'));
  assert.throws(() => resolveCommerceAdsConfig({
    ...policy, MEGA_AD_MODE: 'hybrid', ADMOB_ANDROID_REWARDED_UNIT: rewardedUnit,
    ADMOB_ANDROID_INTERSTITIAL_UNIT: interstitialUnit,
    ADMOB_IOS_REWARDED_UNIT: 'ca-app-pub-9999999999999999/1234567890',
  }), code('AMBIGUOUS_ADMOB_UNIT_BINDING'));
});

test('native consent privacy control remains reachable after denial; preparation owns consent gating', () => {
  const bridge = fs.readFileSync(path.join(root, 'native/android/app/src/main/java/online/megaxo/prototype/MegaAdsBridge.kt'), 'utf8');
  const privacy = bridge.slice(bridge.indexOf('private fun privacyOptions'), bridge.indexOf('private fun showRewarded'));
  assert.match(privacy, /ads\.privacyOptions/);
  assert.doesNotMatch(privacy, /canRequestAds\(\)/);
  const gradle = fs.readFileSync(path.join(root, 'native/android/app/build.gradle.kts'), 'utf8');
  assert.match(gradle, /megaAdMobRewardedUnit must belong to the megaAdMobAppId publisher/);
  assert.match(gradle, /megaAdMobInterstitialUnit must belong to the megaAdMobAppId publisher/);
  const ui = fs.readFileSync(path.join(root, 'src/monetization-ui.js'), 'utf8');
  assert.match(ui, /function directApkDistribution\(\)/);
  assert.match(ui, /function websiteStoreLink\(/);
  const prepare = ui.split('\n').find((line) => line.includes("action==='prepare'")) || '';
  assert.match(prepare, /window\.MegaAds\.prepare\('rewarded'\)/);
  assert.doesNotMatch(prepare, /privacyOptions/);
});
