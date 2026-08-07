import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBootstrap,
  createEncryptedExport,
  decryptExport,
  decryptFile,
  decryptJsonFile,
  encryptFile,
  encryptJsonFile,
  randomBytes,
  unlockRootKey,
  unlockRootKeyWithRecovery,
} from '../app/src/crypto.js';

const password = 'testowe-haslo-ktore-jest-dlugie';

test('sejf otwiera się hasłem i kodem odzyskiwania', async () => {
  const rootKey = randomBytes(32);
  const { bootstrap, recoveryCode } = await createBootstrap(password, { rootKey });
  const unlocked = await unlockRootKey(password, bootstrap);
  const recovered = await unlockRootKeyWithRecovery(recoveryCode, bootstrap);
  assert.deepEqual([...unlocked], [...rootKey]);
  assert.deepEqual([...recovered], [...rootKey]);
  await assert.rejects(() => unlockRootKey('bledne-haslo-testowe', bootstrap), /Nieprawidłowe hasło/);
});

test('AES-GCM wykrywa zmianę ścieżki i zachowuje typ pliku', async () => {
  const rootKey = randomBytes(32);
  const bytes = new TextEncoder().encode('tajne zdjęcie i emoji 🙂');
  const path = 'vault/avatars/example.enc';
  const encrypted = await encryptFile(rootKey, path, bytes, 'image/webp');
  const decrypted = await decryptFile(rootKey, path, encrypted);
  assert.equal(new TextDecoder().decode(decrypted.bytes), 'tajne zdjęcie i emoji 🙂');
  assert.equal(decrypted.contentType, 'image/webp');
  await assert.rejects(() => decryptFile(rootKey, 'vault/avatars/other.enc', encrypted));
});

test('zaszyfrowany JSON i eksport profilu zachowują Unicode', async () => {
  const rootKey = randomBytes(32);
  const value = { name: 'Łukasz 🌸', note: 'Po pracy 🙂', hours: ['18:00', '22:00'] };
  const encrypted = await encryptJsonFile(rootKey, 'vault/index.enc', value);
  assert.deepEqual(await decryptJsonFile(rootKey, 'vault/index.enc', encrypted), value);

  const container = await createEncryptedExport('inne-dlugie-haslo', value);
  assert.deepEqual(await decryptExport('inne-dlugie-haslo', container), value);
  await assert.rejects(() => decryptExport('zle-haslo-eksportu', container));
});
