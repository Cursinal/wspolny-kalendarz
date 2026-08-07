import { readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = resolve(projectRoot, 'generated-vault');
const token = process.env.GITHUB_TOKEN;
const owner = process.env.GITHUB_OWNER;
const repo = process.env.GITHUB_REPO;
const branch = process.env.GITHUB_BRANCH || 'main';

function required(value, name) {
  if (!value) throw new Error(`Brakuje zmiennej środowiskowej ${name}.`);
  return value;
}

function apiUrl(path, includeRef = false) {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`;
  return includeRef ? `${base}?ref=${encodeURIComponent(branch)}` : base;
}

function headers(extra = {}) {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'friends-calendar-setup',
    ...extra,
  };
}

async function githubPayload(response) {
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch {}
  return payload;
}

async function currentSha(path) {
  const response = await fetch(apiUrl(path, true), { headers: headers() });
  if (response.status === 404) return null;
  const payload = await githubPayload(response);
  if (!response.ok) throw new Error(`GitHub nie odczytał ${path} (${response.status}): ${payload.message || 'brak opisu'}`);
  return payload.sha || null;
}

async function upload(path, bytes) {
  const sha = await currentSha(path);
  const body = {
    message: 'Initialize encrypted calendar vault',
    content: bytes.toString('base64'),
    branch,
  };
  if (sha) body.sha = sha;
  const response = await fetch(apiUrl(path), {
    method: 'PUT',
    headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
  const payload = await githubPayload(response);
  if (!response.ok) {
    throw new Error(`GitHub nie zapisał ${path} (${response.status}): ${payload.message || 'brak opisu'}`);
  }
  console.log(`✓ ${path}`);
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...await collectFiles(absolute));
    else if (entry.isFile()) result.push(absolute);
  }
  return result;
}

async function main() {
  required(token, 'GITHUB_TOKEN');
  required(owner, 'GITHUB_OWNER');
  required(repo, 'GITHUB_REPO');
  const files = await collectFiles(sourceDirectory);
  if (!files.length) throw new Error('Katalog generated-vault jest pusty. Najpierw uruchom npm run setup:vault.');
  for (const file of files.sort()) {
    const path = relative(sourceDirectory, file).split(sep).join('/');
    if (path !== 'bootstrap.json' && !path.startsWith('vault/')) continue;
    await upload(path, await readFile(file));
  }
  console.log('\nZaszyfrowany sejf został wysłany do prywatnego repozytorium.');
}

main().catch((error) => {
  console.error(`Błąd: ${error.message}`);
  console.error('Repozytorium powinno być prywatne i wcześniej zainicjalizowane, np. plikiem README.');
  process.exitCode = 1;
});
