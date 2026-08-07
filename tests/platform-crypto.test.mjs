import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const moduleUrl = pathToFileURL(resolve(root, 'app/src/platform-crypto.js')).href;

function runModule(code) {
  return spawnSync(process.execPath, ['--input-type=module', '--eval', code], {
    encoding: 'utf8',
  });
}

test('warstwa Web Crypto działa w bezpiecznym środowisku', () => {
  const result = runModule(`
    const { assertCryptoSupport, getSubtleCrypto } = await import(${JSON.stringify(moduleUrl)});
    if (!assertCryptoSupport()) process.exit(2);
    if (typeof getSubtleCrypto().importKey !== 'function') process.exit(3);
  `);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('niezabezpieczony adres telefonu zwraca czytelny błąd zamiast TypeError', () => {
  const result = runModule(`
    globalThis.location = { protocol: 'http:', hostname: '192.168.1.25' };
    globalThis.isSecureContext = false;
    const { CryptoUnavailableError, assertCryptoSupport } = await import(${JSON.stringify(moduleUrl)});
    try {
      assertCryptoSupport();
      process.exit(4);
    } catch (error) {
      if (!(error instanceof CryptoUnavailableError)) process.exit(5);
      if (error.code !== 'INSECURE_CONTEXT') process.exit(6);
      if (!String(error.message).includes('HTTPS')) process.exit(7);
    }
  `);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});


test('adres nasłuchu [::] wskazuje użytkownikowi localhost zamiast HTTPS', () => {
  const result = runModule(`
    globalThis.location = { protocol: 'http:', hostname: '[::]' };
    globalThis.isSecureContext = false;
    const { CryptoUnavailableError, assertCryptoSupport } = await import(${JSON.stringify(moduleUrl)});
    try {
      assertCryptoSupport();
      process.exit(4);
    } catch (error) {
      if (!(error instanceof CryptoUnavailableError)) process.exit(5);
      if (error.code !== 'WILDCARD_HOST') process.exit(6);
      if (!String(error.message).includes('http://localhost:8080/')) process.exit(7);
      if (String(error.message).includes('otwórz wersję HTTPS')) process.exit(8);
    }
  `);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
