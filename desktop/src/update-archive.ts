import { createWriteStream } from 'node:fs';
import { mkdir, realpath, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { open, type Entry, type ZipFile } from 'yauzl';

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Extract regular files first, then internal macOS framework symlinks. Never write through archive links. */
export async function extractUpdate(zipPath: string, directory: string, platform: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  directory = await realpath(directory);
  const rootName = platform === 'darwin' ? 'Orrery.app' : 'Orrery';
  const root = join(directory, rootName);
  const zip = await new Promise<ZipFile>((resolve, reject) => open(zipPath, { lazyEntries: true, strictFileNames: true }, (error, zip) => error ? reject(error) : resolve(zip)));
  const links: Array<{ path: string; target: string }> = [];
  const seen = new Set<string>();
  let total = 0;
  try {
    await new Promise<void>((resolveDone, reject) => {
      zip.on('error', reject);
      zip.on('end', resolveDone);
      zip.on('entry', (entry: Entry) => {
        void (async () => {
          signal?.throwIfAborted();
          const name = entry.fileName.replace(/\/$/, '');
          const parts = name.split('/');
          const key = name.normalize('NFC').toLowerCase();
          if (parts[0] !== rootName || parts.some((part) => !part || part === '.' || part === '..' || /[\\:\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) || seen.has(key)) {
            throw new Error('ZIP에 중복되거나 허용되지 않은 경로가 있습니다.');
          }
          seen.add(key);
          total += entry.uncompressedSize;
          if (seen.size > 40_000 || total > 2 * 1024 ** 3 || entry.isEncrypted()) throw new Error('업데이트 ZIP의 용량·항목 제한을 초과했거나 암호화되어 있습니다.');
          const dest = join(directory, ...parts);
          const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
          const kind = mode & 0o170000;
          if (entry.fileName.endsWith('/') || kind === 0o040000) {
            await mkdir(dest, { recursive: true, mode: 0o755 });
            return;
          }
          if (![0, 0o100000, 0o120000].includes(kind)) throw new Error('ZIP에 일반 파일이 아닌 항목이 있습니다.');
          await mkdir(dirname(dest), { recursive: true, mode: 0o755 });
          const stream = await new Promise<NodeJS.ReadableStream>((resolveStream, rejectStream) => zip.openReadStream(entry, (error, stream) => error ? rejectStream(error) : resolveStream(stream)));
          if (kind === 0o120000) {
            if (platform !== 'darwin' || entry.uncompressedSize > 4096) throw new Error('허용되지 않은 심볼릭 링크입니다.');
            const chunks: Buffer[] = [];
            for await (const chunk of stream) { signal?.throwIfAborted(); chunks.push(Buffer.from(chunk)); }
            const target = Buffer.concat(chunks).toString('utf8');
            if (!target || target.includes('\0') || isAbsolute(target) || !inside(root, resolve(dirname(dest), target))) throw new Error('ZIP의 심볼릭 링크가 앱 밖을 가리킵니다.');
            links.push({ path: dest, target });
          } else {
            await pipeline(stream, createWriteStream(dest, { flags: 'wx', mode: (mode & 0o111) ? 0o755 : 0o644 }), { signal });
          }
        })().then(() => zip.readEntry(), reject);
      });
      zip.readEntry();
    });
    for (const link of links) await symlink(link.target, link.path);
    for (const link of links) {
      if (!inside(root, await realpath(link.path))) throw new Error('ZIP의 심볼릭 링크가 앱 밖을 가리킵니다.');
    }
    return root;
  } finally {
    zip.close();
  }
}
