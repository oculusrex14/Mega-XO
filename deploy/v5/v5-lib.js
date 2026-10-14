'use strict';
/**
 * Absolute-path loader for the deployed P15 library so the V5 production
 * runners in <root>/bin can require the checked-in contracts without walking
 * out of their own directory. V5_LIB_ROOT relocates the library (tests);
 * production leaves it unset.
 */
const path = require('node:path');
const ROOT = process.env.V5_LIB_ROOT || '/opt/mega-xo-v5-production/lib';
const P15 = path.join(ROOT, 'scripts/v5/p15');
module.exports = {
  root: ROOT,
  p15: P15,
  contract: () => require(path.join(P15, 'r2-contract.js')),
  manifest: () => require(path.join(P15, 'archive-manifest.js')),
  sealed: () => require(path.join(P15, 'sealed-archive.js')),
  target: () => require(path.join(P15, 'direct-target.js'))
};
