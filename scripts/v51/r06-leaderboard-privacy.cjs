'use strict';
/* R06 - deployed public-leaderboard correctness + privacy acceptance.
 *
 * Seeds controlled actors directly into the real staging Neon (identity via api_runtime, economy via
 * core_runtime - the same roles the staging smoke uses), then asserts the PUBLIC Vercel API's
 * /api/v1/leaderboard through the live Vercel -> core.megaxo.online -> Core path:
 *   - rating/wealth metric selection and independent projections
 *   - games>=10 gate for rating
 *   - stats_visibility='public' gate (friends/private never appear)
 *   - wealth_public opt-in gate for wealth
 *   - region (scope=local) + league (tier) filters
 *   - invalid filter rejection (400)
 *   - 64-bit-exact wealth as a decimal string (no float precision loss)
 *
 * Usage on host: node r06-leaderboard-privacy.cjs <vercel-preview-url>
 * Secrets are read from the staging secret dir and never printed.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const ROOT = '/opt/mega-xo-v51-staging/repo';
const SECRETS = '/opt/mega-xo-v51-staging/secrets';
const { createPgPool } = require(ROOT + '/packages/db/pg/pool.js');
const ca = fs.readFileSync(SECRETS + '/ca.pem', 'utf8');
const rr = JSON.parse(fs.readFileSync(SECRETS + '/runtime-roles.json', 'utf8'));
const budget = { totalConnections: 32, roleConnections: { api_runtime: 16, core_runtime: 8, worker_runtime: 4, migration_owner: 2 } };
const BASE = process.argv[2];
if (!BASE || !/^https:\/\/[a-z0-9.-]+\.vercel\.app$/.test(BASE)) throw new Error('VERCEL_PREVIEW_URL_REQUIRED');

const mk = (role) => createPgPool({
  host: rr.host, port: 5432, database: rr.database, user: role, password: rr.roles[role].password, role,
  label: 'staging', service: 'r06-leaderboard', revision: 'r06', ssl: { ca, rejectUnauthorized: true },
  sslRootCertPath: SECRETS + '/ca.pem', channel_binding: 'require', targetFile: ROOT + '/docs/v5/environments/staging.json',
  budget, pool: { max: 3, idleTimeoutMillis: 5000, connectionTimeoutMillis: 15000 },
});

const RUN = Date.now().toString(36).slice(-6);
const tagFor = (a) => 'MEGA-' + crypto.createHash('sha256').update(a).digest('hex').slice(0, 10).toUpperCase();
// Controlled matrix. rating board requires games>=10 and stats_visibility='public'.
const ACTORS = {
  A: { id: `r06_${RUN}_a`, vis: 'public', region: 'IN', rating: '1600.25', games: 12, tier: 'silver', wealthPublic: false, coins: 500, crowns: 5 },
  B: { id: `r06_${RUN}_b`, vis: 'friends', region: 'IN', rating: '1900.00', games: 20, tier: 'gold', wealthPublic: true, coins: 1000000, crowns: 0 },
  C: { id: `r06_${RUN}_c`, vis: 'public', region: 'US', rating: '1700.00', games: 10, tier: 'gold', wealthPublic: true, coins: 9007199254740991, crowns: 0 },
  D: { id: `r06_${RUN}_d`, vis: 'public', region: 'IN', rating: '1550.00', games: 5, tier: 'silver', wealthPublic: false, coins: 999, crowns: 0 },
};

async function seed(api, core) {
  const past = new Date(Date.now() - 86400000).toISOString();
  for (const a of Object.values(ACTORS)) {
    await api.query('INSERT INTO identity.actors (actor_id, region, wealth_public, created_at) VALUES ($1,$2,$3,$4)', [a.id, JSON.stringify(a.region), a.wealthPublic, past]);
    await api.query('INSERT INTO identity.eligibility (actor_id, verified, suspended, security_hold) VALUES ($1,true,false,false)', [a.id]);
    await api.query('INSERT INTO identity.session_generations (actor_id, generation, updated_at) VALUES ($1,1,$2)', [a.id, new Date()]);
    await api.query('INSERT INTO identity.profiles (actor_id, tag, username, display_name, created_at, stats_visibility) VALUES ($1,$2,$3,$4,$5,$6)',
      [a.id, tagFor(a.id), `u_${RUN}_${a.id.slice(-1)}`, `R06 ${a.vis} ${a.region}`, past, a.vis]);
    await core.query('INSERT INTO economy.wallets (actor_id, coins, crowns) VALUES ($1,$2,$3)', [a.id, a.coins, a.crowns]);
    await core.query('INSERT INTO economy.ratings (actor_id, rating, peak, casual_rating, games, tier) VALUES ($1,$2,$2,$2,$3,$4)', [a.id, a.rating, a.games, a.tier]);
  }
}

const ids = (r) => r.map((x) => x.id);
async function board(q) {
  const res = await fetch(`${BASE}/api/v1/leaderboard${q}`, { headers: { Origin: 'https://megaxo.online' } });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

(async () => {
  const api = mk('api_runtime');
  const core = mk('core_runtime');
  const results = [];
  const check = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} ${detail || ''}`); };

  try {
    await seed(api, core);
    console.log(`seeded ${Object.keys(ACTORS).length} actors (run ${RUN})`);

    const g = await board('?metric=rating&scope=global');
    const gIds = ids(g.body);
    check('rating: global 200', g.status === 200, `status=${g.status}`);
    check('rating: public games>=10 appear (A,C)', gIds.includes(ACTORS.A.id) && gIds.includes(ACTORS.C.id));
    check('rating: friends hidden (B absent)', !gIds.includes(ACTORS.B.id));
    check('rating: games<10 hidden (D absent)', !gIds.includes(ACTORS.D.id));
    const cIdx = gIds.indexOf(ACTORS.C.id), aIdx = gIds.indexOf(ACTORS.A.id);
    check('rating: DESC order (C 1700 before A 1600.25)', cIdx !== -1 && aIdx !== -1 && cIdx < aIdx);
    const aRow = g.body.find((x) => x.id === ACTORS.A.id);
    check('rating: hundredths preserved (1600.25)', aRow && aRow.rating === 1600.25, `rating=${aRow && aRow.rating}`);
    check('rating: wealth field absent', aRow && aRow.wealth === undefined);

    const l = await board('?metric=rating&scope=local&region=IN');
    const lIds = ids(l.body);
    check('rating local IN: only A (B friends, C US, D games<10)', lIds.length === 1 && lIds[0] === ACTORS.A.id, JSON.stringify(lIds));

    const lg = await board('?metric=rating&league=gold');
    const lgIds = ids(lg.body);
    check('rating league=gold: includes C, excludes A/D (silver) and B (friends)',
      lgIds.includes(ACTORS.C.id) && !lgIds.includes(ACTORS.A.id) && !lgIds.includes(ACTORS.D.id) && !lgIds.includes(ACTORS.B.id),
      `C=${lgIds.includes(ACTORS.C.id)} A=${lgIds.includes(ACTORS.A.id)} D=${lgIds.includes(ACTORS.D.id)} B=${lgIds.includes(ACTORS.B.id)}`);

    const w = await board('?metric=wealth');
    const wIds = ids(w.body);
    check('wealth: public+wealth_public only (C)', wIds.includes(ACTORS.C.id));
    check('wealth: wealth_public=false hidden (A absent)', !wIds.includes(ACTORS.A.id));
    check('wealth: friends hidden (B absent despite wealth_public)', !wIds.includes(ACTORS.B.id));
    const cW = w.body.find((x) => x.id === ACTORS.C.id);
    check('wealth: 64-bit exact decimal string', cW && cW.wealth === '9007199254740991', `wealth=${cW && cW.wealth}`);

    const wl = await board('?metric=wealth&scope=local&region=IN');
    check('wealth local IN: empty (B friends, A not opt-in)', wl.status === 200 && ids(wl.body).length === 0, `status=${wl.status} rows=${ids(wl.body).length}`);

    const bad = await board('?metric=bogus');
    check('invalid metric rejected 400', bad.status === 400 && bad.body.error === 'INVALID_LEADERBOARD_QUERY', `status=${bad.status}`);
    const badRegion = await board('?metric=rating&scope=local&region=in');
    check('invalid region (lowercase) rejected 400', badRegion.status === 400, `status=${badRegion.status}`);
    const localNoRegion = await board('?metric=rating&scope=local');
    check('scope=local w/o region -> honest empty 200', localNoRegion.status === 200 && ids(localNoRegion.body).length === 0, `status=${localNoRegion.status}`);
  } finally {
    // Clean up only the actors this run created (never other rows). identity/profile deletes need
    // the migration role; economy rows are removable by core_runtime.
    try {
      const del = Object.values(ACTORS).map((a) => a.id);
      await core.query('DELETE FROM economy.wallets WHERE actor_id = ANY($1)', [del]);
      await core.query('DELETE FROM economy.ratings WHERE actor_id = ANY($1)', [del]);
      const creds = JSON.parse(fs.readFileSync(SECRETS + '/credentials.json', 'utf8'));
      const mu = new URL(creds.migration_url);
      const mig = createPgPool({
        host: mu.hostname, port: Number(mu.port || 5432), database: mu.pathname.slice(1), user: mu.username,
        password: decodeURIComponent(mu.password), role: 'migration_owner', label: 'staging', service: 'r06-cleanup',
        revision: 'r06', ssl: { ca, rejectUnauthorized: true }, sslRootCertPath: SECRETS + '/ca.pem',
        targetFile: ROOT + '/docs/v5/environments/staging.json', budget,
        pool: { max: 2, idleTimeoutMillis: 5000, connectionTimeoutMillis: 15000 },
      });
      await mig.query('DELETE FROM identity.actors WHERE actor_id = ANY($1)', [del]);
      console.log('cleaned up seeded actors');
    } catch (e) { console.error('cleanup warning:', e.message); }
    process.exit(results.every((r) => r.pass) ? 0 : 1);
  }
})().catch((e) => { console.error('HARNESS_ERROR', e.message); process.exit(2); });
