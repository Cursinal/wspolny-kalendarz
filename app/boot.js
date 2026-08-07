const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const isLocalDev = location.protocol === 'http:' && LOCAL_HOSTS.has(location.hostname.toLowerCase());

async function clearLegacyLocalPwa() {
  if (!isLocalDev) return;

  if ('serviceWorker' in navigator) {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    } catch {
      // Lokalny tryb ma działać również, gdy API Service Workera jest ograniczone.
    }
  }

  if ('caches' in globalThis) {
    try {
      const keys = await caches.keys();
      await Promise.all(keys
        .filter((key) => key.startsWith('friends-calendar-static-'))
        .map((key) => caches.delete(key)));
    } catch {
      // Cache nie jest potrzebny w trybie developerskim.
    }
  }
}

await clearLegacyLocalPwa();
await import('./src/main.js?v=1.1.1');
