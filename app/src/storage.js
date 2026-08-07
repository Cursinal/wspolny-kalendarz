import { createRandomUuid } from './platform-crypto.js';
import { base64ToBytes, bytesToBase64 } from './crypto.js';

export class ConflictError extends Error {
  constructor(message = 'Dane zostały zmienione na innym urządzeniu.', currentRevision = null) {
    super(message);
    this.name = 'ConflictError';
    this.currentRevision = currentRevision;
  }
}

export class StorageError extends Error {
  constructor(message, status = 0, cause) {
    super(message, { cause });
    this.name = 'StorageError';
    this.status = status;
  }
}

function normalizeApiBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new StorageError('Serwer zwrócił nieprawidłową odpowiedź.', response.status);
  }
}

export class RemoteStorage {
  constructor(apiBaseUrl) {
    this.apiBaseUrl = normalizeApiBaseUrl(apiBaseUrl);
    this.token = null;
  }

  get mode() {
    return 'remote';
  }

  async login(credential, kind = 'password') {
    const response = await fetch(`${this.apiBaseUrl}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ credential, kind }),
    });
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      if (response.status === 429) throw new StorageError('Za dużo prób. Spróbuj ponownie później.', response.status);
      throw new StorageError(payload.error || 'Nie udało się odblokować aplikacji.', response.status);
    }
    this.token = payload.token;
  }

  logout() {
    this.token = null;
  }

  async request(path, options = {}) {
    if (!this.token) throw new StorageError('Sesja wygasła. Odblokuj aplikację ponownie.', 401);
    const headers = new Headers(options.headers || {});
    headers.set('authorization', `Bearer ${this.token}`);
    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      ...options,
      headers,
      cache: 'no-store',
    });
    if (response.status === 401) this.token = null;
    return response;
  }

  async get(path) {
    const response = await this.request(`/api/vault?path=${encodeURIComponent(path)}`);
    if (response.status === 404) return null;
    const payload = await parseJsonResponse(response);
    if (!response.ok) throw new StorageError(payload.error || 'Nie udało się pobrać danych.', response.status);
    return {
      bytes: base64ToBytes(payload.contentBase64),
      revision: payload.revision || null,
    };
  }

  async put(path, bytes, expectedRevision = null) {
    const response = await this.request('/api/vault', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path,
        contentBase64: bytesToBase64(bytes),
        expectedRevision,
      }),
    });
    const payload = await parseJsonResponse(response);
    if (response.status === 409) {
      throw new ConflictError(payload.error, payload.currentRevision || null);
    }
    if (!response.ok) throw new StorageError(payload.error || 'Nie udało się zapisać danych.', response.status);
    return { revision: payload.revision || null };
  }

  async delete(path, expectedRevision) {
    const response = await this.request('/api/vault', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, expectedRevision }),
    });
    if (response.status === 404) return;
    const payload = await parseJsonResponse(response);
    if (response.status === 409) throw new ConflictError(payload.error, payload.currentRevision || null);
    if (!response.ok) throw new StorageError(payload.error || 'Nie udało się usunąć pliku.', response.status);
  }
}

const DB_NAME = 'friends-calendar-vault';
const STORE_NAME = 'files';
const DB_VERSION = 1;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, callback) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const store = transaction.objectStore(STORE_NAME);
      const result = callback(store, resolve, reject);
      transaction.onerror = () => reject(transaction.error);
      if (result !== undefined) resolve(result);
    });
  } finally {
    db.close();
  }
}

function idbGet(key) {
  return withStore('readonly', (store, resolve, reject) => {
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

function idbPut(key, value) {
  return withStore('readwrite', (store, resolve, reject) => {
    const request = store.put(value, key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function idbDelete(key) {
  return withStore('readwrite', (store, resolve, reject) => {
    const request = store.delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export class IndexedDbStorage {
  get mode() {
    return 'local';
  }

  async login() {}

  logout() {}

  async get(path) {
    const record = await idbGet(path);
    if (!record) return null;
    return {
      bytes: new Uint8Array(record.bytes),
      revision: record.revision,
    };
  }

  async put(path, bytes, expectedRevision = null) {
    const current = await idbGet(path);
    if (expectedRevision !== null && current?.revision !== expectedRevision) {
      throw new ConflictError(undefined, current?.revision ?? null);
    }
    if (expectedRevision === null && current) {
      throw new ConflictError(undefined, current.revision);
    }
    const revision = `${Date.now()}-${createRandomUuid()}`;
    await idbPut(path, { bytes: bytes.slice().buffer, revision });
    return { revision };
  }

  async delete(path, expectedRevision) {
    const current = await idbGet(path);
    if (!current) return;
    if (expectedRevision && current.revision !== expectedRevision) {
      throw new ConflictError(undefined, current.revision);
    }
    await idbDelete(path);
  }
}

export function createStorage(apiBaseUrl) {
  return normalizeApiBaseUrl(apiBaseUrl)
    ? new RemoteStorage(apiBaseUrl)
    : new IndexedDbStorage();
}
