import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/src/index.js';

function toBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

async function verifier(pepper, credential) {
  const key = await crypto.subtle.importKey(
    'raw',
    pepper,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(credential.normalize('NFKC'))));
}

async function testEnv(password = 'worker-testowe-haslo') {
  const pepper = crypto.getRandomValues(new Uint8Array(32));
  const recovery = 'RECOVERY-TEST-CODE-123456';
  return {
    FRONTEND_ORIGINS: 'https://example.github.io',
    GITHUB_OWNER: 'owner',
    GITHUB_REPO: 'vault',
    GITHUB_BRANCH: 'main',
    GITHUB_TOKEN: 'test-token',
    AUTH_PEPPER_B64: toBase64(pepper),
    ACCESS_VERIFIER_B64: toBase64(await verifier(pepper, password)),
    RECOVERY_VERIFIER_B64: toBase64(await verifier(pepper, recovery)),
    SESSION_SECRET_B64: toBase64(crypto.getRandomValues(new Uint8Array(32))),
  };
}

function request(path, options = {}) {
  return new Request(`https://api.example.workers.dev${path}`, {
    ...options,
    headers: {
      origin: 'https://example.github.io',
      'cf-connecting-ip': options.ip || '198.51.100.7',
      ...(options.headers || {}),
    },
  });
}

test('health i logowanie zwracają poprawne CORS oraz podpisaną sesję', async () => {
  const env = await testEnv();
  const health = await worker.fetch(request('/api/health'), env);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('access-control-allow-origin'), 'https://example.github.io');

  const login = await worker.fetch(request('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential: 'worker-testowe-haslo', kind: 'password' }),
  }), env);
  assert.equal(login.status, 200);
  const payload = await login.json();
  assert.match(payload.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});

test('błędne hasło nie ujawnia danych i nie wydaje tokenu', async () => {
  const env = await testEnv();
  const response = await worker.fetch(request('/api/session', {
    method: 'POST',
    ip: '198.51.100.8',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential: 'niepoprawne-haslo', kind: 'password' }),
  }), env);
  assert.equal(response.status, 401);
  const payload = await response.json();
  assert.equal(payload.token, undefined);
  assert.equal(payload.error, 'Nieprawidłowe dane dostępu.');
});

test('sesja pozwala czytać wyłącznie bezpieczne ścieżki sejfu', async () => {
  const env = await testEnv();
  const login = await worker.fetch(request('/api/session', {
    method: 'POST',
    ip: '198.51.100.9',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential: 'worker-testowe-haslo', kind: 'password' }),
  }), env);
  const { token } = await login.json();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    type: 'file',
    encoding: 'base64',
    content: Buffer.from('encrypted').toString('base64'),
    sha: 'a'.repeat(40),
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const valid = await worker.fetch(request('/api/vault?path=bootstrap.json', {
      headers: { authorization: `Bearer ${token}` },
    }), env);
    assert.equal(valid.status, 200);
    assert.equal((await valid.json()).revision, 'a'.repeat(40));

    const invalid = await worker.fetch(request('/api/vault?path=../sekret', {
      headers: { authorization: `Bearer ${token}` },
    }), env);
    assert.equal(invalid.status, 400);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
