'use strict';
/* R06 - deployed public-leaderboard correctness + privacy acceptance (uncached path).
 *
 * The signed Core ingress reads `economy.ratings` directly (no read cache), so this exercises the
 * authoritative DEPLOYED Core projection on the real staging Neon:
 *   - rating/wealth metric selection + independent projections
 *   - games>=10 gate for rating; stats_visibility='public' gate; wealth_public opt-in for wealth
 *   - region (scope=local) + league (tier) filters; invalid filter rejection
 *   - 64-bit-exact wealth decimal string
 *   - Core-unavailable -> the transport fails (the API maps this to an honest 503, never empty 200)
 *
 * Seeds directly with api_runtime/core_runtime (as the staging smoke does) and cleans up its own rows.
 * Usage on host: node r06-core-leaderboard.cjs
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const ROOT = '/opt/mega-xo-v51-staging/repo';
const SECRETS = '/opt/mega-xo-v51-staging/secrets';
const { createPgPool } = require(ROOT + '/packages/db/pg/pool.js');
const { createCoreGateway } = require(ROOT + '/packages/services/core-gateway.js');
const ca = fs.readFileSync(SECRETS + '/ca.pem', 'utf8');
const rr = JSON.parse(fs.readFileSync(SECRETS + '/runtime-roles.json', 'utf8'));
const gatewaySecret = fs.readFileSync(SECRETS + '/core-gateway.secret', 'utf8').trim();
const budget = { totalConnections: 32, roleConnections: { api_runtime: 16, core_runtime: 8, worker_runtime: 4, migration_owner: 2 } };

const mk = (role, max = 3) => createPgPool({
  host: rr.host, port: 5432, database: rr.database, user: role, password: rr.roles[role].password, role,
  label: 'staging', service: 'r06-core', revision: 'r06', ssl: { ca, rejectUnauthorized: true },
  sslRootCertPath: SECRETS + '/ca.pem', channel_binding: 'require', targetFile: ROOT + '/docs/v5/environments/staging.json',
  budget, pool: { max, idleTimeoutMillis: 5000, connectionTimeoutMillis: 15000 },
});

const RUN = Date.now().toString(36).slice(-6);
const tagFor = (a) => 'MEGA-' + crypto.createHash('sha256').update(a).digest('hex').slice(0, 10).toUpperCase();
const ACTORS = {
  A: { vis: 'public', region: 'IN', rating: '1600.25', games: 12, tier: 'silver', wealthPublic: false, coins: 500 },
  B: { vis: 'friends', region: 'IN', rating: '1900.00', games: 20, tier: 'gold', wealthPublic: true, coins: 1000000 },
  C: { vis: 'public', region: 'US', rating: '1700.00', games: 10, tier: 'gold', wealthPublic: true, coins: 9007199254740991 },
  D: { vis: 'public', region: 'IN', rating: '1550.00', games: 5, tier: 'silver', wealthPublic: false, coins: 999 },
};
for (const k of Object.keys(ACTORS)) ACTORS[k].id = `r06_${RUN}_${k.toLowerCase()}`;

(async () => {
  const api = mk('api_runtime');
  const core = mk('core_runtime');
  const gw = createCoreGateway({ coreUrl: 'http://127.0.0.1:8085', secret: gatewaySecret });
  const results = [];
  const check = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(54)} ${detail || ''}`); };
  const ids = (r) => r.map((x) => x.id);

  try {
    const past = new Date(Date.now() - 86400000).toISOString();
    for (const a of Object.values(ACTORS)) {
      await api.query('INSERT INTO identity.actors (actor_id, region, wealth_public, created_at) VALUES ($1,$2,$3,$4)', [a.id, JSON.stringify(a.region), a.wealthPublic, past]);
      await api.query('INSERT INTO identity.eligibility (actor_id, verified, suspended, security_hold) VALUES ($1,true,false,false)', [a.id]);
      await api.query('INSERT INTO identity.session_generations (actor_id, generation, updated_at) VALUES ($1,1,$2)', [a.id, new Date()]);
      await api.query('INSERT INTO identity.profiles (actor_id, tag, username, display_name, created_at, stats_visibility) VALUES ($1,$2,$3,$4,$5,$6)',
        [a.id, tagFor(a.id), `u_${RUN}_${a.id.slice(-1)}`, `R06 ${a.vis} ${a.region}`, past, a.vis]);
      await core.query('INSERT INTO economy.wallets (actor_id, coins, crowns) VALUES ($1,$2,0)', [a.id, a.coins]);
      await core.query('INSERT INTO economy.ratings (actor_id, rating, peak, casual_rating, games, tier) VALUES ($1,$2,$2,$2,$3,$4)', [a.id, a.rating, a.games, a.tier]);
    }
    console.log(`seeded ${Object.keys(ACTORS).length} actors (run ${RUN})`);

    const g = await gw.leaderboard({ metric: 'rating', scope: 'global' });
    const gIds = ids(g);
    check('rating: public games>=10 appear (A,C)', gIds.includes(ACTORS.A.id) && gIds.includes(ACTORS.C.id));
    check('rating: friends hidden (B absent)', !gIds.includes(ACTORS.B.id));
    check('rating: games<10 hidden (D absent)', !gIds.includes(ACTORS.D.id));
    check('rating: DESC order (C 1700 before A 1600.25)', gIds.indexOf(ACTORS.C.id) < gIds.indexOf(ACTORS.A.id));
    const aRow = g.find((x) => x.id === ACTORS.A.id);
    check('rating: hundredths preserved (1600.25)', aRow && aRow.rating === 1600.25, `rating=${aRow && aRow.rating}`);
    check('rating: wealth field absent', aRow && aRow.wealth === undefined);

    const l = await gw.leaderboard({ metric: 'rating', scope: 'local', region: 'IN' });
    check('rating local IN: only A (B friends, C US, D games<10)', ids(l).length === 1 && ids(l)[0] === ACTORS.A.id, JSON.stringify(ids(l)));

    const lg = await gw.leaderboard({ metric: 'rating', league: 'gold' });
    check('rating league=gold: C in, A/D(silver)/B(friends) out',
      ids(lg).includes(ACTORS.C.id) && !ids(lg).includes(ACTORS.A.id) && !ids(lg).includes(ACTORS.D.id) && !ids(lg).includes(ACTORS.B.id),
      `C=${ids(lg).includes(ACTORS.C.id)} A=${ids(lg).includes(ACTORS.A.id)}`);

    const w = await gw.leaderboard({ metric: 'wealth' });
    check('wealth: wealth_public only (C in)', ids(w).includes(ACTORS.C.id));
    check('wealth: opt-out hidden (A absent)', !ids(w).includes(ACTORS.A.id));
    check('wealth: friends hidden (B absent)', !ids(w).includes(ACTORS.B.id));
    const cW = w.find((x) => x.id === ACTORS.C.id);
    check('wealth: 64-bit exact decimal string', cW && cW.wealth === '9007199254740991', `wealth=${cW && cW.wealth}`);

    const bad = createCoreGateway({ coreUrl: 'http://127.0.0.1:8085', secret: gatewaySecret });
    let rejected = false;
    try { await bad.leaderboard({ metric: 'bogus' }); } catch { rejected = true; }
    check('invalid metric rejected by Core', rejected);

    // Core-unavailable: a dead endpoint must FAIL (never a silent empty board).
    const dead = createCoreGateway({ coreUrl: 'http://127.0.0.1:9', secret: gatewaySecret, timeoutMs: 1500 });
    let failed = false;
    try { await dead.leaderboard({ metric: 'rating' }); } catch { failed = true; }
    check('Core unavailable -> transport fails (API maps to 503)', failed);
  } finally {
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
        targetFile: ROOT + '/docs/v5/environments/staging.json', budget, pool: { max: 2 },
      });
      await mig.query('DELETE FROM identity.actors WHERE actor_id = ANY($1)', [del]);
      console.log('cleaned up seeded actors');
    } catch (e) { console.error('cleanup warning:', e.message); }
    process.exit(results.every((r) => r.pass) ? 0 : 1);
  }
})().catch((e) => { console.error('HARNESS_ERROR', e.message); process.exit(2); });
