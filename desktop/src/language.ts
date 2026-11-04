import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isLanguage, type Language } from '@orrery/shared';

export async function readLanguage(userData: string): Promise<Language | undefined> {
  try {
    const value = JSON.parse(await readFile(join(userData, 'language.json'), 'utf8'));
    return isLanguage(value.language) ? value.language : undefined;
  } catch { return undefined; }
}

export async function saveLanguage(userData: string, language: Language): Promise<void> {
  if (!isLanguage(language)) return;
  const destination = join(userData, 'language.json');
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ language }), { mode: 0o600, flag: 'wx' });
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
}
