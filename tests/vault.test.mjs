import test from 'node:test';
import assert from 'node:assert/strict';
import { ConflictError } from '../app/src/storage.js';
import { Vault } from '../app/src/vault.js';

class SharedMemoryStorage {
  constructor(files = new Map()) {
    this.files = files;
    this.counter = 0;
  }

  get mode() { return 'local'; }
  async login() {}
  logout() {}

  async get(path) {
    const record = this.files.get(path);
    if (!record) return null;
    return { bytes: record.bytes.slice(), revision: record.revision };
  }

  async put(path, bytes, expectedRevision = null) {
    const current = this.files.get(path);
    if (expectedRevision === null && current) throw new ConflictError(undefined, current.revision);
    if (expectedRevision !== null && current?.revision !== expectedRevision) {
      throw new ConflictError(undefined, current?.revision ?? null);
    }
    const revision = `r${++this.counter}`;
    this.files.set(path, { bytes: bytes.slice(), revision });
    return { revision };
  }

  async delete(path, expectedRevision) {
    const current = this.files.get(path);
    if (!current) return;
    if (current.revision !== expectedRevision) throw new ConflictError(undefined, current.revision);
    this.files.delete(path);
  }
}

const password = 'bardzo-dlugie-haslo-do-testu';
const plan = (from, to) => ({ available: true, allDay: false, intervals: [{ from, to }], note: '' });

test('równoczesne utworzenie miesiąca łączy wpisy zamiast gubić jeden plik', async () => {
  const sharedFiles = new Map();
  const storageA = new SharedMemoryStorage(sharedFiles);
  const storageB = new SharedMemoryStorage(sharedFiles);
  const vaultA = new Vault(storageA);
  await vaultA.create(password, 'Ekipa', ['Ala', 'Bartek']);
  const vaultB = new Vault(storageB);
  await vaultB.unlock(password);

  const [ala, bartek] = vaultA.index.profiles;
  await Promise.all([
    vaultA.loadMonth('2026-08'),
    vaultB.loadMonth('2026-08'),
  ]);

  await vaultA.setAvailability(ala.id, { '2026-08-12': plan('18:00', '22:00') });
  await vaultB.setAvailability(bartek.id, { '2026-08-12': plan('19:00', '21:00') });

  await vaultA.refreshIndex();
  const month = await vaultA.loadMonth('2026-08', true);
  assert.equal(Object.keys(vaultA.index.monthFiles).length, 1);
  assert.equal(month.entries['2026-08-12'][ala.id].intervals[0].from, '18:00');
  assert.equal(month.entries['2026-08-12'][bartek.id].intervals[0].from, '19:00');
});

test('usunięcie dostępności nie wraca po konflikcie z edycją innego profilu', async () => {
  const sharedFiles = new Map();
  const storageA = new SharedMemoryStorage(sharedFiles);
  const storageB = new SharedMemoryStorage(sharedFiles);
  const vaultA = new Vault(storageA);
  await vaultA.create(password, 'Ekipa', ['Ala', 'Bartek']);
  const vaultB = new Vault(storageB);
  await vaultB.unlock(password);
  const [ala, bartek] = vaultA.index.profiles;

  await vaultA.setAvailability(ala.id, { '2026-08-13': plan('17:00', '20:00') });
  await vaultA.setAvailability(bartek.id, { '2026-08-13': plan('18:00', '22:00') });
  await vaultB.refreshIndex();
  await Promise.all([
    vaultA.loadMonth('2026-08', true),
    vaultB.loadMonth('2026-08', true),
  ]);

  await vaultA.setAvailability(ala.id, { '2026-08-13': { available: false } });
  await vaultB.setAvailability(bartek.id, { '2026-08-13': plan('19:00', '23:00') });

  await vaultA.refreshIndex();
  const month = await vaultA.loadMonth('2026-08', true);
  assert.equal(month.entries['2026-08-13'][ala.id].available, false);
  assert.equal(month.entries['2026-08-13'][bartek.id].intervals[0].from, '19:00');
});


test('tryb zaznaczania niedostępności jest zapisany w zaszyfrowanym indeksie', async () => {
  const storage = new SharedMemoryStorage(new Map());
  const vault = new Vault(storage);
  await vault.create(password, 'Ekipa', ['Ala'], 'unavailability');
  assert.equal(vault.index.group.markingMode, 'unavailability');

  const reopened = new Vault(storage);
  await reopened.unlock(password);
  assert.equal(reopened.index.group.markingMode, 'unavailability');
});
