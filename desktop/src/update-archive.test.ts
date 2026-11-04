import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractUpdate } from './update-archive';

/** Small stored ZIP fixtures, including paths that normal ZIP writers refuse to create. */
function zip(entries: Array<{ name: string; text?: string; mode?: number; size?: number }>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), content = Buffer.from(entry.text ?? 'dummy');
    let crc = 0xffffffff;
    for (const byte of content) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(content.length, 18); header.writeUInt32LE(entry.size ?? content.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, content);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x0314, 4); record.writeUInt16LE(20, 6);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(content.length, 20); record.writeUInt32LE(entry.size ?? content.length, 24); record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38); record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + content.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

async function fixture(entries: Parameters<typeof zip>[0], run: (archive: string, directory: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'orrery-archive-'));
  try {
    const archive = join(dir, 'update.zip');
    await writeFile(archive, zip(entries));
    await run(archive, join(dir, 'extracted'));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('extracts executables and internal framework symlinks without writing through them', async () => {
  await fixture([
    { name: 'Orrery.app/Contents/MacOS/Orrery', mode: 0o100755 },
    { name: 'Orrery.app/Contents/Framework/Versions/A/framework', text: 'framework' },
    { name: 'Orrery.app/Contents/Framework/Versions/Current', mode: 0o120777, text: 'A' },
    { name: 'Orrery.app/Contents/Framework/framework', mode: 0o120777, text: 'Versions/Current/framework' },
  ], async (archive, directory) => {
    const root = await extractUpdate(archive, directory, 'darwin');
    assert.equal(await readFile(join(root, 'Contents/Framework/framework'), 'utf8'), 'framework');
    assert.ok((await stat(join(root, 'Contents/MacOS/Orrery'))).mode & 0o111);
  });
});

test('extracts Windows portable app files', async () => {
  await fixture([{ name: 'Orrery/Orrery.exe', text: 'MZdummy' }, { name: 'Orrery/resources/app.asar' }], async (archive, directory) => {
    const root = await extractUpdate(archive, directory, 'win32');
    assert.equal(await readFile(join(root, 'Orrery.exe'), 'utf8'), 'MZdummy');
  });
});

test('rejects traversal, foreign roots, case aliases, device names and duplicate paths', async () => {
  for (const name of ['../outside', '/outside', 'Orrery.app/../../outside', 'other/file', 'Orrery.app/a/../b', 'Orrery.app/a\\b', 'Orrery.app/C:drive', 'Orrery.app/CON.txt', 'Orrery.app/name.']) {
    await fixture([{ name }], async (archive, directory) => { await assert.rejects(extractUpdate(archive, directory, 'darwin')); });
  }
  for (const second of ['Orrery.app/file', 'Orrery.app/FILE']) {
    await fixture([{ name: 'Orrery.app/file' }, { name: second }], async (archive, directory) => { await assert.rejects(extractUpdate(archive, directory, 'darwin'), /중복/); });
  }
});

test('rejects escaped, dangling, cyclic, Windows and write-through symlinks', async () => {
  for (const target of ['../../outside', '/tmp/outside', 'missing', 'link']) {
    await fixture([{ name: 'Orrery.app/link', mode: 0o120777, text: target }], async (archive, directory) => { await assert.rejects(extractUpdate(archive, directory, 'darwin')); });
  }
  await fixture([{ name: 'Orrery/link', mode: 0o120777, text: 'Orrery.exe' }], async (archive, directory) => { await assert.rejects(extractUpdate(archive, directory, 'win32')); });
  await fixture([
    { name: 'Orrery.app/dest/file', text: 'unchanged' },
    { name: 'Orrery.app/link', mode: 0o120777, text: 'dest' },
    { name: 'Orrery.app/link/file', text: 'overwrite' },
  ], async (archive, directory) => {
    await assert.rejects(extractUpdate(archive, directory, 'darwin'));
    assert.equal(await readFile(join(directory, 'Orrery.app/dest/file'), 'utf8'), 'unchanged');
    assert.equal((await lstat(join(directory, 'Orrery.app/link'))).isDirectory(), true);
  });
});

test('rejects a truncated ZIP and decompressed size mismatch', async () => {
  await fixture([{ name: 'Orrery.app/file', size: 3 * 1024 ** 3 }], async (archive, directory) => { await assert.rejects(extractUpdate(archive, directory, 'darwin')); });
  await fixture([{ name: 'Orrery.app/file' }], async (archive, directory) => {
    await writeFile(archive, (await readFile(archive)).subarray(0, 15));
    await assert.rejects(extractUpdate(archive, directory, 'darwin'));
  });
});
