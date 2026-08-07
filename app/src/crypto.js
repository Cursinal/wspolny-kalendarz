import { fillRandomValues, getSubtleCrypto } from './platform-crypto.js';
import { randomId, textDecoder, textEncoder } from './utils.js';

export const DEFAULT_KDF = Object.freeze({
  name: 'PBKDF2-HMAC-SHA-256',
  iterations: 600_000,
});

const ROOT_KEY_AAD = textEncoder.encode('friends-calendar:vault-key:v1');
const RECOVERY_KEY_AAD = textEncoder.encode('friends-calendar:recovery-key:v1');
const EXPORT_AAD = textEncoder.encode('friends-calendar:export:v1');
const HKDF_SALT = textEncoder.encode('friends-calendar:file-key:v1');

export function randomBytes(length) {
  return fillRandomValues(new Uint8Array(length));
}

export function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return base64ToBytes(padded);
}

export function encodeJson(value) {
  return textEncoder.encode(JSON.stringify(value));
}

export function decodeJson(bytes) {
  return JSON.parse(textDecoder.decode(bytes));
}

export function normalizePassword(password) {
  return String(password).normalize('NFKC');
}

export async function derivePasswordBits(password, kdf) {
  if (!kdf || kdf.name !== DEFAULT_KDF.name) {
    throw new Error('Nieobsługiwany format klucza hasła.');
  }
  const material = await getSubtleCrypto().importKey(
    'raw',
    textEncoder.encode(normalizePassword(password)),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await getSubtleCrypto().deriveBits({
    name: 'PBKDF2',
    salt: base64ToBytes(kdf.salt),
    iterations: kdf.iterations,
    hash: 'SHA-256',
  }, material, 256);
  return new Uint8Array(bits);
}

async function importAesKey(rawKey, usages = ['encrypt', 'decrypt']) {
  return getSubtleCrypto().importKey('raw', rawKey, { name: 'AES-GCM' }, false, usages);
}

async function aesEncrypt(rawKey, plaintext, aad) {
  const key = await importAesKey(rawKey, ['encrypt']);
  const iv = randomBytes(12);
  const encrypted = await getSubtleCrypto().encrypt({
    name: 'AES-GCM',
    iv,
    additionalData: aad,
    tagLength: 128,
  }, key, plaintext);
  return {
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
  };
}

async function aesDecrypt(rawKey, wrapped, aad) {
  const key = await importAesKey(rawKey, ['decrypt']);
  const decrypted = await getSubtleCrypto().decrypt({
    name: 'AES-GCM',
    iv: base64ToBytes(wrapped.iv),
    additionalData: aad,
    tagLength: 128,
  }, key, base64ToBytes(wrapped.ciphertext));
  return new Uint8Array(decrypted);
}

async function deriveFileKey(rootKey, path, usages) {
  const material = await getSubtleCrypto().importKey('raw', rootKey, 'HKDF', false, ['deriveKey']);
  return getSubtleCrypto().deriveKey({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: HKDF_SALT,
    info: textEncoder.encode(path),
  }, material, { name: 'AES-GCM', length: 256 }, false, usages);
}

export async function encryptFile(rootKey, path, plaintext, contentType = 'application/octet-stream') {
  const key = await deriveFileKey(rootKey, path, ['encrypt']);
  const iv = randomBytes(12);
  const aad = textEncoder.encode(`friends-calendar:file:${path}:v1`);
  const encrypted = await getSubtleCrypto().encrypt({
    name: 'AES-GCM',
    iv,
    additionalData: aad,
    tagLength: 128,
  }, key, plaintext);

  return encodeJson({
    v: 1,
    alg: 'A256GCM',
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    contentType,
    encryptedAt: new Date().toISOString(),
  });
}

export async function decryptFile(rootKey, path, envelopeBytes) {
  const envelope = decodeJson(envelopeBytes);
  if (envelope.v !== 1 || envelope.alg !== 'A256GCM') throw new Error('Nieobsługiwany zaszyfrowany plik.');
  const key = await deriveFileKey(rootKey, path, ['decrypt']);
  const aad = textEncoder.encode(`friends-calendar:file:${path}:v1`);
  const plaintext = await getSubtleCrypto().decrypt({
    name: 'AES-GCM',
    iv: base64ToBytes(envelope.iv),
    additionalData: aad,
    tagLength: 128,
  }, key, base64ToBytes(envelope.ciphertext));
  return {
    bytes: new Uint8Array(plaintext),
    contentType: envelope.contentType || 'application/octet-stream',
  };
}

export async function encryptJsonFile(rootKey, path, value) {
  return encryptFile(rootKey, path, encodeJson(value), 'application/json');
}

export async function decryptJsonFile(rootKey, path, bytes) {
  const decrypted = await decryptFile(rootKey, path, bytes);
  return decodeJson(decrypted.bytes);
}

export async function deriveOpaqueId(rootKey, namespace, value) {
  const key = await getSubtleCrypto().importKey(
    'raw',
    rootKey,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const message = textEncoder.encode(`friends-calendar:opaque:${namespace}:v1:${value}`);
  const digest = new Uint8Array(await getSubtleCrypto().sign('HMAC', key, message));
  return bytesToBase64Url(digest.subarray(0, 18));
}

export function createRecoveryCode() {
  const raw = bytesToBase64Url(randomBytes(24)).toUpperCase();
  return raw.match(/.{1,6}/g).join('-');
}

export async function createBootstrap(password, options = {}) {
  const rootKey = options.rootKey ?? randomBytes(32);
  const passwordSalt = randomBytes(16);
  const passwordKdf = {
    ...DEFAULT_KDF,
    salt: bytesToBase64(passwordSalt),
  };
  const passwordKey = await derivePasswordBits(password, passwordKdf);
  const wrappedVaultKey = await aesEncrypt(passwordKey, rootKey, ROOT_KEY_AAD);

  const recoveryCode = options.recoveryCode ?? createRecoveryCode();
  const recoverySalt = randomBytes(16);
  const recoveryKdf = {
    ...DEFAULT_KDF,
    salt: bytesToBase64(recoverySalt),
  };
  const recoveryKey = await derivePasswordBits(recoveryCode, recoveryKdf);
  const recoveryWrappedVaultKey = await aesEncrypt(recoveryKey, rootKey, RECOVERY_KEY_AAD);

  return {
    rootKey,
    recoveryCode,
    bootstrap: {
      schema: 1,
      kdf: passwordKdf,
      wrappedVaultKey,
      recovery: {
        kdf: recoveryKdf,
        wrappedVaultKey: recoveryWrappedVaultKey,
      },
      indexPath: 'vault/index.enc',
      createdAt: new Date().toISOString(),
    },
  };
}

export async function unlockRootKey(password, bootstrap) {
  try {
    const passwordKey = await derivePasswordBits(password, bootstrap.kdf);
    return await aesDecrypt(passwordKey, bootstrap.wrappedVaultKey, ROOT_KEY_AAD);
  } catch (error) {
    throw new Error('Nieprawidłowe hasło albo uszkodzony sejf.', { cause: error });
  }
}

export async function unlockRootKeyWithRecovery(recoveryCode, bootstrap) {
  const recoveryKey = await derivePasswordBits(recoveryCode, bootstrap.recovery.kdf);
  return aesDecrypt(recoveryKey, bootstrap.recovery.wrappedVaultKey, RECOVERY_KEY_AAD);
}

export async function createEncryptedExport(password, payload) {
  const kdf = {
    ...DEFAULT_KDF,
    salt: bytesToBase64(randomBytes(16)),
  };
  const key = await derivePasswordBits(password, kdf);
  const encrypted = await aesEncrypt(key, encodeJson(payload), EXPORT_AAD);
  return {
    format: 'friends-calendar-encrypted-export',
    schema: 1,
    kdf,
    payload: encrypted,
    exportId: randomId('exp_'),
    createdAt: new Date().toISOString(),
  };
}

export async function decryptExport(password, container) {
  if (container?.format !== 'friends-calendar-encrypted-export' || container.schema !== 1) {
    throw new Error('Nieobsługiwany plik eksportu.');
  }
  const key = await derivePasswordBits(password, container.kdf);
  const bytes = await aesDecrypt(key, container.payload, EXPORT_AAD);
  return decodeJson(bytes);
}

export function wipeBytes(bytes) {
  if (bytes instanceof Uint8Array) bytes.fill(0);
}
