const CACHE_PREFIX = 'mega-xoxo-web-offline-v1:';
const ROOT_SCOPE = '/';
const WORKER_PATH = '/offline-sw.js';
const PREPARE_TIMEOUT_MS = 12_000;
const EMPTY_WORKER_GRACE_MS = 100;
const knownRegistrations = new WeakSet();

function currentWindow() {
  return typeof globalThis.window === 'object' ? globalThis.window : null;
}

function currentNavigator() {
  const win = currentWindow();
  return win?.navigator || (typeof globalThis.navigator === 'object' ? globalThis.navigator : null);
}

function cacheStorage() {
  const win = currentWindow();
  return win?.caches || (typeof globalThis.caches === 'object' ? globalThis.caches : null);
}

function isSecure(win) {
  if (!win) return false;
  if (win.isSecureContext === true) return true;
  const hostname = win.location?.hostname;
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function workerUrl(worker, origin) {
  if (!worker?.scriptURL || !origin) return '';
  try {
    const parsed = new URL(worker.scriptURL, origin);
    return parsed.origin === origin ? `${parsed.pathname}${parsed.search}` : '';
  } catch (_) {
    return '';
  }
}

function registrationHasRootScope(registration, win) {
  if (!registration || !win?.location) return false;
  let scope;
  try { scope = new URL(registration.scope, win.location.href); } catch (_) { return false; }
  return scope.origin === win.location.origin && scope.pathname === ROOT_SCOPE && !scope.search && !scope.hash;
}

function registrationWorkers(registration) {
  return [registration?.active, registration?.waiting, registration?.installing].filter(Boolean);
}

function registrationIsOurs(registration, win) {
  if (!registrationHasRootScope(registration, win)) return false;
  const workers = registrationWorkers(registration);
  return workers.length > 0 && workers.every((worker) => workerUrl(worker, win.location.origin) === WORKER_PATH);
}

function registrationIsOursOrKnownEmpty(registration, win) {
  if (registrationIsOurs(registration, win)) return true;
  return registrationHasRootScope(registration, win)
    && registrationWorkers(registration).length === 0
    && knownRegistrations.has(registration);
}

function rememberRegistrationFromOurRegister(registration, win) {
  if (!registrationHasRootScope(registration, win)) return false;
  const workers = registrationWorkers(registration);
  if (workers.length > 0 && !workers.every((worker) => workerUrl(worker, win.location.origin) === WORKER_PATH)) return false;
  knownRegistrations.add(registration);
  return true;
}

function unavailable(message) {
  return { status: 'unavailable', canRemove: false, message };
}

function safeErrorMessage(error) {
  if (error?.name === 'SecurityError') return 'This browser blocked offline storage for this page.';
  if (error?.name === 'NotAllowedError') return 'This browser did not allow offline storage.';
  if (error?.name === 'QuotaExceededError') return 'There is not enough available browser storage for the offline copy.';
  if (error?.name === 'TimeoutError') return 'The offline copy is still being prepared. Check again shortly.';
  return 'The offline copy could not be prepared. Check your connection and try again.';
}

function withTimeout(promise, timeoutMs) {
  if (timeoutMs <= 0) return Promise.reject(Object.assign(new Error('Offline preparation timed out'), { name: 'TimeoutError' }));
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('Offline preparation timed out'), { name: 'TimeoutError' })), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function ownCaches(storage) {
  if (!storage?.keys) return [];
  const keys = await storage.keys();
  return keys.filter((key) => typeof key === 'string' && key.startsWith(CACHE_PREFIX));
}

function versionFromCacheNames(names) {
  const matching = names.find((name) => name.startsWith(CACHE_PREFIX) && name.endsWith(':verified'));
  if (!matching) return undefined;
  const suffix = matching.slice(CACHE_PREFIX.length);
  const separator = suffix.indexOf(':');
  return separator > 0 ? suffix.slice(0, separator) : undefined;
}

function stateMessage(status) {
  if (status === 'ready') return 'The offline copy is ready on this device.';
  if (status === 'waiting') return 'An offline copy or update is waiting for open tabs to close.';
  if (status === 'preparing') return 'The offline copy is still being prepared. Check again shortly.';
  if (status === 'conflict') return 'This site already uses a different offline worker.';
  if (status === 'absent') return 'Offline use has not been prepared on this device.';
  return 'Offline storage is unavailable in this browser or context.';
}

/** Read local registration/cache status only. This never registers, fetches, or reads account data. */
export async function getOfflineState() {
  const win = currentWindow();
  const nav = currentNavigator();
  const storage = cacheStorage();
  if (!win || !isSecure(win) || !nav?.serviceWorker || !storage?.keys) {
    return unavailable('Offline storage is unavailable in this browser or context.');
  }
  try {
    const registration = await nav.serviceWorker.getRegistration(ROOT_SCOPE);
    const caches = await ownCaches(storage);
    if (!registration) {
      return {
        status: 'absent',
        canRemove: caches.length > 0,
        ...(versionFromCacheNames(caches) ? { version: versionFromCacheNames(caches) } : {}),
        message: stateMessage('absent'),
      };
    }
    if (!registrationIsOursOrKnownEmpty(registration, win)) return { status: 'conflict', canRemove: false, message: stateMessage('conflict') };
    const version = versionFromCacheNames(caches);
    let status = 'absent';
    if (registration.waiting && registration.active) status = 'waiting';
    else if (registration.waiting || registration.installing || ['installing', 'activating'].includes(registration.active?.state)) status = 'preparing';
    else if (registration.active?.state === 'activated' && version) status = 'ready';
    return {
      status,
      canRemove: true,
      ...(version ? { version } : {}),
      message: status==='ready'&&!nav.serviceWorker.controller?'The offline copy is ready. Reload this page once to use it offline.':stateMessage(status),
    };
  } catch (_) {
    return unavailable('Offline status could not be read from this browser.');
  }
}

function waitForInstall(registration, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    let emptyWorkerTimer;
    const observedWorkers = new Map();
    const detachWorker = (worker, listener) => worker.removeEventListener?.('statechange', listener);
    const finish = (status) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (emptyWorkerTimer) clearTimeout(emptyWorkerTimer);
      registration.removeEventListener?.('updatefound', inspect);
      for (const [worker, listener] of observedWorkers) detachWorker(worker, listener);
      observedWorkers.clear();
      resolve(status);
    };
    const syncWorkerListeners = () => {
      const workers = registrationWorkers(registration);
      const currentWorkers = new Set(workers);
      for (const [worker, listener] of observedWorkers) {
        if (!currentWorkers.has(worker)) {
          detachWorker(worker, listener);
          observedWorkers.delete(worker);
        }
      }
      for (const worker of workers) {
        if (observedWorkers.has(worker)) continue;
        const listener = () => inspect();
        observedWorkers.set(worker, listener);
        worker.addEventListener?.('statechange', listener);
      }
      return workers;
    };
    const inspect = () => {
      const workers = syncWorkerListeners();
      const installing = registration.installing;
      if ([installing, registration.waiting, registration.active].some((worker) => worker?.state === 'redundant')) return finish('failed');
      if (registration.waiting && registration.active) return finish('waiting');
      if (registration.active?.state === 'activated' && !installing && !registration.waiting) return finish('ready');
      if (workers.length === 0) {
        if (!emptyWorkerTimer) {
          emptyWorkerTimer = setTimeout(() => {
            emptyWorkerTimer = null;
            if (registrationWorkers(registration).length === 0) finish('failed');
            else inspect();
          }, Math.min(EMPTY_WORKER_GRACE_MS, Math.max(timeoutMs, 0)));
        }
      } else if (emptyWorkerTimer) {
        clearTimeout(emptyWorkerTimer);
        emptyWorkerTimer = null;
      }
    };
    registration.addEventListener?.('updatefound', inspect);
    timer = setTimeout(() => finish('timeout'), Math.max(timeoutMs, 0));
    inspect();
  });
}

function afterInstallObservation(state, hadController) {
  if (state.status === 'ready') {
    return { ...state, reloadRequired: !hadController };
  }
  if (state.status === 'waiting') return { ...state, reloadRequired: false };
  if (state.status === 'preparing') return { ...state, reloadRequired: false };
  if (state.status === 'conflict') return { ...state, canRemove: false, reloadRequired: false };
  const preserved = Boolean(state.version);
  return {
    status: 'unavailable',
    canRemove: state.canRemove === true,
    ...(state.version ? { version: state.version } : {}),
    reloadRequired: false,
    message: preserved
      ? 'The offline copy could not be completed. The previously saved verified copy was left in place.'
      : 'The offline copy could not be completed. No verified copy was saved.',
  };
}

function failedInstallObservation(state, message) {
  if (state.status === 'conflict') return { ...state, canRemove: false, reloadRequired: false };
  const preserved = Boolean(state.version);
  return {
    status: 'unavailable',
    canRemove: state.canRemove === true,
    ...(state.version ? { version: state.version } : {}),
    reloadRequired: false,
    message: preserved ? `${message} The previously saved verified copy was left in place.` : message,
  };
}

/** Prepare the offline copy only when an explicit user action calls this function. */
export async function prepareOffline() {
  const win = currentWindow();
  const nav = currentNavigator();
  const storage = cacheStorage();
  if (!win || !isSecure(win) || !nav?.serviceWorker || !storage?.keys || !nav.serviceWorker.register) {
    return unavailable('Offline storage requires a secure page with service worker and cache support.');
  }

  let hadController = Boolean(nav.serviceWorker.controller);
  try {
    const deadline = Date.now() + PREPARE_TIMEOUT_MS;
    const existing = await withTimeout(nav.serviceWorker.getRegistration(ROOT_SCOPE), deadline - Date.now());
    if (existing && !registrationIsOursOrKnownEmpty(existing, win)) {
      return { status: 'conflict', canRemove: false, reloadRequired: false, message: stateMessage('conflict') };
    }
    hadController = Boolean(nav.serviceWorker.controller);
    const registration = await withTimeout(nav.serviceWorker.register(WORKER_PATH, {
      scope: ROOT_SCOPE,
      updateViaCache: 'none',
    }), deadline - Date.now());
    if (!rememberRegistrationFromOurRegister(registration, win)) {
      return { status: 'conflict', canRemove: false, reloadRequired: false, message: stateMessage('conflict') };
    }
    const outcome = await waitForInstall(registration, deadline - Date.now());
    if (outcome === 'failed') {
      const state = await getOfflineState();
      return failedInstallObservation(state, 'The offline copy failed its integrity or storage checks.');
    }
    const state = await getOfflineState();
    return afterInstallObservation(state, hadController);
  } catch (error) {
    let state = unavailable('Offline status could not be read from this browser.');
    try { state = await getOfflineState(); } catch (_) { /* preserve the local failure without further access */ }
    if (error?.name === 'TimeoutError') return afterInstallObservation(state, hadController);
    return failedInstallObservation(state, safeErrorMessage(error));
  }
}

/** Remove only this feature's root worker and namespaced caches. */
export async function removeOffline() {
  const win = currentWindow();
  const nav = currentNavigator();
  const storage = cacheStorage();
  if (!win || !nav?.serviceWorker || !storage?.keys || !storage?.delete) {
    return unavailable('Offline storage is unavailable in this browser or context.');
  }
  try {
    const registration = await nav.serviceWorker.getRegistration(ROOT_SCOPE);
    const ownsRegistration = registrationIsOursOrKnownEmpty(registration, win);
    if (registration && !ownsRegistration) {
      return { status: 'conflict', canRemove: false, message: stateMessage('conflict') };
    }
    if (ownsRegistration) {
      const unregistered = await registration.unregister();
      if (!unregistered) {
        const current = await nav.serviceWorker.getRegistration(ROOT_SCOPE);
        if (current && !registrationIsOursOrKnownEmpty(current, win)) {
          return { status: 'conflict', canRemove: false, message: stateMessage('conflict') };
        }
        if (current && registrationIsOursOrKnownEmpty(current, win)) {
          const names = await ownCaches(storage);
          const status = versionFromCacheNames(names) ? 'ready' : 'absent';
          return {
            status,
            canRemove: true,
            ...(versionFromCacheNames(names) ? { version: versionFromCacheNames(names) } : {}),
            message: 'The offline worker could not be removed. Its local files were left in place.',
          };
        }
      }
    }
    const names = await ownCaches(storage);
    for (const name of names) await storage.delete(name);
    return { status: 'absent', canRemove: false, message: 'The offline copy was removed from this device.' };
  } catch (_) {
    return unavailable('The offline copy could not be removed from this browser.');
  }
}
