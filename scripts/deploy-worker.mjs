import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const generatedSecretFile = resolve(projectRoot, 'worker-secrets.generated.env');
const configFile = resolve(projectRoot, 'worker', 'wrangler.jsonc');
const requiredGeneratedNames = [
  'AUTH_PEPPER_B64',
  'ACCESS_VERIFIER_B64',
  'RECOVERY_VERIFIER_B64',
  'SESSION_SECRET_B64',
];

function parseEnv(text) {
  return Object.fromEntries(text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const separator = line.indexOf('=');
      if (separator < 1) return ['', ''];
      return [line.slice(0, separator), line.slice(separator + 1)];
    })
    .filter(([name, value]) => name && value));
}

function runWrangler(secretFile) {
  const wranglerArgs = [
    '--yes',
    'wrangler@latest',
    'deploy',
    '--config',
    configFile,
    '--secrets-file',
    secretFile,
  ];
  const windows = process.platform === 'win32';
  const npmCliDirectory = process.env.npm_execpath
    ? dirname(process.env.npm_execpath)
    : resolve(dirname(process.execPath), 'node_modules', 'npm', 'bin');
  const command = windows ? process.execPath : 'npx';
  const args = windows
    ? [resolve(npmCliDirectory, 'npx-cli.js'), ...wranglerArgs]
    : wranglerArgs;
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(`Wrangler zakończył wdrożenie kodem ${code}.`));
    });
  });
}

async function main() {
  const githubToken = process.env.GITHUB_TOKEN?.trim();
  if (!githubToken) {
    throw new Error('Brak GITHUB_TOKEN w zmiennych środowiskowych. Token nie może trafić do pliku konfiguracyjnego.');
  }

  const generated = parseEnv(await readFile(generatedSecretFile, 'utf8'));
  const missing = requiredGeneratedNames.filter((name) => !generated[name]);
  if (missing.length) {
    throw new Error(`Plik sekretów jest niepełny (${missing.join(', ')}). Uruchom npm run setup:vault.`);
  }

  const secrets = {
    GITHUB_TOKEN: githubToken,
    ...Object.fromEntries(requiredGeneratedNames.map((name) => [name, generated[name]])),
  };

  const tempDirectory = await mkdtemp(join(tmpdir(), 'wspolny-kalendarz-secrets-'));
  const tempSecretFile = join(tempDirectory, 'secrets.json');
  try {
    await writeFile(tempSecretFile, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
    console.log('Wdrażam Worker i przekazuję komplet sekretów bez zapisywania tokenu w projekcie…');
    await runWrangler(tempSecretFile);
    console.log('Worker został wdrożony. Tymczasowy plik sekretów został usunięty.');
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Błąd: ${error.message}`);
  process.exitCode = 1;
});
