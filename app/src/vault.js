import {
  bytesToBase64,
  createBootstrap,
  decodeJson,
  decryptFile,
  decryptJsonFile,
  deriveOpaqueId,
  encodeJson,
  encryptFile,
  encryptJsonFile,
  unlockRootKey,
  unlockRootKeyWithRecovery,
  wipeBytes,
} from './crypto.js';
import { monthKeyFromDateKey, normalizeCalendarMode } from './calendar.js';
import { ConflictError } from './storage.js';
import { normalizeHexColor, randomId } from './utils.js';

const PROFILE_COLORS = ['#ff7aa8', '#62d0ff', '#84e19a', '#ffbf69', '#b79cff', '#f27676', '#43d8c9', '#ffd166'];
const PROFILE_EMOJIS = ['🙂', '🌸', '🫶', '✨', '🌙', '🪩', '🍓', '🐈'];

function clone(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeIndex(index) {
  const normalized = clone(index);
  normalized.group = {
    ...(normalized.group || {}),
    markingMode: normalizeCalendarMode(normalized.group?.markingMode),
  };
  normalized.profiles = Array.isArray(normalized.profiles) ? normalized.profiles : [];
  normalized.monthFiles = normalized.monthFiles || {};
  return normalized;
}

function emptyMonth(month) {
  return {
    schema: 1,
    month,
    entries: {},
    updatedAt: nowIso(),
  };
}

function profileTimestamp(profile) {
  return Date.parse(profile?.updatedAt || profile?.createdAt || 0) || 0;
}

function mergeProfiles(remoteProfiles = [], localProfiles = []) {
  const result = new Map();
  for (const profile of remoteProfiles) result.set(profile.id, profile);
  for (const profile of localProfiles) {
    const existing = result.get(profile.id);
    if (!existing || profileTimestamp(profile) >= profileTimestamp(existing)) result.set(profile.id, profile);
  }
  return [...result.values()];
}

function mergeIndexes(remote, local) {
  return {
    ...remote,
    ...local,
    group: (Date.parse(local.group?.updatedAt || 0) >= Date.parse(remote.group?.updatedAt || 0))
      ? local.group
      : remote.group,
    profiles: mergeProfiles(remote.profiles, local.profiles),
    monthFiles: { ...(remote.monthFiles || {}), ...(local.monthFiles || {}) },
    updatedAt: nowIso(),
  };
}

function recordTimestamp(record) {
  return Date.parse(record?.updatedAt || 0) || 0;
}

function recordsEqual(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function chooseConcurrentRecord(remoteRecord, localRecord) {
  const remoteTime = recordTimestamp(remoteRecord);
  const localTime = recordTimestamp(localRecord);
  if (localTime !== remoteTime) return localTime > remoteTime ? localRecord : remoteRecord;
  const remoteValue = JSON.stringify(remoteRecord ?? null);
  const localValue = JSON.stringify(localRecord ?? null);
  return localValue >= remoteValue ? localRecord : remoteRecord;
}

function recordAt(monthData, date, profileId) {
  return monthData?.entries?.[date]?.[profileId];
}

function mergeMonths(remote, local, base = { entries: {} }) {
  const entries = {};
  const dates = new Set([
    ...Object.keys(base.entries || {}),
    ...Object.keys(remote.entries || {}),
    ...Object.keys(local.entries || {}),
  ]);

  for (const date of dates) {
    const profileIds = new Set([
      ...Object.keys(base.entries?.[date] || {}),
      ...Object.keys(remote.entries?.[date] || {}),
      ...Object.keys(local.entries?.[date] || {}),
    ]);
    const day = {};
    for (const profileId of profileIds) {
      const baseRecord = recordAt(base, date, profileId);
      const remoteRecord = recordAt(remote, date, profileId);
      const localRecord = recordAt(local, date, profileId);
      const localChanged = !recordsEqual(localRecord, baseRecord);
      const remoteChanged = !recordsEqual(remoteRecord, baseRecord);

      let chosen;
      if (localChanged && remoteChanged) {
        chosen = recordsEqual(localRecord, remoteRecord)
          ? localRecord
          : chooseConcurrentRecord(remoteRecord, localRecord);
      } else if (localChanged) {
        chosen = localRecord;
      } else {
        chosen = remoteRecord;
      }
      if (chosen !== undefined && chosen !== null) day[profileId] = chosen;
    }
    if (Object.keys(day).length) entries[date] = day;
  }

  return {
    schema: 1,
    month: local.month || remote.month,
    entries,
    updatedAt: nowIso(),
  };
}

export function createProfile(name, index = 0) {
  const timestamp = nowIso();
  return {
    id: randomId('profile_'),
    name: String(name || `Osoba ${index + 1}`).trim().slice(0, 40),
    color: PROFILE_COLORS[index % PROFILE_COLORS.length],
    theme: 'black',
    avatar: {
      kind: 'emoji',
      emoji: PROFILE_EMOJIS[index % PROFILE_EMOJIS.length],
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createInitialIndex(groupName, profileNames = [], markingMode = 'availability') {
  const timestamp = nowIso();
  return {
    schema: 1,
    group: {
      name: String(groupName || 'Nasz kalendarz').trim().slice(0, 60),
      timeZone: 'Europe/Warsaw',
      markingMode: normalizeCalendarMode(markingMode),
      updatedAt: timestamp,
    },
    profiles: profileNames.filter(Boolean).map((name, index) => createProfile(name, index)),
    monthFiles: {},
    updatedAt: timestamp,
  };
}

export class MissingVaultError extends Error {
  constructor() {
    super('Sejf nie został jeszcze utworzony.');
    this.name = 'MissingVaultError';
  }
}

export class Vault {
  constructor(storage) {
    this.storage = storage;
    this.bootstrap = null;
    this.rootKey = null;
    this.index = null;
    this.indexRevision = null;
    this.monthCache = new Map();
  }

  get isUnlocked() {
    return this.rootKey instanceof Uint8Array && Boolean(this.index);
  }

  async exists() {
    return Boolean(await this.storage.get('bootstrap.json'));
  }

  async unlock(password) {
    return this.unlockWithCredential(password, 'password');
  }

  async unlockWithRecovery(recoveryCode) {
    return this.unlockWithCredential(recoveryCode, 'recovery');
  }

  async unlockWithCredential(credential, kind) {
    await this.storage.login(credential, kind);
    const bootstrapRecord = await this.storage.get('bootstrap.json');
    if (!bootstrapRecord) throw new MissingVaultError();
    const bootstrap = decodeJson(bootstrapRecord.bytes);
    let rootKey;
    try {
      rootKey = kind === 'recovery'
        ? await unlockRootKeyWithRecovery(credential, bootstrap)
        : await unlockRootKey(credential, bootstrap);
    } catch (error) {
      this.storage.logout();
      if (kind === 'recovery') throw new Error('Nieprawidłowy kod odzyskiwania albo uszkodzony sejf.', { cause: error });
      throw error;
    }
    const indexRecord = await this.storage.get(bootstrap.indexPath);
    if (!indexRecord) throw new Error('Brakuje zaszyfrowanego indeksu sejfu.');
    const index = await decryptJsonFile(rootKey, bootstrap.indexPath, indexRecord.bytes);
    if (index.schema !== 1) throw new Error('Nieobsługiwana wersja danych kalendarza.');

    this.bootstrap = bootstrap;
    this.rootKey = rootKey;
    this.index = normalizeIndex(index);
    this.indexRevision = indexRecord.revision;
    this.monthCache.clear();
    return this.index;
  }

  async create(password, groupName, profileNames, markingMode = 'availability') {
    if (await this.exists()) throw new Error('Sejf już istnieje.');
    await this.storage.login(password);
    const { rootKey, recoveryCode, bootstrap } = await createBootstrap(password);
    const index = createInitialIndex(groupName, profileNames, markingMode);
    const encryptedIndex = await encryptJsonFile(rootKey, bootstrap.indexPath, index);
    const indexWrite = await this.storage.put(bootstrap.indexPath, encryptedIndex, null);
    await this.storage.put('bootstrap.json', encodeJson(bootstrap), null);

    this.bootstrap = bootstrap;
    this.rootKey = rootKey;
    this.index = index;
    this.indexRevision = indexWrite.revision;
    this.monthCache.clear();
    return { recoveryCode, index };
  }

  requireUnlocked() {
    if (!this.isUnlocked) throw new Error('Sejf jest zablokowany.');
  }

  profile(profileId) {
    return this.index?.profiles.find((profile) => profile.id === profileId) || null;
  }

  async refreshIndex() {
    this.requireUnlocked();
    const record = await this.storage.get(this.bootstrap.indexPath);
    if (!record) throw new Error('Nie znaleziono indeksu sejfu.');
    this.index = normalizeIndex(await decryptJsonFile(this.rootKey, this.bootstrap.indexPath, record.bytes));
    this.indexRevision = record.revision;
    return this.index;
  }

  async saveIndex(nextIndex = this.index) {
    this.requireUnlocked();
    const local = normalizeIndex({ ...clone(nextIndex), updatedAt: nowIso() });
    const path = this.bootstrap.indexPath;
    const encrypted = await encryptJsonFile(this.rootKey, path, local);

    try {
      const result = await this.storage.put(path, encrypted, this.indexRevision);
      this.index = local;
      this.indexRevision = result.revision;
      return this.index;
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      const remoteRecord = await this.storage.get(path);
      if (!remoteRecord) throw error;
      const remote = normalizeIndex(await decryptJsonFile(this.rootKey, path, remoteRecord.bytes));
      const merged = normalizeIndex(mergeIndexes(remote, local));
      const retryBytes = await encryptJsonFile(this.rootKey, path, merged);
      const result = await this.storage.put(path, retryBytes, remoteRecord.revision);
      this.index = merged;
      this.indexRevision = result.revision;
      return this.index;
    }
  }

  async addProfile(name) {
    this.requireUnlocked();
    const profile = createProfile(name, this.index.profiles.length);
    const next = clone(this.index);
    next.profiles.push(profile);
    await this.saveIndex(next);
    return profile;
  }

  async updateProfile(profileId, patch) {
    this.requireUnlocked();
    const next = clone(this.index);
    const position = next.profiles.findIndex((profile) => profile.id === profileId);
    if (position < 0) throw new Error('Nie znaleziono profilu.');
    const current = next.profiles[position];
    const updated = {
      ...current,
      ...patch,
      color: normalizeHexColor(patch.color ?? current.color, current.color),
      avatar: patch.avatar ?? current.avatar,
      updatedAt: nowIso(),
    };
    next.profiles[position] = updated;
    await this.saveIndex(next);
    return this.profile(profileId);
  }

  async loadMonth(month, force = false) {
    this.requireUnlocked();
    if (!force && this.monthCache.has(month)) return clone(this.monthCache.get(month).data);
    const path = this.index.monthFiles?.[month];
    if (!path) {
      const data = emptyMonth(month);
      this.monthCache.set(month, { path: null, revision: null, data });
      return clone(data);
    }
    const record = await this.storage.get(path);
    if (!record) {
      const data = emptyMonth(month);
      this.monthCache.set(month, { path, revision: null, data });
      return clone(data);
    }
    const data = await decryptJsonFile(this.rootKey, path, record.bytes);
    this.monthCache.set(month, { path, revision: record.revision, data });
    return clone(data);
  }

  async saveMonth(month, nextMonthData) {
    this.requireUnlocked();
    const local = {
      ...clone(nextMonthData),
      schema: 1,
      month,
      updatedAt: nowIso(),
    };
    const cached = this.monthCache.get(month) || { path: this.index.monthFiles?.[month] || null, revision: null };
    const path = cached.path
      || this.index.monthFiles?.[month]
      || `vault/months/${await deriveOpaqueId(this.rootKey, 'month', month)}.enc`;
    let dataToKeep = local;
    let revision;

    try {
      const encrypted = await encryptJsonFile(this.rootKey, path, local);
      const result = await this.storage.put(path, encrypted, cached.revision);
      revision = result.revision;
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      const remoteRecord = await this.storage.get(path);
      if (!remoteRecord) throw error;
      const remote = await decryptJsonFile(this.rootKey, path, remoteRecord.bytes);
      dataToKeep = mergeMonths(remote, local, cached.data || emptyMonth(month));
      const encrypted = await encryptJsonFile(this.rootKey, path, dataToKeep);
      const result = await this.storage.put(path, encrypted, remoteRecord.revision);
      revision = result.revision;
    }

    this.monthCache.set(month, { path, revision, data: dataToKeep });
    if (this.index.monthFiles?.[month] !== path) {
      const nextIndex = clone(this.index);
      nextIndex.monthFiles = { ...(nextIndex.monthFiles || {}), [month]: path };
      await this.saveIndex(nextIndex);
    }
    return clone(dataToKeep);
  }

  async setAvailability(profileId, datePlans) {
    this.requireUnlocked();
    const grouped = new Map();
    for (const [date, plan] of Object.entries(datePlans)) {
      const month = monthKeyFromDateKey(date);
      if (!grouped.has(month)) grouped.set(month, {});
      grouped.get(month)[date] = plan;
    }

    for (const [month, changes] of grouped) {
      const data = await this.loadMonth(month);
      for (const [date, plan] of Object.entries(changes)) {
        const day = { ...(data.entries[date] || {}) };
        if (!plan || plan.available === false) {
          day[profileId] = {
            available: false,
            allDay: false,
            intervals: [],
            note: '',
            updatedAt: nowIso(),
          };
        } else {
          day[profileId] = {
            available: true,
            allDay: Boolean(plan.allDay),
            intervals: plan.allDay ? [] : clone(plan.intervals || []),
            note: String(plan.note || '').slice(0, 240),
            updatedAt: nowIso(),
          };
        }
        data.entries[date] = day;
      }
      await this.saveMonth(month, data);
    }
  }

  async saveAvatar(profileId, avatarBytes, contentType) {
    this.requireUnlocked();
    const current = this.profile(profileId);
    if (!current) throw new Error('Nie znaleziono profilu.');
    const oldAvatar = current.avatar?.kind === 'file' ? clone(current.avatar) : null;
    const path = `vault/avatars/${randomId()}.enc`;
    const encrypted = await encryptFile(this.rootKey, path, avatarBytes, contentType);
    await this.storage.put(path, encrypted, null);
    const updated = await this.updateProfile(profileId, {
      avatar: { kind: 'file', path, contentType },
    });
    if (oldAvatar?.path) this.deleteFileBestEffort(oldAvatar.path);
    return updated;
  }

  async removeAvatar(profileId, emoji = '🙂') {
    const current = this.profile(profileId);
    const oldPath = current?.avatar?.kind === 'file' ? current.avatar.path : null;
    const updated = await this.updateProfile(profileId, {
      avatar: { kind: 'emoji', emoji: String(emoji || '🙂').slice(0, 8) },
    });
    if (oldPath) this.deleteFileBestEffort(oldPath);
    return updated;
  }

  async deleteFileBestEffort(path) {
    try {
      const record = await this.storage.get(path);
      if (record) await this.storage.delete(path, record.revision);
    } catch {
      // Git keeps old encrypted revisions anyway. An orphaned encrypted file is harmless.
    }
  }

  async readAvatar(profile) {
    this.requireUnlocked();
    if (profile?.avatar?.kind !== 'file') return null;
    const record = await this.storage.get(profile.avatar.path);
    if (!record) return null;
    return decryptFile(this.rootKey, profile.avatar.path, record.bytes);
  }

  async buildProfilesExport(profileIds, options = {}) {
    this.requireUnlocked();
    const selected = this.index.profiles.filter((profile) => profileIds.includes(profile.id));
    const payload = {
      format: profileIds.length === 1 ? 'friends-calendar-profile' : 'friends-calendar-profiles',
      schema: 1,
      createdAt: nowIso(),
      group: {
        name: this.index.group.name,
        timeZone: this.index.group.timeZone,
        markingMode: normalizeCalendarMode(this.index.group.markingMode),
      },
      profiles: clone(selected),
      avatars: [],
      availability: [],
    };

    if (options.includeAvatars !== false) {
      for (const profile of selected) {
        const avatar = await this.readAvatar(profile);
        if (!avatar) continue;
        payload.avatars.push({
          profileId: profile.id,
          contentType: avatar.contentType,
          dataBase64: bytesToBase64(avatar.bytes),
        });
      }
    }

    if (options.includeAvailability) {
      for (const month of Object.keys(this.index.monthFiles || {}).sort()) {
        const monthData = await this.loadMonth(month);
        const entries = {};
        for (const [date, day] of Object.entries(monthData.entries || {})) {
          const selectedDay = {};
          for (const profileId of profileIds) {
            if (day[profileId] && day[profileId].available !== false) selectedDay[profileId] = clone(day[profileId]);
          }
          if (Object.keys(selectedDay).length) entries[date] = selectedDay;
        }
        if (Object.keys(entries).length) payload.availability.push({ month, entries });
      }
    }

    return payload;
  }

  lock() {
    wipeBytes(this.rootKey);
    this.rootKey = null;
    this.bootstrap = null;
    this.index = null;
    this.indexRevision = null;
    this.monthCache.clear();
    this.storage.logout();
  }
}
