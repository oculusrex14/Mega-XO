'use strict';

/**
 * packages/services/browser-harness.js
 * Phase 11 Task V5-11-05: Browser-style authentication test harness.
 *
 * Requirements:
 * - createBrowserAuthHarness({ apiBaseUrl, fetcher = fetch, cookieJar, origin })
 * - Supports browser-style authentication:
 *   - session cookie exchange (__Host-mega_session, mega_dev_session)
 *   - CSRF origin and token handling
 *   - profile fetching and updating
 *   - cloud save fetching and updating
 * - Authenticates to the same PostgreSQL platform as native and Game Core.
 * - Confirms browser client resolves to the same permanent actor and state
 *   without requiring any new UI.
 * - Zero new website UI invariant preserved.
 */

const { EventEmitter } = require('node:events');

/**
 * In-memory cookie jar for session tracking across browser client requests.
 */
class MemoryCookieJar {
  constructor(initial = {}) {
    this.cookies = new Map();
    if (initial instanceof Map) {
      for (const [k, v] of initial.entries()) this.cookies.set(k, v);
    } else if (typeof initial === 'object' && initial !== null) {
      for (const [k, v] of Object.entries(initial)) this.cookies.set(k, v);
    }
  }

  get(name) {
    return this.cookies.get(name) || null;
  }

  set(name, value) {
    if (value === '' || value === null || value === undefined) {
      this.cookies.delete(name);
    } else {
      this.cookies.set(name, String(value));
    }
    return this;
  }

  delete(name) {
    this.cookies.delete(name);
    return this;
  }

  clear() {
    this.cookies.clear();
    return this;
  }

  toHeaderString() {
    const parts = [];
    for (const [k, v] of this.cookies.entries()) {
      parts.push(`${k}=${v}`);
    }
    return parts.join('; ');
  }

  parseSetCookieHeader(headerValue) {
    if (!headerValue) return;
    const cookieStrings = Array.isArray(headerValue) ? headerValue : [headerValue];
    for (const cookieStr of cookieStrings) {
      if (typeof cookieStr !== 'string') continue;
      const parts = cookieStr.split(';');
      const pair = parts[0].trim();
      const eqIdx = pair.indexOf('=');
      if (eqIdx > 0) {
        const name = pair.slice(0, eqIdx).trim();
        const value = pair.slice(eqIdx + 1).trim();
        let expired = false;
        for (let i = 1; i < parts.length; i++) {
          const attr = parts[i].trim().toLowerCase();
          if (attr === 'max-age=0' || attr.startsWith('max-age=-')) {
            expired = true;
          }
        }
        if (expired || value === '') {
          this.delete(name);
        } else {
          this.set(name, value);
        }
      }
    }
  }
}

/**
 * Dispatches an HTTP request against an in-process handler function using EventEmitter.
 */
function executeInProcess(handler, url, init = {}) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = (init.method || 'GET').toUpperCase();
    const parsedUrl = new URL(url, 'http://localhost');
    req.url = parsedUrl.pathname + parsedUrl.search;
    req.headers = Object.fromEntries(
      Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v])
    );

    const resHeaders = {};
    let statusCode = 200;
    const chunks = [];

    const res = {
      writeHead(code, headers = {}) {
        statusCode = code;
        for (const [k, v] of Object.entries(headers)) {
          resHeaders[k.toLowerCase()] = v;
        }
        return res;
      },
      setHeader(name, value) {
        resHeaders[name.toLowerCase()] = value;
      },
      getHeader(name) {
        return resHeaders[name.toLowerCase()];
      },
      write(chunk) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        return true;
      },
      end(chunk) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const bodyBuffer = Buffer.concat(chunks);
        const text = bodyBuffer.toString('utf8');
        let data = null;
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }

        const responseObj = {
          status: statusCode,
          statusCode,
          ok: statusCode >= 200 && statusCode < 300,
          headers: {
            get(name) { return resHeaders[name.toLowerCase()] || null; },
            getSetCookie() {
              const sc = resHeaders['set-cookie'];
              if (!sc) return [];
              return Array.isArray(sc) ? sc : [sc];
            },
            ...resHeaders,
          },
          text: async () => text,
          json: async () => data,
          data,
          body: data,
        };

        resolve(responseObj);
      },
    };

    Promise.resolve(handler(req, res)).catch(reject);

    if (init.body !== undefined && init.body !== null) {
      const bodyBuf = Buffer.isBuffer(init.body) ? init.body : Buffer.from(String(init.body));
      req.emit('data', bodyBuf);
    }
    req.emit('end');
  });
}

/**
 * Creates a browser-style authentication harness.
 * @param {Object} options Harness configuration options
 * @param {string|Object} [options.apiBaseUrl] Base URL of the API server or server harness object
 * @param {Function} [options.fetcher] Custom fetch implementation (defaults to globalThis.fetch)
 * @param {MemoryCookieJar|Object} [options.cookieJar] Optional cookie jar
 * @param {string} [options.origin] Origin header to send on mutating requests
 * @param {Function} [options.handler] Direct in-process request handler
 * @returns {Object} Browser authentication harness
 */
function createBrowserAuthHarness(options = {}) {
  let baseUrl = '';
  let inProcessHandler = null;

  if (typeof options.apiBaseUrl === 'string') {
    baseUrl = options.apiBaseUrl.replace(/\/+$/, '');
  } else if (options.apiBaseUrl && typeof options.apiBaseUrl === 'object') {
    if (typeof options.apiBaseUrl.url === 'string') {
      baseUrl = options.apiBaseUrl.url.replace(/\/+$/, '');
    } else if (typeof options.apiBaseUrl.baseUrl === 'string') {
      baseUrl = options.apiBaseUrl.baseUrl.replace(/\/+$/, '');
    }
    if (typeof options.apiBaseUrl.handler === 'function') {
      inProcessHandler = options.apiBaseUrl.handler;
    }
  }

  if (typeof options.handler === 'function') {
    inProcessHandler = options.handler;
  }

  if (!baseUrl) {
    baseUrl = 'http://127.0.0.1';
  }

  // Derive origin from baseUrl or option
  let origin = options.origin;
  if (!origin) {
    try {
      origin = new URL(baseUrl).origin;
    } catch {
      origin = 'https://megaxo.online';
    }
  }

  // Set up cookie jar
  let cookieJar = options.cookieJar;
  if (!cookieJar || !(cookieJar instanceof MemoryCookieJar)) {
    cookieJar = new MemoryCookieJar(cookieJar);
  }

  const customFetcher = options.fetcher || (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);

  let currentActor = options.actor || null;
  let currentCsrf = options.csrfToken || null;

  /**
   * Dispatches an HTTP request with automatic cookie and CSRF handling.
   */
  async function request(routePath, reqOptions = {}) {
    const method = (reqOptions.method || 'GET').toUpperCase();
    const url = routePath.startsWith('http') ? routePath : `${baseUrl}${routePath.startsWith('/') ? '' : '/'}${routePath}`;

    const headers = { ...(reqOptions.headers || {}) };

    // 1. Attach Cookie header from cookie jar
    const cookieHeader = cookieJar.toHeaderString();
    if (cookieHeader && !headers['cookie'] && !headers['Cookie']) {
      headers['Cookie'] = cookieHeader;
    }

    // 2. Attach Origin and Referer for CSRF compliance on mutating requests
    const isMutating = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(method);
    if (isMutating) {
      if (!headers['origin'] && !headers['Origin']) {
        headers['Origin'] = origin;
      }
      if (!headers['referer'] && !headers['Referer']) {
        headers['Referer'] = `${origin}/`;
      }
    }

    // 3. Attach CSRF token if known
    if (currentCsrf && !headers['x-csrf-token'] && !headers['X-CSRF-Token']) {
      headers['x-csrf-token'] = currentCsrf;
    }

    // 4. Serialize body
    let body = reqOptions.body;
    if (body !== undefined && body !== null && typeof body === 'object' && !Buffer.isBuffer(body)) {
      if (!headers['content-type'] && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
      body = JSON.stringify(body);
    }

    // 5. Dispatch via in-process handler or fetcher
    let response;
    if (options.handler && !options.fetcher) {
      response = await executeInProcess(inProcessHandler, url, { method, headers, body });
    } else if (customFetcher) {
      const fetchRes = await customFetcher(url, {
        method,
        headers,
        body,
        redirect: reqOptions.redirect || 'manual',
      });

      const setCookies = fetchRes.headers.getSetCookie?.() || fetchRes.headers.get('set-cookie');
      const text = await fetchRes.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }

      response = {
        status: fetchRes.status,
        statusCode: fetchRes.status,
        ok: fetchRes.ok,
        headers: fetchRes.headers,
        data,
        body: data,
        text: async () => text,
        json: async () => data,
      };

      if (setCookies) {
        cookieJar.parseSetCookieHeader(setCookies);
      }
    } else if (inProcessHandler) {
      response = await executeInProcess(inProcessHandler, url, { method, headers, body });
    } else {
      throw new Error('NO_FETCHER_OR_HANDLER_AVAILABLE');
    }

    // 6. Record cookies from in-process response if present
    if (response.headers) {
      const setCookies = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : (response.headers.get ? response.headers.get('set-cookie') : response.headers['set-cookie']);
      if (setCookies) {
        cookieJar.parseSetCookieHeader(setCookies);
      }
    }

    // 7. Update CSRF token from response payload if present
    if (response.data && typeof response.data === 'object') {
      if (response.data.csrf) currentCsrf = response.data.csrf;
    }

    // Construct merged return object providing transparent access to both
    // payload fields and HTTP response metadata
    const payload = response.data;
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      return Object.assign(Object.create(payload), payload, {
        status: response.status,
        statusCode: response.statusCode,
        ok: response.ok,
        headers: response.headers,
        data: payload,
        body: payload,
        text: response.text,
        json: response.json,
      });
    }

    return response;
  }

  /**
   * Sets the session cookie for subsequent requests.
   */
  function setSession(token) {
    if (token) {
      cookieJar.set('__Host-mega_session', token);
      cookieJar.set('mega_dev_session', token);
    } else {
      cookieJar.delete('__Host-mega_session');
      cookieJar.delete('mega_dev_session');
    }
    return harness;
  }

  /**
   * Retrieves the current session token from the cookie jar.
   */
  function getSessionToken() {
    return cookieJar.get('__Host-mega_session')
      || cookieJar.get('mega_dev_session')
      || cookieJar.get('session')
      || null;
  }

  /**
   * Authenticates the harness as an actor against PostgreSQL accounts service.
   */
  async function authenticate({ actor = null, token = null, accounts = null } = {}) {
    if (actor) currentActor = actor;

    if (token) {
      setSession(token);
      return { actor: currentActor, token, harness };
    }

    if (actor && accounts && typeof accounts.issue === 'function') {
      const issued = await accounts.issue(actor, Date.now());
      setSession(issued.token);
      return { actor, token: issued.token, session: issued, harness };
    }

    if (actor) {
      setSession(`session_${actor}`);
    }

    return { actor: currentActor, token: getSessionToken(), harness };
  }

  /**
   * Convenience helper to login as an actor.
   */
  async function loginAs(actor, accounts) {
    return authenticate({ actor, accounts });
  }

  /**
   * GET /api/account/profile
   */
  async function getProfile() {
    return request('/api/account/profile', { method: 'GET' });
  }

  /**
   * POST /api/account/profile
   */
  async function updateProfile(data = {}) {
    return request('/api/account/profile', { method: 'POST', body: data });
  }

  /**
   * GET /api/account/save
   */
  async function getSave() {
    return request('/api/account/save', { method: 'GET' });
  }

  /**
   * POST /api/account/save
   */
  async function putSave(revisionOrBody, savePayload) {
    let body;
    if (typeof revisionOrBody === 'number') {
      body = { revision: revisionOrBody, practice: savePayload, save: savePayload };
    } else if (typeof revisionOrBody === 'object' && revisionOrBody !== null) {
      body = { ...revisionOrBody };
    } else {
      body = {};
    }
    return request('/api/account/save', { method: 'POST', body });
  }

  /**
   * GET /api/account/sessions
   */
  async function getSessions() {
    return request('/api/account/sessions', { method: 'GET' });
  }

  /**
   * GET /health
   */
  async function getHealth() {
    return request('/health', { method: 'GET' });
  }

  /**
   * GET /.well-known/assetlinks.json
   */
  async function getAssetLinks() {
    return request('/.well-known/assetlinks.json', { method: 'GET' });
  }

  /**
   * GET /.well-known/apple-app-site-association
   */
  async function getAppleAssociation() {
    return request('/.well-known/apple-app-site-association', { method: 'GET' });
  }

  /**
   * POST /api/account/logout
   */
  async function logout(allDevices = false) {
    return request('/api/account/logout', { method: 'POST', body: { allDevices } });
  }

  const harness = {
    apiBaseUrl: baseUrl,
    baseUrl,
    cookieJar,
    origin,
    get actor() { return currentActor; },
    set actor(val) { currentActor = val; },
    get csrfToken() { return currentCsrf; },
    set csrfToken(val) { currentCsrf = val; },
    setSession,
    getSessionToken,
    setCookie: (name, val) => { cookieJar.set(name, val); return harness; },
    getCookie: (name) => cookieJar.get(name),
    clearCookies: () => { cookieJar.clear(); return harness; },
    getCookies: () => cookieJar.toHeaderString(),
    authenticate,
    loginAs,
    request,
    getProfile,
    updateProfile,
    getSave,
    putSave,
    updateSave: putSave,
    getSessions,
    getHealth,
    getAssetLinks,
    getAppleAssociation,
    logout,
  };

  return harness;
}

module.exports = {
  createBrowserAuthHarness,
  MemoryCookieJar,
};
