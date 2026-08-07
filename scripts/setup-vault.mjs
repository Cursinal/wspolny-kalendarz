import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bytesToBase64,
  createBootstrap,
  encodeJson,
  encryptJsonFile,
  normalizePassword,
  randomBytes,
} from '../app/src/crypto.js';
import { createInitialIndex } from '../app/src/vault.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(projectRoot, 'generated-vault');
const secretsPath = resolve(projectRoot, 'worker-secrets.generated.env');
const recoveryPath = resolve(projectRoot, 'recovery-code.generated.txt');
const force = process.argv.includes('--force');
let pipedAnswersPromise = null;
let pipedAnswerIndex = 0;

async function nextPipedAnswer() {
  if (!pipedAnswersPromise) {
    pipedAnswersPromise = (async () => {
      let input = '';
      for await (const chunk of stdin) input += chunk;
      return input.split(/\r?\n/);
    })();
  }
  const answers = await pipedAnswersPromise;
  return answers[pipedAnswerIndex++] ?? '';
}

async function askLine(label, defaultValue = '') {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  if (!stdin.isTTY) {
    stdout.write(`${label}${suffix}: `);
    const answer = await nextPipedAnswer();
    return answer.trim() || defaultValue;
  }
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(`${label}${suffix}: `);
    return answer.trim() || defaultValue;
  } finally {
    rl.close();
  }
}

async function askHidden(label) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    stdout.write(`${label}: `);
    return nextPipedAnswer();
  }

  stdout.write(`${label}: `);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return new Promise((resolveValue, reject) => {
    let value = '';
    let finished = false;

    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };

    const finish = () => {
      if (finished) return;
      finished = true;
      cleanup();
      stdout.write('\n');
      resolveValue(value);
    };

    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          cleanup();
          stdout.write('\n');
          reject(new Error('Przerwano konfigurację.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u007f' || character === '\b') {
          if (value) {
            value = Array.from(value).slice(0, -1).join('');
            stdout.write('\b \b');
          }
          continue;
        }
        if (character >= ' ') {
          value += character;
          stdout.write('•');
        }
      }
    };

    stdin.on('data', onData);
  });
}

async function hmacVerifier(rawKey, credential) {
  const key = await crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(normalizePassword(credential)),
  );
  return new Uint8Array(digest);
}

async function main() {
  const password = await askHidden('Wspólne hasło kalendarza');
  if (normalizePassword(password).length < 8) {
    throw new Error('Hasło musi mieć co najmniej 8 znaków. Dłuższa fraza jest bezpieczniejsza.');
  }
  const confirmation = await askHidden('Powtórz wspólne hasło');
  if (password !== confirmation) throw new Error('Hasła nie są takie same.');

  const groupName = await askLine('Nazwa grupy', 'Nasz kalendarz');
  const markingModeAnswer = await askLine(
    'Co zaznaczamy? 1 = kiedy możemy, 2 = kiedy nie możemy',
    '1',
  );
  const markingMode = ['2', 'nie', 'niedostepnosc', 'niedostępność', 'unavailability']
    .includes(markingModeAnswer.trim().toLocaleLowerCase('pl'))
    ? 'unavailability'
    : 'availability';
  const profileText = await askLine('Profile rozdzielone przecinkami', 'Osoba 1, Osoba 2, Osoba 3, Osoba 4');
  const profileNames = profileText.split(/\s*,\s*|\n/).map((value) => value.trim()).filter(Boolean);
  if (!profileNames.length) throw new Error('Dodaj co najmniej jeden profil.');

  if (force) await rm(outputDirectory, { recursive: true, force: true });
  try {
    await mkdir(outputDirectory, { recursive: false });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error('Katalog generated-vault już istnieje. Usuń go albo uruchom skrypt z --force.');
    }
    throw error;
  }
  await mkdir(resolve(outputDirectory, 'vault'), { recursive: true });

  stdout.write('Tworzę klucze i szyfruję sejf…\n');
  const { rootKey, recoveryCode, bootstrap } = await createBootstrap(password);
  const index = createInitialIndex(groupName, profileNames, markingMode);
  const encryptedIndex = await encryptJsonFile(rootKey, bootstrap.indexPath, index);

  await writeFile(resolve(outputDirectory, 'bootstrap.json'), `${JSON.stringify(bootstrap, null, 2)}\n`, { mode: 0o600 });
  await writeFile(resolve(outputDirectory, bootstrap.indexPath), encryptedIndex, { mode: 0o600 });

  const authPepper = randomBytes(32);
  const accessVerifier = await hmacVerifier(authPepper, password);
  const recoveryVerifier = await hmacVerifier(authPepper, recoveryCode);
  const sessionSecret = randomBytes(32);
  const secrets = [
    `AUTH_PEPPER_B64=${bytesToBase64(authPepper)}`,
    `ACCESS_VERIFIER_B64=${bytesToBase64(accessVerifier)}`,
    `RECOVERY_VERIFIER_B64=${bytesToBase64(recoveryVerifier)}`,
    `SESSION_SECRET_B64=${bytesToBase64(sessionSecret)}`,
    '',
  ].join('\n');
  await writeFile(secretsPath, secrets, { mode: 0o600 });
  await chmod(secretsPath, 0o600).catch(() => {});
  await writeFile(
    recoveryPath,
    `Kod odzyskiwania kalendarza:\n\n${recoveryCode}\n\nPrzechowuj ten plik poza repozytorium GitHub.\n`,
    { mode: 0o600 },
  );
  await chmod(recoveryPath, 0o600).catch(() => {});

  rootKey.fill(0);
  authPepper.fill(0);
  accessVerifier.fill(0);
  recoveryVerifier.fill(0);
  sessionSecret.fill(0);

  stdout.write('\nGotowe. Utworzono:\n');
  stdout.write('  generated-vault/bootstrap.json\n');
  stdout.write('  generated-vault/vault/index.enc\n');
  stdout.write('  worker-secrets.generated.env\n');
  stdout.write('  recovery-code.generated.txt\n\n');
  stdout.write(`Tryb kalendarza: ${markingMode === 'unavailability' ? 'zaznaczamy, kiedy nie możemy' : 'zaznaczamy, kiedy możemy'}\n`);
  stdout.write('Pliki z sekretami są objęte .gitignore. Nie dodawaj ich do repozytorium.\n');
}

main().catch((error) => {
  console.error(`\nBłąd: ${error.message}`);
  process.exitCode = 1;
});
