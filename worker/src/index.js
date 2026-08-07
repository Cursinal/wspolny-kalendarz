const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_BODY_BYTES = 1_500_000;
const MAX_FILE_BYTES = 900 * 1024;
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const RATE_WINDOW_SECONDS = 15 * 60;
const RATE_MAX_FAILURES = 8;
const GITHUB_API_VERSION = '2022-11-28';

class HttpError extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

function base64ToBytes(value) {
  const normalized = String(value || '').replace(/\s/g, '');
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  return base64ToBytes(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
}

function jsonResponse(request, env, payload, status = 200, extraHeaders = {}) {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...extraHeaders,
  });
  applyCors(request, env, headers);
  return new Response(JSON.stringify(payload), { status, headers });
}

function emptyResponse(request, env, status = 204, extraHeaders = {}) {
  const headers = new Headers({
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  applyCors(request, env, headers);
  return new Response(null, { status, headers });
}

function configuredOrigins(env) {
  return String(env.FRONTEND_ORIGINS || env.FRONTEND_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

function requestOrigin(request) {
  return String(request.headers.get('origin') || '').replace(/\/$/, '');
}

function assertAllowedOrigin(request, env) {
  const origin = requestOrigin(request);
  if (!origin) return;
  const allowed = configuredOrigins(env);
  if (!allowed.includes(origin)) throw new HttpError(403, 'Ta witryna nie ma dostępu do API.');
}

function applyCors(request, env, headers) {
  const origin = requestOrigin(request);
  if (!origin || !configuredOrigins(env).includes(origin)) return;
  headers.set('access-control-allow-origin', origin);
  headers.set('vary', 'Origin');
  headers.set('access-control-allow-methods', 'GET, PUT, DELETE, POST, OPTIONS');
  headers.set('access-control-allow-headers', 'authorization, content-type');
  headers.set('access-control-max-age', '86400');
}

async function readJson(request) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_BODY_BYTES) throw new HttpError(413, 'Żądanie jest zbyt duże.');
  const text = await request.text();
  if (encoder.encode(text).length > MAX_BODY_BYTES) throw new HttpError(413, 'Żądanie jest zbyt duże.');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'Nieprawidłowy JSON.');
  }
}

function validateBase64(value) {
  if (typeof value !== 'string' || !value.length || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new HttpError(400, 'Nieprawidłowa zawartość pliku.');
  }
  let bytes;
  try {
    bytes = base64ToBytes(value);
  } catch {
    throw new HttpError(400, 'Nieprawidłowa zawartość pliku.');
  }
  if (bytes.length > MAX_FILE_BYTES) throw new HttpError(413, 'Zaszyfrowany plik jest zbyt duży.');
  return bytes;
}

function validateVaultPath(input) {
  const path = String(input || '');
  if (path === 'bootstrap.json') return path;
  if (
    path.length < 7
    || path.length > 240
    || !path.startsWith('vault/')
    || path.includes('..')
    || path.includes('//')
    || path.endsWith('/')
    || !/^[A-Za-z0-9._/-]+$/.test(path)
  ) {
    throw new HttpError(400, 'Nieprawidłowa ścieżka sejfu.');
  }
  return path;
}

function safeRevision(value) {
  if (value === null || value === undefined || value === '') return null;
  const revision = String(value);
  if (!/^[0-9a-f]{40}$/i.test(revision)) throw new HttpError(400, 'Nieprawidłowa rewizja pliku.');
  return revision;
}

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

const fallbackRateLimits = new Map();

async function readRateLimit(env, key) {
  if (env.RATE_LIMIT) {
    try {
      return await env.RATE_LIMIT.get(key, { type: 'json' });
    } catch {
      return null;
    }
  }
  const item = fallbackRateLimits.get(key);
  if (!item || item.resetAt <= Date.now()) {
    fallbackRateLimits.delete(key);
    return null;
  }
  return item;
}

async function writeRateLimit(env, key, value) {
  if (env.RATE_LIMIT) {
    await env.RATE_LIMIT.put(key, JSON.stringify(value), { expirationTtl: RATE_WINDOW_SECONDS });
    return;
  }
  fallbackRateLimits.set(key, value);
}

async function clearRateLimit(env, key) {
  if (env.RATE_LIMIT) {
    await env.RATE_LIMIT.delete(key);
    return;
  }
  fallbackRateLimits.delete(key);
}

async function assertRateLimit(request, env) {
  const key = `login:${clientIp(request)}`;
  const record = await readRateLimit(env, key);
  if (!record) return key;
  if (Number(record.resetAt) <= Date.now()) {
    await clearRateLimit(env, key);
    return key;
  }
  if (Number(record.count) >= RATE_MAX_FAILURES) {
    const retryAfter = Math.max(1, Math.ceil((Number(record.resetAt) - Date.now()) / 1000));
    throw new HttpError(429, 'Za dużo nieudanych prób.', { retryAfter });
  }
  return key;
}

async function recordLoginFailure(env, key) {
  const now = Date.now();
  const current = await readRateLimit(env, key);
  const resetAt = current && Number(current.resetAt) > now
    ? Number(current.resetAt)
    : now + RATE_WINDOW_SECONDS * 1000;
  await writeRateLimit(env, key, {
    count: Number(current?.count || 0) + 1,
    resetAt,
  });
}

function requiredSecret(env, name) {
  const value = env[name];
  if (!value) throw new HttpError(500, `Brakuje sekretu wdrożeniowego: ${name}.`);
  return String(value);
}

async function importHmacKey(base64Value, usages) {
  return crypto.subtle.importKey(
    'raw',
    base64ToBytes(base64Value),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages,
  );
}

async function verifyCredential(credential, kind, env) {
  const normalized = String(credential || '').normalize('NFKC');
  if (!normalized || normalized.length > 512) return false;
  const verifierName = kind === 'recovery' ? 'RECOVERY_VERIFIER_B64' : 'ACCESS_VERIFIER_B64';
  const expected = base64ToBytes(requiredSecret(env, verifierName));
  const key = await importHmacKey(requiredSecret(env, 'AUTH_PEPPER_B64'), ['verify']);
  return crypto.subtle.verify('HMAC', key, expected, encoder.encode(normalized));
}

async function signSession(payload, env) {
  const encodedPayload = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await importHmacKey(requiredSecret(env, 'SESSION_SECRET_B64'), ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(encodedPayload)));
  return `${encodedPayload}.${bytesToBase64Url(signature)}`;
}

async function issueSession(env, authKind) {
  const now = Math.floor(Date.now() / 1000);
  return signSession({
    v: 1,
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
    auth: authKind,
    scope: 'vault',
    nonce: crypto.randomUUID(),
  }, env);
}

async function verifySession(token, env) {
  const [encodedPayload, encodedSignature, extra] = String(token || '').split('.');
  if (!encodedPayload || !encodedSignature || extra) return null;
  let signature;
  let payload;
  try {
    signature = base64UrlToBytes(encodedSignature);
    payload = JSON.parse(decoder.decode(base64UrlToBytes(encodedPayload)));
  } catch {
    return null;
  }
  const key = await importHmacKey(requiredSecret(env, 'SESSION_SECRET_B64'), ['verify']);
  const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(encodedPayload));
  if (!valid || payload?.v !== 1 || payload?.scope !== 'vault') return null;
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(payload.exp) || payload.exp <= now || payload.exp > now + SESSION_TTL_SECONDS + 60) return null;
  return payload;
}

async function requireSession(request, env) {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match || !(await verifySession(match[1], env))) {
    throw new HttpError(401, 'Sesja wygasła albo jest nieprawidłowa.');
  }
}

function githubHeaders(env) {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${requiredSecret(env, 'GITHUB_TOKEN')}`,
    'x-github-api-version': GITHUB_API_VERSION,
    'user-agent': 'friends-calendar-worker',
  };
}

function githubUrl(path, env, includeRef = true) {
  const owner = encodeURIComponent(String(env.GITHUB_OWNER || ''));
  const repo = encodeURIComponent(String(env.GITHUB_REPO || ''));
  if (!owner || !repo) throw new HttpError(500, 'Brakuje konfiguracji repozytorium GitHub.');
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const base = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`;
  if (!includeRef) return base;
  const branch = encodeURIComponent(String(env.GITHUB_BRANCH || 'main'));
  return `${base}?ref=${branch}`;
}

async function githubJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(502, 'GitHub zwrócił nieprawidłową odpowiedź.');
  }
}

async function githubGet(path, env) {
  const response = await fetch(githubUrl(path, env), {
    headers: githubHeaders(env),
  });
  if (response.status === 404) return null;
  const payload = await githubJson(response);
  if (!response.ok) {
    throw new HttpError(502, 'Nie udało się odczytać zaszyfrowanego pliku z GitHuba.', {
      githubStatus: response.status,
    });
  }
  if (payload.type !== 'file' || payload.encoding !== 'base64' || !payload.content || !payload.sha) {
    throw new HttpError(502, 'GitHub zwrócił nieobsługiwany format pliku.');
  }
  return {
    contentBase64: String(payload.content).replace(/\s/g, ''),
    revision: payload.sha,
  };
}

async function githubPut(path, contentBase64, expectedRevision, env) {
  const current = await githubGet(path, env);
  if (expectedRevision === null && current) {
    throw new HttpError(409, 'Plik został już utworzony na innym urządzeniu.', {
      currentRevision: current.revision,
    });
  }
  if (expectedRevision !== null && current?.revision !== expectedRevision) {
    throw new HttpError(409, 'Plik ma nowszą wersję.', {
      currentRevision: current?.revision || null,
    });
  }

  const body = {
    message: 'Update encrypted calendar vault',
    content: contentBase64,
    branch: String(env.GITHUB_BRANCH || 'main'),
  };
  if (current?.revision) body.sha = current.revision;

  const response = await fetch(githubUrl(path, env, false), {
    method: 'PUT',
    headers: {
      ...githubHeaders(env),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const payload = await githubJson(response);
  if (response.status === 409 || response.status === 422) {
    const latest = await githubGet(path, env).catch(() => null);
    throw new HttpError(409, 'Plik został zmieniony w trakcie zapisu.', {
      currentRevision: latest?.revision || null,
    });
  }
  if (!response.ok || !payload.content?.sha) {
    throw new HttpError(502, 'GitHub nie zapisał zaszyfrowanego pliku.', {
      githubStatus: response.status,
    });
  }
  return payload.content.sha;
}

async function githubDelete(path, expectedRevision, env) {
  const current = await githubGet(path, env);
  if (!current) return null;
  if (current.revision !== expectedRevision) {
    throw new HttpError(409, 'Plik ma nowszą wersję.', {
      currentRevision: current.revision,
    });
  }
  const response = await fetch(githubUrl(path, env, false), {
    method: 'DELETE',
    headers: {
      ...githubHeaders(env),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      message: 'Remove encrypted calendar vault object',
      sha: current.revision,
      branch: String(env.GITHUB_BRANCH || 'main'),
    }),
  });
  if (response.status === 409 || response.status === 422) {
    const latest = await githubGet(path, env).catch(() => null);
    throw new HttpError(409, 'Plik został zmieniony w trakcie usuwania.', {
      currentRevision: latest?.revision || null,
    });
  }
  if (!response.ok) {
    throw new HttpError(502, 'GitHub nie usunął zaszyfrowanego pliku.', {
      githubStatus: response.status,
    });
  }
  return true;
}

async function handleSession(request, env) {
  const rateKey = await assertRateLimit(request, env);
  const body = await readJson(request);
  const kind = body.kind === 'recovery' ? 'recovery' : 'password';
  const credential = body.credential ?? body.password;
  const valid = await verifyCredential(credential, kind, env);
  if (!valid) {
    await recordLoginFailure(env, rateKey);
    throw new HttpError(401, 'Nieprawidłowe dane dostępu.');
  }
  await clearRateLimit(env, rateKey);
  return jsonResponse(request, env, {
    token: await issueSession(env, kind),
    expiresIn: SESSION_TTL_SECONDS,
  });
}

async function handleGetVault(request, env) {
  const url = new URL(request.url);
  const path = validateVaultPath(url.searchParams.get('path'));
  const file = await githubGet(path, env);
  if (!file) throw new HttpError(404, 'Nie znaleziono pliku.');
  return jsonResponse(request, env, file);
}

async function handlePutVault(request, env) {
  const body = await readJson(request);
  const path = validateVaultPath(body.path);
  const expectedRevision = safeRevision(body.expectedRevision);
  validateBase64(body.contentBase64);
  const revision = await githubPut(path, body.contentBase64, expectedRevision, env);
  return jsonResponse(request, env, { revision });
}

async function handleDeleteVault(request, env) {
  const body = await readJson(request);
  const path = validateVaultPath(body.path);
  const expectedRevision = safeRevision(body.expectedRevision);
  if (!expectedRevision) throw new HttpError(400, 'Usuwanie wymaga aktualnej rewizji pliku.');
  await githubDelete(path, expectedRevision, env);
  return emptyResponse(request, env);
}

async function route(request, env) {
  assertAllowedOrigin(request, env);
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return emptyResponse(request, env);
  if (url.pathname === '/api/health' && request.method === 'GET') {
    return jsonResponse(request, env, { ok: true, service: 'friends-calendar-api' });
  }
  if (url.pathname === '/api/session' && request.method === 'POST') {
    return handleSession(request, env);
  }
  if (url.pathname === '/api/vault') {
    await requireSession(request, env);
    if (request.method === 'GET') return handleGetVault(request, env);
    if (request.method === 'PUT') return handlePutVault(request, env);
    if (request.method === 'DELETE') return handleDeleteVault(request, env);
  }
  throw new HttpError(404, 'Nie znaleziono endpointu.');
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const payload = {
        error: status >= 500 ? 'Wewnętrzny błąd usługi.' : error.message,
      };
      if (error instanceof HttpError && error.details.currentRevision !== undefined) {
        payload.currentRevision = error.details.currentRevision;
      }
      const headers = {};
      if (error instanceof HttpError && error.details.retryAfter) {
        headers['retry-after'] = String(error.details.retryAfter);
      }
      return jsonResponse(request, env, payload, status, headers);
    }
  },
};
