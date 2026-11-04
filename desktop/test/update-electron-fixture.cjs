// Run in Electron's main process: ordinary Node cannot reproduce its ASAR fs interception.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const disk = require('original-fs').promises;
const { createHash } = require('node:crypto');
const { join } = require('node:path');
const [bundle, archive, asar, directory] = process.argv.slice(2);
const { prepareUpdate, cancelPreparedUpdate, validatePackage } = require(bundle);
app.setPath('userData', join(directory, 'electron-data'));
(async () => {
  const bytes = await disk.readFile(archive);
  const original = await disk.readFile(asar);
  const marker = join(asar, 'marker.txt');
  assert.equal(await fs.readFile(marker, 'utf8'), 'ASAR reading remains enabled');
  const target = join(directory, 'installed', 'Orrery');
  await disk.mkdir(target, { recursive: true });
  await disk.writeFile(join(target, 'keep.txt'), 'current app');
  const data = join(directory, 'user-data');
  const update = { version: '1.2.3', name: 'Orrery-windows-x64.zip', url: 'https://github.com/jjsslee/orrery/releases/download/v1.2.3/Orrery-windows-x64.zip', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const job = await prepareUpdate(update, data, join(target, 'Orrery.exe'), 'win32', 'x64', [], async () => new Response(bytes));
  const packagedAsar = join(job.next, 'resources', 'app.asar');
  assert.ok((await disk.lstat(packagedAsar)).isFile());
  assert.deepEqual(await disk.readFile(packagedAsar), original);
  assert.equal(await fs.readFile(join(packagedAsar, 'marker.txt'), 'utf8'), 'ASAR reading remains enabled');
  await assert.rejects(validatePackage(job.next, { ...update, version: '9.9.9' }, 'win32', 'x64'), /일치하지/);
  if (process.platform !== 'win32') {
    const alias = packagedAsar + '.physical';
    await disk.rename(packagedAsar, alias);
    await disk.symlink(alias, packagedAsar);
    await assert.rejects(validatePackage(job.next, update, 'win32', 'x64'), /심볼릭 링크/);
    await disk.unlink(packagedAsar);
    await disk.rename(alias, packagedAsar);
  }
  await cancelPreparedUpdate(job, data);
  await assert.rejects(disk.access(job.directory), { code: 'ENOENT' });
  await assert.rejects(disk.access(join(data, 'updates', 'pending.json')), { code: 'ENOENT' });
  assert.equal(await disk.readFile(join(target, 'keep.txt'), 'utf8'), 'current app');
  assert.equal(await fs.readFile(marker, 'utf8'), 'ASAR reading remains enabled');
  assert.notEqual(process.noAsar, true);
  console.log(JSON.stringify({ electron: process.versions.electron, prepared: true, asarBytesPreserved: true, validationPreserved: true, cleanupVerified: true, currentAppPreserved: true, globalAsarEnabled: true }));
})().then(() => app.exit(0), error => { console.error(error.stack); app.exit(1); });
