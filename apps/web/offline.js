const CACHE_PREFIX = 'mega-xoxo-web-offline-v1:';
const ROOT_SCOPE = '/';
const WORKER_PATH = '/offline-sw.js';
const PREPARE_TIMEOUT_MS = 12_000;

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

function registrationIsOurs(registration, win) {
  if (!registration || !win?.location) return false;
  let scope;
  try { scope = new URL(registration.scope, win.location.href); } catch (_) { return false; }
  if (scope.origin !== win.location.origin || scope.pathname !== ROOT_SCOPE || scope.search || scope.hash) return false;
  const workers = [registration.active, registration.waiting, registration.installing].filter(Boolean);
  return workers.length > 0 && workers.every((worker) => workerUrl(worker, win.location.origin) === WORKER_PATH);
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
    if (!registrationIsOurs(registration, win)) return { status: 'conflict', canRemove: false, message: stateMessage('conflict') };
    const status = registration.waiting || registration.installing
      ? 'waiting'
      : (versionFromCacheNames(caches) ? 'ready' : 'absent');
    return {
      status,
      canRemove: true,
      ...(versionFromCacheNames(caches) ? { version: versionFromCacheNames(caches) } : {}),
      message: stateMessage(status),
    };
  } catch (_) {
    return unavailable('Offline status could not be read from this browser.');
  }
}

function waitForInstall(registration, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (registration.installing) registration.installing.removeEventListener?.('statechange', inspect);
      registration.removeEventListener?.('updatefound', inspect);
      resolve(status);
    };
    const inspect = () => {
      if (registration.waiting) return finish('waiting');
      const installing = registration.installing;
      if (installing?.state === 'redundant') return finish('failed');
      if (installing?.state === 'activated' || (!installing && registration.active)) return finish('ready');
    };
    registration.addEventListener?.('updatefound', inspect);
    registration.installing?.addEventListener?.('statechange', inspect);
    timer = setTimeout(() => finish(registration.waiting ? 'waiting' : 'timeout'), timeoutMs);
    inspect();
  });
}

/** Prepare the offline copy only when an explicit user action calls this function. */
export async function prepareOffline() {
  const win = currentWindow();
  const nav = currentNavigator();
  const storage = cacheStorage();
  if (!win || !isSecure(win) || !nav?.serviceWorker || !storage?.keys || !nav.serviceWorker.register) {
    return unavailable('Offline storage requires a secure page with service worker and cache support.');
  }

  try {
    const deadline = Date.now() + PREPARE_TIMEOUT_MS;
    const existing = await withTimeout(nav.serviceWorker.getRegistration(ROOT_SCOPE), deadline - Date.now());
    if (existing && !registrationIsOurs(existing, win)) {
      return { status: 'conflict', canRemove: false, reloadRequired: false, message: stateMessage('conflict') };
    }
    const hadController = Boolean(nav.serviceWorker.controller);
    const registration = await withTimeout(nav.serviceWorker.register(WORKER_PATH, {
      scope: ROOT_SCOPE,
      updateViaCache: 'none',
    }), deadline - Date.now());
    if (!registrationIsOurs(registration, win)) {
      return { status: 'conflict', canRemove: false, reloadRequired: false, message: stateMessage('conflict') };
    }
    const outcome = await waitForInstall(registration, deadline - Date.now());
    if (outcome === 'failed') {
      const state = await getOfflineState();
      return { status: 'unavailable', canRemove: state.canRemove === true, reloadRequired: false, message: 'The offline copy failed its integrity or storage checks.' };
    }
    if (outcome === 'waiting') {
      return { status: 'waiting', canRemove: true, reloadRequired: false, message: stateMessage('waiting') };
    }
    if (outcome === 'timeout') {
      return { status: 'waiting', canRemove: true, reloadRequired: false, message: 'The offline copy is still being prepared. Check again shortly.' };
    }
    const installedCaches = await ownCaches(storage);
    if (!versionFromCacheNames(installedCaches)) {
      return {
        status: 'unavailable',
        canRemove: true,
        reloadRequired: false,
        message: 'The verified offline files are missing. Remove the offline copy and prepare it again.',
      };
    }
    return {
      status: 'ready',
      canRemove: true,
      reloadRequired: !hadController,
      message: hadController
        ? 'The offline copy is ready on this device.'
        : 'The offline copy is ready. Reload this page once to use it offline.',
    };
  } catch (error) {
    let canRemove = false;
    try { canRemove = (await getOfflineState()).canRemove === true; } catch (_) { /* keep cleanup unavailable */ }
    if (error?.name === 'TimeoutError') {
      return { status: 'waiting', canRemove, message: safeErrorMessage(error), reloadRequired: false };
    }
    return { ...unavailable(safeErrorMessage(error)), canRemove, reloadRequired: false };
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
    const ownsRegistration = registrationIsOurs(registration, win);
    if (registration && !ownsRegistration) {
      return { status: 'conflict', canRemove: false, message: stateMessage('conflict') };
    }
    if (ownsRegistration) {
      const unregistered = await registration.unregister();
      if (!unregistered) {
        const current = await nav.serviceWorker.getRegistration(ROOT_SCOPE);
        if (current && !registrationIsOurs(current, win)) {
          return { status: 'conflict', canRemove: false, message: stateMessage('conflict') };
        }
        if (current && registrationIsOurs(current, win)) {
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
