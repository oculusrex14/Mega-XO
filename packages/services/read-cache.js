'use strict';

/**
 * packages/services/read-cache.js - V5 Phase 12 (Read Models and Cache)
 *
 * Implements:
 * - V5-12-01: Read classification, sensitivity labeling, and explicit Cache-Control headers
 * - V5-12-02: Versioned projections and indexes on measured query paths
 * - V5-12-03: Bounded cache invalidation engine on mutation events
 * - V5-12-04: Read-load reduction measurement and telemetry
 *
 * Invariant (Gate G12):
 * Cache/projection loss affects speed, not correctness; private state is never shared-cached
 * or used stale for economic authorization; PostgreSQL remains the sole durable authority.
 */

const crypto = require('node:crypto');

/* ==========================================================================
 * 1. Read Categories and Sensitivities (V5-12-01)
 * ========================================================================== */

const CATEGORIES = Object.freeze({
  PRIVATE_NO_CACHE: 'PRIVATE_NO_CACHE',
  SHORT_TTL_EPHEMERAL: 'SHORT_TTL_EPHEMERAL',
  PUBLIC_PROJECTED: 'PUBLIC_PROJECTED',
});

const SENSITIVITIES = Object.freeze({
  PRIVATE_ECONOMIC_WALLET: 'PRIVATE_ECONOMIC_WALLET',
  PRIVATE_ECONOMIC_CAS: 'PRIVATE_ECONOMIC_CAS',
  PRIVATE_SENSITIVE_GDPR: 'PRIVATE_SENSITIVE_GDPR',
  PRIVATE_AUTHENTICATED: 'PRIVATE_AUTHENTICATED',
  PRIVATE_SOCIAL_GRAPH: 'PRIVATE_SOCIAL_GRAPH',
  EPHEMERAL_STATE: 'EPHEMERAL_STATE',
  PUBLIC_PROJECTED_RECORD: 'PUBLIC_PROJECTED_RECORD',
  PUBLIC_PROJECTED_AGGREGATE: 'PUBLIC_PROJECTED_AGGREGATE',
  PUBLIC_SEARCH: 'PUBLIC_SEARCH',
  PUBLIC_STATIC: 'PUBLIC_STATIC',
});

const CACHE_CONTROL_POLICIES = Object.freeze({
  PRIVATE_NO_STORE: 'private, no-store',
  EPHEMERAL_SHORT: 'private, no-cache, max-age=2',
  PUBLIC_PROJECTED_MEDIUM: 'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
  PUBLIC_LEADERBOARD: 'public, max-age=30, s-maxage=120, stale-while-revalidate=300',
  PUBLIC_SEARCH: 'public, max-age=5, s-maxage=10, stale-while-revalidate=15',
  PUBLIC_STATIC_LONG: 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
});

/* ==========================================================================
 * 2. Route Manifest (V5-12-01)
 * ========================================================================== */

const ROUTE_MANIFEST = Object.freeze([
  {
    path: '/api/account/profile',
    pattern: /^\/api\/account\/profile$/,
    category: CATEGORIES.PRIVATE_NO_CACHE,
    cacheControl: CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE,
    defaultTtlMs: 0,
    staleToleranceMs: 0,
    sensitivity: SENSITIVITIES.PRIVATE_AUTHENTICATED,
    sharedCacheAllowed: false,
    invalidationEvents: ['profile.updated'],
    description: 'Caller account profile settings, tags and identifiers',
  },
  {
    path: '/api/account/save',
    pattern: /^\/api\/account\/save$/,
    category: CATEGORIES.PRIVATE_NO_CACHE,
    cacheControl: CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE,
    defaultTtlMs: 0,
    staleToleranceMs: 0,
    sensitivity: SENSITIVITIES.PRIVATE_ECONOMIC_CAS,
    sharedCacheAllowed: false,
    invalidationEvents: ['save.updated'],
    description: 'Monotonic CAS cloud practice save state',
  },
  {
    path: '/api/account/export',
    pattern: /^\/api\/account\/export$/,
    category: CATEGORIES.PRIVATE_NO_CACHE,
    cacheControl: CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE,
    defaultTtlMs: 0,
    staleToleranceMs: 0,
    sensitivity: SENSITIVITIES.PRIVATE_SENSITIVE_GDPR,
    sharedCacheAllowed: false,
    invalidationEvents: [],
    description: 'Full account data export (wallets, identities, saves, journal)',
  },
  {
    path: '/api/account/deletion',
    pattern: /^\/api\/account\/deletion$/,
    category: CATEGORIES.PRIVATE_NO_CACHE,
    cacheControl: CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE,
    defaultTtlMs: 0,
    staleToleranceMs: 0,
    sensitivity: SENSITIVITIES.PRIVATE_AUTHENTICATED,
    sharedCacheAllowed: false,
    invalidationEvents: ['account.deleted'],
    description: 'Account deletion policy status and request availability',
  },
  {
    path: '/api/v1/profile',
    pattern: /^\/api\/v1\/profile$/,
    category: CATEGORIES.PRIVATE_NO_CACHE,
    cacheControl: CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE,
    defaultTtlMs: 0,
    staleToleranceMs: 0,
    sensitivity: SENSITIVITIES.PRIVATE_ECONOMIC_WALLET,
    sharedCacheAllowed: false,
    invalidationEvents: ['match.completed', 'profile.updated', 'friend.updated'],
    description: 'Legacy self profile containing wallet balances, coins, crowns, journal',
  },
  {
    path: '/api/v1/invitations',
    pattern: /^\/api\/v1\/invitations$/,
    category: CATEGORIES.PRIVATE_NO_CACHE,
    cacheControl: CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE,
    defaultTtlMs: 0,
    staleToleranceMs: 0,
    sensitivity: SENSITIVITIES.PRIVATE_AUTHENTICATED,
    sharedCacheAllowed: false,
    invalidationEvents: ['invitation.created', 'invitation.accepted', 'invitation.declined'],
    description: 'Pending match invitations for caller',
  },
  {
    path: '/api/v1/queue',
    pattern: /^\/api\/v1\/queue$/,
    category: CATEGORIES.SHORT_TTL_EPHEMERAL,
    cacheControl: CACHE_CONTROL_POLICIES.EPHEMERAL_SHORT,
    defaultTtlMs: 2000,
    staleToleranceMs: 2000,
    sensitivity: SENSITIVITIES.EPHEMERAL_STATE,
    sharedCacheAllowed: false,
    invalidationEvents: ['queue.cancelled', 'match.created'],
    description: 'Matchmaking search queue ticket status',
  },
  {
    path: '/api/v1/match/:id',
    pattern: /^\/api\/v1\/match\/[^\/]+$/,
    category: CATEGORIES.PUBLIC_PROJECTED, // Default when completed; dynamic for live/private
    cacheControl: CACHE_CONTROL_POLICIES.PUBLIC_PROJECTED_MEDIUM,
    defaultTtlMs: 300000,
    staleToleranceMs: 600000,
    sensitivity: SENSITIVITIES.PUBLIC_PROJECTED_RECORD,
    sharedCacheAllowed: true,
    invalidationEvents: ['match.move', 'match.completed'],
    description: 'Match state and move history view',
  },
  {
    path: '/api/v1/leaderboard',
    pattern: /^\/api\/v1\/leaderboard$/,
    category: CATEGORIES.PUBLIC_PROJECTED,
    cacheControl: CACHE_CONTROL_POLICIES.PUBLIC_LEADERBOARD,
    defaultTtlMs: 60000,
    staleToleranceMs: 300000,
    sensitivity: SENSITIVITIES.PUBLIC_PROJECTED_AGGREGATE,
    sharedCacheAllowed: true,
    invalidationEvents: ['match.completed', 'leaderboard.refreshed'],
    description: 'Public ranked and wealth leaderboard rankings',
  },
  {
    path: '/api/community/profile/:id',
    pattern: /^\/api\/community\/profile\/[^\/]+$/,
    category: CATEGORIES.PUBLIC_PROJECTED,
    cacheControl: CACHE_CONTROL_POLICIES.PUBLIC_PROJECTED_MEDIUM,
    defaultTtlMs: 60000,
    staleToleranceMs: 120000,
    sensitivity: SENSITIVITIES.PUBLIC_PROJECTED_RECORD,
    sharedCacheAllowed: true,
    invalidationEvents: ['profile.updated', 'match.completed'],
    description: 'Public player profile lookup with privacy controls',
  },
  {
    path: '/api/community/friends',
    pattern: /^\/api\/community\/friends$/,
    category: CATEGORIES.PRIVATE_NO_CACHE,
    cacheControl: CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE,
    defaultTtlMs: 0,
    staleToleranceMs: 0,
    sensitivity: SENSITIVITIES.PRIVATE_SOCIAL_GRAPH,
    sharedCacheAllowed: false,
    invalidationEvents: ['friend.updated'],
    description: 'Caller accepted friend list',
  },
  {
    path: '/api/community/search',
    pattern: /^\/api\/community\/search$/,
    category: CATEGORIES.SHORT_TTL_EPHEMERAL,
    cacheControl: CACHE_CONTROL_POLICIES.PUBLIC_SEARCH,
    defaultTtlMs: 5000,
    staleToleranceMs: 15000,
    sensitivity: SENSITIVITIES.PUBLIC_SEARCH,
    sharedCacheAllowed: true,
    invalidationEvents: ['profile.updated'],
    description: 'Player search by tag or username prefix',
  },
  {
    path: '/.well-known/assetlinks.json',
    pattern: /^\/\.well-known\/assetlinks\.json$/,
    category: CATEGORIES.PUBLIC_PROJECTED,
    cacheControl: CACHE_CONTROL_POLICIES.PUBLIC_STATIC_LONG,
    defaultTtlMs: 300000,
    staleToleranceMs: 86400000,
    sensitivity: SENSITIVITIES.PUBLIC_STATIC,
    sharedCacheAllowed: true,
    invalidationEvents: [],
    description: 'Android digital asset links statement list',
  },
  {
    path: '/.well-known/apple-app-site-association',
    pattern: /^\/\.well-known\/apple-app-site-association$/,
    category: CATEGORIES.PUBLIC_PROJECTED,
    cacheControl: CACHE_CONTROL_POLICIES.PUBLIC_STATIC_LONG,
    defaultTtlMs: 300000,
    staleToleranceMs: 86400000,
    sensitivity: SENSITIVITIES.PUBLIC_STATIC,
    sharedCacheAllowed: true,
    invalidationEvents: [],
    description: 'iOS universal links association specification',
  },
  {
    path: '/privacy',
    pattern: /^\/(privacy|terms|rules|security)$/,
    category: CATEGORIES.PUBLIC_PROJECTED,
    cacheControl: CACHE_CONTROL_POLICIES.PUBLIC_STATIC_LONG,
    defaultTtlMs: 300000,
    staleToleranceMs: 86400000,
    sensitivity: SENSITIVITIES.PUBLIC_STATIC,
    sharedCacheAllowed: true,
    invalidationEvents: [],
    description: 'Static legal compliance and terms documentation',
  },
  {
    path: '/health',
    pattern: /^\/(health|livez|readyz)$/,
    category: CATEGORIES.SHORT_TTL_EPHEMERAL,
    cacheControl: CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE,
    defaultTtlMs: 1000,
    staleToleranceMs: 1000,
    sensitivity: SENSITIVITIES.EPHEMERAL_STATE,
    sharedCacheAllowed: false,
    invalidationEvents: [],
    description: 'Service health readiness and liveness probes',
  },
]);

/**
 * Classifies an incoming request route and determines its cache parameters.
 * Dynamic options refine parameterized routes like /api/v1/match/:id or /api/community/profile/:id.
 *
 * @param {string} pathname Request path without query params
 * @param {Object} [options] Dynamic context: { matchStatus, isSelf, visibility, isPrivateMatch }
 * @returns {Object} Manifest entry with effective category, cacheControl, ttl, etc.
 */
function classifyRoute(pathname, options = {}) {
  const cleanPath = (typeof pathname === 'string' ? pathname.split('?')[0].replace(/\/+$/, '') || '/' : '/');

  // Match /api/v1/match/:id
  if (cleanPath.startsWith('/api/v1/match/')) {
    const isCompleted = options.matchStatus === 'COMPLETED' || options.matchStatus === 'CANCELLED' || options.matchStatus === 'RESIGNED' || options.matchStatus === 'TIMEOUT';
    const isLive = options.matchStatus === 'PLAYING' || options.matchStatus === 'OFFERED';
    const isPrivate = Boolean(options.isPrivateMatch);

    if (isPrivate) {
      return {
        path: '/api/v1/match/:id',
        category: CATEGORIES.PRIVATE_NO_CACHE,
        cacheControl: CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE,
        defaultTtlMs: 0,
        staleToleranceMs: 0,
        sensitivity: SENSITIVITIES.PRIVATE_AUTHENTICATED,
        sharedCacheAllowed: false,
        invalidationEvents: ['match.move', 'match.completed'],
        description: 'Private unlisted match view',
      };
    }

    if (isLive) {
      return {
        path: '/api/v1/match/:id',
        category: CATEGORIES.SHORT_TTL_EPHEMERAL,
        cacheControl: CACHE_CONTROL_POLICIES.EPHEMERAL_SHORT,
        defaultTtlMs: 2000,
        staleToleranceMs: 2000,
        sensitivity: SENSITIVITIES.EPHEMERAL_STATE,
        sharedCacheAllowed: false,
        invalidationEvents: ['match.move', 'match.completed'],
        description: 'Live active match status',
      };
    }

    return {
      path: '/api/v1/match/:id',
      category: CATEGORIES.PUBLIC_PROJECTED,
      cacheControl: CACHE_CONTROL_POLICIES.PUBLIC_PROJECTED_MEDIUM,
      defaultTtlMs: 300000,
      staleToleranceMs: 600000,
      sensitivity: SENSITIVITIES.PUBLIC_PROJECTED_RECORD,
      sharedCacheAllowed: true,
      invalidationEvents: ['match.completed'],
      description: 'Completed historical match view',
    };
  }

  // Match /api/community/profile/:id
  if (cleanPath.startsWith('/api/community/profile/')) {
    const isSelf = Boolean(options.isSelf);
    const visibility = options.visibility || 'public';

    if (isSelf || visibility === 'private') {
      return {
        path: '/api/community/profile/:id',
        category: CATEGORIES.PRIVATE_NO_CACHE,
        cacheControl: CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE,
        defaultTtlMs: 0,
        staleToleranceMs: 0,
        sensitivity: SENSITIVITIES.PRIVATE_AUTHENTICATED,
        sharedCacheAllowed: false,
        invalidationEvents: ['profile.updated'],
        description: 'Private or self profile lookup',
      };
    }

    return {
      path: '/api/community/profile/:id',
      category: CATEGORIES.PUBLIC_PROJECTED,
      cacheControl: CACHE_CONTROL_POLICIES.PUBLIC_PROJECTED_MEDIUM,
      defaultTtlMs: 60000,
      staleToleranceMs: 120000,
      sensitivity: SENSITIVITIES.PUBLIC_PROJECTED_RECORD,
      sharedCacheAllowed: true,
      invalidationEvents: ['profile.updated', 'match.completed'],
      description: 'Public player profile lookup',
    };
  }

  // Find exact or pattern match from manifest
  for (const entry of ROUTE_MANIFEST) {
    if (entry.path === cleanPath || entry.pattern.test(cleanPath)) {
      return { ...entry };
    }
  }

  // Safe conservative default for unrecognized routes
  return {
    path: cleanPath,
    category: CATEGORIES.PRIVATE_NO_CACHE,
    cacheControl: CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE,
    defaultTtlMs: 0,
    staleToleranceMs: 0,
    sensitivity: SENSITIVITIES.PRIVATE_AUTHENTICATED,
    sharedCacheAllowed: false,
    invalidationEvents: [],
    description: 'Unclassified default private route',
  };
}

/* ==========================================================================
 * 3. Versioned Projections (V5-12-02)
 * ========================================================================== */

/**
 * Immutable wrapper for versioned projection snapshots.
 * Guarantees monotonic versioning: stale events cannot overwrite newer versions.
 */
class VersionedProjection {
  constructor(version, data, updatedAt = Date.now()) {
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new TypeError(`Projection version must be a positive integer, got ${version}`);
    }
    this.version = version;
    this.data = data;
    this.updatedAt = updatedAt;
    Object.freeze(this);
  }

  toJSON() {
    return {
      version: this.version,
      data: this.data,
      updatedAt: this.updatedAt,
    };
  }
}

function createVersionedProjection(version, data, updatedAt = Date.now()) {
  return new VersionedProjection(version, data, updatedAt);
}

/**
 * Checks whether an incoming projection update is valid under monotonic versioning.
 * @param {Object|null} current Existing projection or null
 * @param {Object} incoming Incoming projection
 * @returns {boolean} True if incoming is strictly newer
 */
function canUpdateProjection(current, incoming) {
  if (!current || typeof current.version !== 'number') return true;
  if (!incoming || typeof incoming.version !== 'number') return false;
  return incoming.version > current.version;
}

/* ==========================================================================
 * 4. Bounded Read Cache & Invalidation Engine (V5-12-03)
 * ========================================================================== */

class ReadCache {
  constructor(options = {}) {
    this.maxEntries = Number.isSafeInteger(options.maxEntries) && options.maxEntries > 0
      ? options.maxEntries
      : 5000;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.backend = options.backend || null; // Optional Redis / ephemera adapter
    this.store = new Map(); // key -> CacheEntry
    this.tagMap = new Map(); // tag -> Set<key>

    // Telemetry and load reduction counters (V5-12-04)
    this.statsCounters = {
      hits: 0,
      misses: 0,
      sets: 0,
      invalidations: 0,
      staleRejections: 0,
      evictions: 0,
    };
  }

  /**
   * Retrieves an item from cache.
   * Supports stale-while-revalidate when within staleToleranceMs.
   */
  get(key, options = {}) {
    const entry = this.store.get(key);
    if (!entry) {
      this.statsCounters.misses++;
      return null;
    }

    const now = this.now();
    if (now > entry.staleUntil) {
      this.delete(key);
      this.statsCounters.misses++;
      return null;
    }
    const isExpired = now > entry.expiresAt;
    const isStaleAllowed = Boolean(options.allowStale);
    if (isExpired && !isStaleAllowed) {
      this.statsCounters.misses++;
      return null;
    }

    this.statsCounters.hits++;
    return entry.value;
  }

  /**
   * Stores an entry with bounded invalidation and monotonic version check.
   *
   * Invariant: PRIVATE_NO_CACHE state is NEVER stored with shared: true.
   *
   * @param {string} key Cache key
   * @param {any} value Data or VersionedProjection
   * @param {Object} [options] Caching parameters
   * @returns {Object} { set: boolean, version: number, reason?: string }
   */
  set(key, value, options = {}) {
    // 1. Guard against shared caching of private state
    const category = options.category || (value?.category) || null;
    if (category === CATEGORIES.PRIVATE_NO_CACHE && options.shared === true) {
      throw new Error('PRIVATE_STATE_SHARED_CACHE_FORBIDDEN: Private state cannot be stored in shared cache');
    }

    // 2. Monotonic version validation
    const incomingVersion = (typeof options.version === 'number')
      ? options.version
      : (value instanceof VersionedProjection || (value && typeof value === 'object' && typeof value.version === 'number'))
        ? value.version
        : null;

    const existing = this.store.get(key);
    if (existing && incomingVersion !== null) {
      if (existing.version !== null && existing.version >= incomingVersion) {
        this.statsCounters.staleRejections++;
        return {
          set: false,
          reason: 'STALE_VERSION',
          currentVersion: existing.version,
          incomingVersion,
        };
      }
    }

    // 3. Evict oldest entry if capacity exceeded
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey) {
        this.delete(oldestKey);
        this.statsCounters.evictions++;
      }
    }

    // 4. Calculate expirations
    const now = this.now();
    const ttlMs = Number.isSafeInteger(options.ttlMs) && options.ttlMs > 0
      ? options.ttlMs
      : 60000;
    const staleToleranceMs = Number.isSafeInteger(options.staleToleranceMs)
      ? options.staleToleranceMs
      : ttlMs * 2;

    const expiresAt = now + ttlMs;
    const staleUntil = now + Math.max(ttlMs, staleToleranceMs);

    const tags = new Set(Array.isArray(options.tags) ? options.tags : []);
    if (options.tag) tags.add(options.tag);

    const entry = {
      key,
      value,
      version: incomingVersion,
      category,
      expiresAt,
      staleUntil,
      updatedAt: now,
      tags,
    };

    this.store.set(key, entry);

    // Register tag mappings
    for (const tag of tags) {
      let set = this.tagMap.get(tag);
      if (!set) {
        set = new Set();
        this.tagMap.set(tag, set);
      }
      set.add(key);
    }

    this.statsCounters.sets++;
    return {
      set: true,
      version: incomingVersion,
      expiresAt,
    };
  }

  has(key) {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (this.now() > entry.expiresAt) {
      this.delete(key);
      return false;
    }
    return true;
  }

  delete(key) {
    const entry = this.store.get(key);
    if (!entry) return false;

    // Clean up tag mappings
    for (const tag of entry.tags) {
      const set = this.tagMap.get(tag);
      if (set) {
        set.delete(key);
        if (set.size === 0) this.tagMap.delete(tag);
      }
    }

    this.store.delete(key);
    return true;
  }

  invalidateKey(key) {
    const deleted = this.delete(key);
    if (deleted) this.statsCounters.invalidations++;
    return deleted;
  }

  invalidateTag(tag) {
    const keys = this.tagMap.get(tag);
    if (!keys || keys.size === 0) return 0;
    let count = 0;
    for (const key of Array.from(keys)) {
      if (this.delete(key)) count++;
    }
    this.statsCounters.invalidations += count;
    return count;
  }

  invalidatePrefix(prefix) {
    let count = 0;
    for (const key of Array.from(this.store.keys())) {
      if (key.startsWith(prefix)) {
        if (this.delete(key)) count++;
      }
    }
    this.statsCounters.invalidations += count;
    return count;
  }

  /**
   * Invalidation Engine: triggers cache invalidations on domain mutation events.
   *
   * Supported events:
   * - 'match.completed' / 'match:complete':
   *     invalidates player profiles, match view, and leaderboard projections.
   * - 'profile.updated' / 'profile:update':
   *     invalidates profile cache keys.
   * - 'friend.updated' / 'friend:update':
   *     invalidates friend list cache keys for actor and target.
   * - 'save.updated':
   *     invalidates practice save cache keys.
   * - 'leaderboard.refreshed':
   *     invalidates all leaderboard projections.
   */
  invalidate(event, payload = {}) {
    let count = 0;
    const evt = String(event || '').toLowerCase();

    if (evt === 'match.completed' || evt === 'match:complete') {
      const { matchId, playerIds = [], players = [] } = payload;
      const allPlayers = [...new Set([...(Array.isArray(playerIds) ? playerIds : []), ...(Array.isArray(players) ? players : [])])];

      // Invalidate match views
      if (matchId) {
        if (this.delete(`match:${matchId}`)) count++;
      }

      // Invalidate participants' profile projections
      for (const p of allPlayers) {
        if (p) {
          if (this.delete(`profile:${p}`)) count++;
          if (this.delete(`compat:profile:${p}`)) count++;
          if (this.delete(`public_profile:${p}`)) count++;
        }
      }

      // Invalidate leaderboard projections
      count += this.invalidateTag('leaderboard');
      count += this.invalidatePrefix('leaderboard:');
    } else if (evt === 'profile.updated' || evt === 'profile:update') {
      const { actor } = payload;
      if (actor) {
        if (this.delete(`profile:${actor}`)) count++;
        if (this.delete(`compat:profile:${actor}`)) count++;
        if (this.delete(`public_profile:${actor}`)) count++;
      }
    } else if (evt === 'friend.updated' || evt === 'friend:update') {
      const { actor, target } = payload;
      if (actor) {
        if (this.delete(`friends:${actor}`)) count++;
        if (this.delete(`compat:profile:${actor}`)) count++;
      }
      if (target) {
        if (this.delete(`friends:${target}`)) count++;
        if (this.delete(`compat:profile:${target}`)) count++;
      }
    } else if (evt === 'save.updated' || evt === 'save:update') {
      const { actor } = payload;
      if (actor) {
        if (this.delete(`save:${actor}`)) count++;
      }
    } else if (evt === 'leaderboard.refreshed') {
      count += this.invalidateTag('leaderboard');
      count += this.invalidatePrefix('leaderboard:');
    }

    this.statsCounters.invalidations += count;
    return count;
  }

  /**
   * Clears the entire cache.
   * Invariant (G12): Loss of cache affects latency, never correctness;
   * PostgreSQL remains authoritative.
   */
  clear() {
    this.store.clear();
    this.tagMap.clear();
  }

  /**
   * Retrieves operational telemetry and load reduction metrics (V5-12-04).
   */
  getStats() {
    const totalReads = this.statsCounters.hits + this.statsCounters.misses;
    const hitRate = totalReads > 0 ? this.statsCounters.hits / totalReads : 0;
    const readReductionPercent = Math.round(hitRate * 100);

    return {
      hits: this.statsCounters.hits,
      misses: this.statsCounters.misses,
      sets: this.statsCounters.sets,
      invalidations: this.statsCounters.invalidations,
      staleRejections: this.statsCounters.staleRejections,
      evictions: this.statsCounters.evictions,
      totalEntries: this.store.size,
      totalReads,
      hitRate,
      readReductionPercent,
    };
  }

  resetStats() {
    this.statsCounters = {
      hits: 0,
      misses: 0,
      sets: 0,
      invalidations: 0,
      staleRejections: 0,
      evictions: 0,
    };
  }

  /**
   * Performance probe: measures read latency and hit vs miss load reduction (V5-12-04).
   */
  async measureRead(key, loaderFn, options = {}) {
    const start = process.hrtime.bigint();
    const cached = this.get(key, options);

    if (cached !== null && cached !== undefined) {
      const end = process.hrtime.bigint();
      const latencyMs = Number(end - start) / 1e6;
      return {
        data: cached,
        hit: true,
        latencyMs,
        source: 'cache',
      };
    }

    const fresh = await loaderFn();
    const end = process.hrtime.bigint();
    const latencyMs = Number(end - start) / 1e6;

    if (fresh !== null && fresh !== undefined) {
      this.set(key, fresh, options);
    }

    return {
      data: fresh,
      hit: false,
      latencyMs,
      source: 'authority',
    };
  }

  /**
   * Resolves Cache-Control header string for a given pathname and context.
   */
  getHeaders(pathname, options = {}) {
    const classification = classifyRoute(pathname, options);
    return {
      'Cache-Control': classification.cacheControl,
    };
  }
}

/* ==========================================================================
 * 5. Database Projections and Query Path Indexes (V5-12-02)
 * ========================================================================== */

/**
 * Ensures indexes exist on measured public query paths without altering rank rules.
 * Safe to invoke repeatedly (idempotent).
 */
async function ensureReadProjectionIndexes(pool) {
  if (!pool || typeof pool.query !== 'function') return false;

  const indexStatements = [
    // 1. Hot rating rank query index: supports leaderboard ORDER BY rating DESC, games DESC
    `CREATE INDEX IF NOT EXISTS idx_ratings_leaderboard_rank
     ON economy.ratings (rating DESC, games DESC, actor_id)`,

    // 2. Public profile query path: partial index filtering public profiles
    `CREATE INDEX IF NOT EXISTS idx_profiles_public_visibility
     ON identity.profiles (stats_visibility, actor_id)
     WHERE stats_visibility = 'public'`,

    // 3. Historical completed matches lookup: status + created_at DESC
    `CREATE INDEX IF NOT EXISTS idx_matches_completed_history
     ON match.matches (status, created_at DESC)
     WHERE status = 'COMPLETED'`,
  ];

  for (const sql of indexStatements) {
    try {
      await pool.query(sql);
    } catch {
      // Best-effort index creation in guarded environments
    }
  }

  return true;
}

/**
 * Materializes authorized public leaderboard projection directly from PostgreSQL 16.
 *
 * @param {Object} pool PostgreSQL connection pool
 * @param {Object} [filter] Leaderboard filter options: { metric, limit, version }
 * @returns {Promise<VersionedProjection>} Versioned leaderboard projection
 */
async function materializeLeaderboardProjection(pool, filter = {}) {
  const limit = Number.isSafeInteger(filter.limit) && filter.limit > 0 ? filter.limit : 50;
  const version = Number.isSafeInteger(filter.version) && filter.version > 0 ? filter.version : 1;

  if (!pool || typeof pool.query !== 'function') {
    // Fallback empty projection when no pool is connected
    return new VersionedProjection(version, [], Date.now());
  }

  const query = `
    SELECT p.actor_id AS id,
           p.tag,
           p.username,
           p.display_name AS "displayName",
           r.rating::int AS rating,
           r.tier,
           r.games
    FROM identity.profiles p
    JOIN identity.eligibility e ON e.actor_id = p.actor_id
    LEFT JOIN economy.ratings r ON r.actor_id = p.actor_id
    WHERE e.verified = true
      AND e.suspended = false
      AND e.security_hold = false
      AND p.stats_visibility = 'public'
    ORDER BY r.rating DESC, r.games DESC
    LIMIT $1
  `;

  const res = await pool.query(query, [limit]);
  const rows = (res?.rows || []).map((row, idx) => ({
    rank: idx + 1,
    id: row.id,
    tag: row.tag,
    name: row.displayName || row.username || row.tag,
    displayName: row.displayName || row.username,
    username: row.username,
    rating: row.rating !== null && row.rating !== undefined ? row.rating : 1000,
    tier: row.tier || 'bronze',
    games: row.games,
  }));

  return new VersionedProjection(version, rows, Date.now());
}

/**
 * Creates a ReadCache instance.
 */
function createReadCache(options = {}) {
  return new ReadCache(options);
}

// Global default singleton instance for convenience
const defaultReadCache = createReadCache();

module.exports = {
  CATEGORIES,
  SENSITIVITIES,
  CACHE_CONTROL_POLICIES,
  ROUTE_MANIFEST,
  classifyRoute,
  VersionedProjection,
  createVersionedProjection,
  canUpdateProjection,
  ReadCache,
  createReadCache,
  defaultReadCache,
  ensureReadProjectionIndexes,
  materializeLeaderboardProjection,
};
