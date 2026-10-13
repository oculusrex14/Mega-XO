'use strict';
// Vercel Serverless Function entrypoint for the Mega XO V5 stateless API control plane.
//
// The project's root directory is `apps/api`, so Vercel collects every file under `api/` as a
// function. This file resolves to `apps/api/api/index.js` and simply re-exports the control plane
// implemented in `apps/api/index.js`. It must live here (not at the repo root) for the checked-in
// `apps/api/vercel.json` `rewrites`/`functions` contract to resolve; re-exporting keeps the
// single implementation in `apps/api/index.js` (and its own `__dirname`-relative requires) intact.
module.exports = require('../index.js');
