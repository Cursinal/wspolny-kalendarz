export class CryptoUnavailableError extends Error {
  constructor(message, code = 'CRYPTO_UNAVAILABLE') {
    super(message);
    this.name = 'CryptoUnavailableError';
    this.code = code;
  }
}

export function isLocalHostname(hostname) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(hostname || '').toLowerCase());
}

function isWildcardHostname(hostname) {
  return ['0.0.0.0', '::', '[::]'].includes(String(hostname || '').toLowerCase());
}

function unavailableDetails() {
  const protocol = globalThis.location?.protocol || '';
  const hostname = globalThis.location?.hostname || '';

  if (protocol === 'http:' && isWildcardHostname(hostname)) {
    return {
      code: 'WILDCARD_HOST',
      message: 'Ten adres jest adresem nasłuchu serwera, a nie właściwym adresem aplikacji. Na tym komputerze otwórz dokładnie http://localhost:8080/. Nie zamieniaj go na https:// — lokalny serwer developerski działa po HTTP.',
    };
  }
  if (protocol === 'http:' && !isLocalHostname(hostname)) {
    return {
      code: 'INSECURE_CONTEXT',
      message: 'Ten adres HTTP nie udostępnia bezpiecznego Web Crypto. Nie zmieniaj po prostu http://192.168…:8080 na https://192.168…:8080 — serwer developerski nie obsługuje TLS. Na komputerze użyj http://localhost:8080/, a na telefonie wdrożonego adresu HTTPS (np. GitHub Pages) albo zaufanego tunelu HTTPS.',
    };
  }
  if (protocol === 'file:') {
    return {
      code: 'FILE_CONTEXT',
      message: 'Nie otwieraj pliku index.html bezpośrednio. Na komputerze uruchom `npm run dev` i otwórz http://localhost:8080/. W produkcji użyj HTTPS.',
    };
  }
  return {
    code: 'CRYPTO_UNAVAILABLE',
    message: 'Ta przeglądarka nie udostępnia Web Crypto w tym kontekście. Na komputerze otwórz http://localhost:8080/ w aktualnym Chrome, Edge, Firefox albo Safari; w produkcji użyj HTTPS.',
  };
}

export function getCryptoProvider() {
  const protocol = globalThis.location?.protocol || '';
  const hostname = globalThis.location?.hostname || '';
  const insecureHttp = protocol === 'http:' && !isLocalHostname(hostname);
  const insecureContext = globalThis.isSecureContext === false && !isLocalHostname(hostname);
  if (protocol === 'file:' || insecureHttp || insecureContext) {
    const details = unavailableDetails();
    throw new CryptoUnavailableError(details.message, details.code);
  }

  const provider = globalThis.crypto || globalThis.msCrypto;
  if (!provider || typeof provider.getRandomValues !== 'function') {
    const details = unavailableDetails();
    throw new CryptoUnavailableError(details.message, details.code);
  }
  return provider;
}

export function getSubtleCrypto() {
  const provider = getCryptoProvider();
  const subtle = provider.subtle || provider.webkitSubtle;
  if (!subtle || typeof subtle.importKey !== 'function') {
    const details = unavailableDetails();
    throw new CryptoUnavailableError(details.message, details.code);
  }
  return subtle;
}

export function assertCryptoSupport() {
  getSubtleCrypto();
  return true;
}

export function fillRandomValues(bytes) {
  return getCryptoProvider().getRandomValues(bytes);
}

export function createRandomUuid() {
  const provider = getCryptoProvider();
  if (typeof provider.randomUUID === 'function') return provider.randomUUID();
  const bytes = fillRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
