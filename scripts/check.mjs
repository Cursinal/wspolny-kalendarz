import { access, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ignored = new Set(['.git', 'node_modules', 'generated-vault', 'decrypted-export', '.wrangler']);

async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path));
    else result.push(path);
  }
  return result;
}

async function ensureFile(path) {
  await access(resolve(root, path), constants.R_OK);
}

async function main() {
  const required = [
    'app/index.html',
    'app/styles.css',
    'app/config.js',
    'app/src/main.js',
    'worker/src/index.js',
    'worker/wrangler.jsonc',
    'README.md',
  ];
  await Promise.all(required.map(ensureFile));

  const files = await walk(root);
  const scripts = files.filter((path) => ['.js', '.mjs'].includes(extname(path)));
  for (const path of scripts) {
    const check = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    if (check.status !== 0) throw new Error(`Błąd składni w ${relative(root, path)}:\n${check.stderr}`);
  }

  const css = await readFile(resolve(root, 'app/styles.css'), 'utf8');
  if (/gradient\s*\(/i.test(css)) throw new Error('W arkuszu stylów znaleziono gradient.');
  const html = await readFile(resolve(root, 'app/index.html'), 'utf8');
  if (/<script(?![^>]+src=)[^>]*>/i.test(html)) throw new Error('HTML zawiera skrypt inline, którego zabrania CSP.');
  JSON.parse(await readFile(resolve(root, 'app/manifest.webmanifest'), 'utf8'));
  JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  JSON.parse(await readFile(resolve(root, 'worker/package.json'), 'utf8'));

  console.log(`Kontrola zakończona: ${scripts.length} plików JavaScript ma poprawną składnię.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
