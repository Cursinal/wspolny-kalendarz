import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { base64ToBytes, decryptExport } from '../app/src/crypto.js';
import { sanitizeFilename } from '../app/src/utils.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function askHidden(label) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    const rl = createInterface({ input: stdin, output: stdout });
    try { return await rl.question(`${label}: `); } finally { rl.close(); }
  }
  stdout.write(`${label}: `);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolveValue, reject) => {
    let value = '';
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          cleanup();
          stdout.write('\n');
          reject(new Error('Przerwano odszyfrowywanie.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          stdout.write('\n');
          resolveValue(value);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          if (value) {
            value = Array.from(value).slice(0, -1).join('');
            stdout.write('\b \b');
          }
        } else if (character >= ' ') {
          value += character;
          stdout.write('•');
        }
      }
    };
    stdin.on('data', onData);
  });
}

function extensionFor(contentType) {
  const map = {
    'image/webp': '.webp',
    'image/jpeg': '.jpg',
    'image/png': '.png',
  };
  return map[contentType] || '.bin';
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error('Użycie: npm run decrypt:export -- sciezka-do-pliku.kalendarz.enc.json');
  const container = JSON.parse(await readFile(resolve(inputPath), 'utf8'));
  const password = await askHidden('Hasło eksportu');
  const payload = await decryptExport(password, container);
  const base = sanitizeFilename(basename(inputPath, extname(inputPath)), 'eksport');
  const output = resolve(projectRoot, 'decrypted-export', `${base}-${Date.now()}`);
  await mkdir(resolve(output, 'avatars'), { recursive: true });

  const profileNames = new Map((payload.profiles || []).map((profile) => [profile.id, profile.name]));
  for (const avatar of payload.avatars || []) {
    const profileName = sanitizeFilename(profileNames.get(avatar.profileId) || avatar.profileId, 'profil');
    await writeFile(
      resolve(output, 'avatars', `${profileName}${extensionFor(avatar.contentType)}`),
      base64ToBytes(avatar.dataBase64),
      { mode: 0o600 },
    );
  }
  const cleanPayload = {
    ...payload,
    avatars: (payload.avatars || []).map(({ profileId, contentType }) => ({ profileId, contentType, extracted: true })),
  };
  await writeFile(resolve(output, 'profiles.json'), `${JSON.stringify(cleanPayload, null, 2)}\n`, { mode: 0o600 });
  console.log(`Odszyfrowano do: ${output}`);
}

main().catch((error) => {
  console.error(`Błąd: ${error.message}`);
  process.exitCode = 1;
});
