import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MAC_HELPER, type InstallJob, windowsHelper } from './update-helper';
import { acknowledgeUpdate, installTarget, prepareUpdate, startUpdateHelper, updateInProgress, updateNotice, updateOutcome, validatePackage } from './update-install';
import type { Update } from './updates';

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
async function untilFile(file: string): Promise<string> {
  for (let i = 0; i < 150; i++) {
    try { return await readFile(file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await pause();
  }
  throw new Error(`Timed out: ${file}`);
}

async function jobFixture(run: (job: InstallJob, dir: string) => Promise<void>): Promise<void> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'orrery-install-')));
  const target = join(dir, "앱 ' $ ` ;", 'Orrery.app');
  const directory = join(dirname(target), '.orrery-update-test');
  const next = join(directory, 'extracted', 'Orrery.app');
  await mkdir(join(target, 'Contents', 'MacOS'), { recursive: true });
  await mkdir(join(next, 'Contents', 'MacOS'), { recursive: true });
  const job: InstallJob = { directory, target, next, token: randomUUID(), version: '0.10.0', pids: [], startupTimeout: 2, exitTimeout: 3 };
  try { await run(job, dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test('rejects translocated apps, DMG mounts and loose Windows executables', () => {
  assert.equal(installTarget('/Applications/Orrery.app/Contents/MacOS/Orrery', 'darwin'), '/Applications/Orrery.app');
  assert.equal(installTarget('/dummy/Orrery/Orrery.exe', 'win32'), '/dummy/Orrery');
  for (const path of ['/Volumes/Orrery/Orrery.app/Contents/MacOS/Orrery', '/private/var/AppTranslocation/dummy/Orrery.app/Contents/MacOS/Orrery', '/Applications/Other.app/Contents/MacOS/Orrery']) assert.throws(() => installTarget(path, 'darwin'));
  assert.throws(() => installTarget('/dummy/Desktop/Orrery.exe', 'win32'));
});

test('package validation refuses wrong version, CPU, format and invalid Windows executables', async () => {
  await jobFixture(async (job) => {
    const root = join(job.directory, 'windows', 'Orrery'), resources = join(root, 'resources');
    await mkdir(resources, { recursive: true });
    await writeFile(join(resources, 'app.asar'), 'dummy');
    const metadata = { format: 1, version: '0.10.0', platform: 'win32', arch: 'x64' };
    const update = { version: '0.10.0' } as Update;
    await writeFile(join(root, 'Orrery.exe'), 'MZdummy');
    await writeFile(join(resources, 'orrery-update.json'), JSON.stringify(metadata));
    await validatePackage(root, update, 'win32', 'x64');
    for (const change of [{ version: '0.9.2' }, { arch: 'arm64' }, { platform: 'darwin' }, { format: 2 }]) {
      await writeFile(join(resources, 'orrery-update.json'), JSON.stringify({ ...metadata, ...change }));
      await assert.rejects(validatePackage(root, update, 'win32', 'x64'), /일치하지/);
    }
    await writeFile(join(resources, 'orrery-update.json'), JSON.stringify(metadata));
    await writeFile(join(root, 'Orrery.exe'), 'invalid');
    await assert.rejects(validatePackage(root, update, 'win32', 'x64'), /실행 파일/);
  });
});

test('Windows helper embeds paths only as base64 JSON data', async () => {
  await jobFixture(async (job) => {
    const script = windowsHelper(job);
    const data = script.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)![1];
    assert.deepEqual(JSON.parse(Buffer.from(data, 'base64').toString('utf8')), job);
    assert.equal(script.includes(job.target), false);
    assert.ok(script.includes('/T /F'));
  });
});

test('ready acknowledgement requires the transaction token, installed version and target location', { skip: process.platform !== 'darwin' }, async () => {
  await jobFixture(async (job, dir) => {
    const userData = join(dir, 'userData');
    await mkdir(join(userData, 'updates'), { recursive: true });
    await writeFile(join(userData, 'updates', 'pending.json'), JSON.stringify(job));
    const exe = join(job.target, 'Contents', 'MacOS', 'Orrery');
    const marker = join(job.directory, 'ready');
    await acknowledgeUpdate(userData, '0.10.0', exe, randomUUID());
    await assert.rejects(access(marker));
    await acknowledgeUpdate(userData, '0.9.2', exe, job.token);
    await assert.rejects(access(marker));
    await acknowledgeUpdate(userData, '0.10.0', join(job.next, 'Contents', 'MacOS', 'Orrery'), job.token);
    await assert.rejects(access(marker));
    await acknowledgeUpdate(userData, '0.10.0', exe, job.token);
    assert.equal(await readFile(marker, 'utf8'), 'ready');
    assert.equal((await updateOutcome(userData))?.result, 'pending');
    await writeFile(join(job.directory, 'result'), 'success');
    assert.equal((await updateOutcome(userData))?.result, 'success');
  });
});

test('native macOS helper replaces, starts and retains a backup after the new app is ready', { skip: process.platform !== 'darwin' }, async () => {
  await jobFixture(async (job) => {
    await writeFile(join(job.target, 'version'), 'old');
    await writeFile(join(job.next, 'version'), 'new');
    await writeFile(join(job.next, 'Contents', 'MacOS', 'Orrery'), `#!/bin/bash\npwd > ${shellQuote(join(job.directory, 'launch-cwd'))}\nprintf ready > ${shellQuote(join(job.directory, 'ready'))}\n`, { mode: 0o755 });
    await writeFile(join(job.directory, 'install.sh'), MAC_HELPER);
    await startUpdateHelper(job, 'darwin');
    assert.equal(await untilFile(join(job.directory, 'result')), 'success');
    assert.equal(await readFile(join(job.target, 'version'), 'utf8'), 'new');
    assert.equal(await readFile(join(job.directory, 'previous', 'version'), 'utf8'), 'old');
    assert.equal((await readFile(join(job.directory, 'launch-cwd'), 'utf8')).trim(), job.target);
  });
});

test('native macOS helper restores and restarts the old app when a new app exits before ready', { skip: process.platform !== 'darwin' }, async () => {
  await jobFixture(async (job) => {
    await writeFile(join(job.target, 'version'), 'old');
    await writeFile(join(job.next, 'version'), 'new');
    await writeFile(join(job.target, 'Contents', 'MacOS', 'Orrery'), `#!/bin/bash\nprintf started > ${shellQuote(join(job.directory, 'old-started'))}\n`, { mode: 0o755 });
    await writeFile(join(job.next, 'Contents', 'MacOS', 'Orrery'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });
    await writeFile(join(job.directory, 'install.sh'), MAC_HELPER);
    await startUpdateHelper(job, 'darwin');
    assert.equal(await untilFile(join(job.directory, 'result')), 'rolled-back');
    assert.equal(await readFile(join(job.target, 'version'), 'utf8'), 'old');
    assert.equal(await untilFile(join(job.directory, 'old-started')), 'started');
    assert.equal(await readFile(join(job.directory, 'failed-app', 'version'), 'utf8'), 'new');
  });
});

test('native macOS helper rolls back on a missing staged app', { skip: process.platform !== 'darwin' }, async () => {
  await jobFixture(async (job) => {
    await writeFile(join(job.target, 'version'), 'old');
    await writeFile(join(job.target, 'Contents', 'MacOS', 'Orrery'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    await rm(job.next, { recursive: true });
    await writeFile(join(job.directory, 'install.sh'), MAC_HELPER);
    await startUpdateHelper(job, 'darwin');
    assert.equal(await untilFile(join(job.directory, 'result')), 'rolled-back');
    assert.equal(await readFile(join(job.target, 'version'), 'utf8'), 'old');
  });
});

test('native macOS helper stops and restores a new app that never signals ready', { skip: process.platform !== 'darwin' }, async () => {
  await jobFixture(async (job) => {
    job.startupTimeout = 1;
    await writeFile(join(job.target, 'version'), 'old');
    await writeFile(join(job.target, 'Contents', 'MacOS', 'Orrery'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    await writeFile(join(job.next, 'Contents', 'MacOS', 'Orrery'), '#!/bin/bash\nexec /bin/sleep 10\n', { mode: 0o755 });
    await writeFile(join(job.directory, 'install.sh'), MAC_HELPER);
    await startUpdateHelper(job, 'darwin');
    assert.equal(await untilFile(join(job.directory, 'result')), 'rolled-back');
    assert.equal(await readFile(join(job.target, 'version'), 'utf8'), 'old');
  });
});

test('user launches cannot take the instance lock during an active install, but the token launch can', async () => {
  await jobFixture(async (job, dir) => {
    const userData = join(dir, 'userData');
    await mkdir(join(userData, 'updates'), { recursive: true });
    await writeFile(join(userData, 'updates', 'pending.json'), JSON.stringify(job));
    assert.equal(await updateInProgress(userData, []), false);
    await writeFile(join(job.directory, 'helper-pid'), String(process.pid));
    assert.equal(await updateInProgress(userData, []), true);
    assert.equal(await updateInProgress(userData, [`--orrery-update=${job.token}`]), false);
    await writeFile(join(job.directory, 'result'), 'success');
    assert.equal(await updateInProgress(userData, []), false);
  });
});

test('failure notices are claimed once without deleting recovery state', async () => {
  await jobFixture(async (job, dir) => {
    const userData = join(dir, 'userData');
    await mkdir(join(userData, 'updates'), { recursive: true });
    await writeFile(join(userData, 'updates/pending.json'), JSON.stringify(job));
    await writeFile(join(job.directory, 'result'), 'rolled-back');
    assert.equal((await updateNotice(userData))?.result, 'rolled-back');
    assert.equal(await updateNotice(userData), undefined);
    assert.equal((await updateOutcome(userData))?.result, 'rolled-back');
  });
});

test('an unchanged app can retry without manual deletion of transaction records', async () => {
  await jobFixture(async (job, dir) => {
    const userData = join(dir, 'userData');
    await mkdir(join(userData, 'updates'), { recursive: true });
    await writeFile(join(userData, 'updates/pending.json'), JSON.stringify(job));
    await writeFile(join(job.directory, 'result'), 'unchanged');
    const update = { version: '0.10.0', name: 'update.zip', url: 'https://github.com/jjsslee/orrery/releases/download/v0.10.0/update.zip' } as Update;
    await assert.rejects(prepareUpdate(update, userData, join(job.target, 'Contents/MacOS/Orrery'), 'darwin', 'arm64', [], async () => { throw new Error('reached download'); }), /reached download/);
    assert.equal(await updateOutcome(userData), undefined);
  });
});

test('cancelling preparation removes the partial ZIP and staging directory without creating pending state', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'orrery-abort-')));
  try {
    const target = join(dir, 'Orrery'), userData = join(dir, 'user-data');
    await mkdir(target);
    const cancellation = new AbortController();
    let started!: () => void;
    const downloading = new Promise<void>((resolve) => { started = resolve; });
    const update = { version: '0.10.0', name: 'update.zip', size: 999, sha256: '0'.repeat(64), url: 'https://github.com/jjsslee/orrery/releases/download/v0.10.0/update.zip' };
    const preparation = prepareUpdate(update, userData, join(target, 'Orrery.exe'), 'win32', 'x64', [], async (_url, init) => new Response(new ReadableStream({ start(controller) {
      init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason), { once: true });
      controller.enqueue(Buffer.from('partial')); started();
    } })), cancellation.signal);
    await downloading;
    cancellation.abort();
    await assert.rejects(preparation, /abort/i);
    assert.equal((await readdir(dir)).some((name) => name.startsWith('.orrery-update-')), false);
    assert.equal(await updateOutcome(userData), undefined);
    await access(target);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('native macOS helper can restore after a new app ignores TERM', { skip: process.platform !== 'darwin' }, async () => {
  await jobFixture(async (job) => {
    job.startupTimeout = 1; job.exitTimeout = 1;
    await writeFile(join(job.target, 'version'), 'old');
    await writeFile(join(job.target, 'Contents', 'MacOS', 'Orrery'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    await writeFile(join(job.next, 'Contents', 'MacOS', 'Orrery'), `#!/bin/bash\ntrap '' TERM\nprintf '%s' "$$" > ${shellQuote(join(job.directory, 'new-pid'))}\nwhile true; do /bin/sleep 1; done\n`, { mode: 0o755 });
    await writeFile(join(job.directory, 'install.sh'), MAC_HELPER);
    let pid: number | undefined;
    try {
      await startUpdateHelper(job, 'darwin');
      pid = Number(await untilFile(join(job.directory, 'new-pid')));
      assert.equal(await untilFile(join(job.directory, 'result')), 'rolled-back');
      assert.equal(await readFile(join(job.target, 'version'), 'utf8'), 'old');
      assert.throws(() => process.kill(pid!, 0));
    } finally { if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} } }
  });
});

test('native macOS helper never swaps while the old app process is still alive', { skip: process.platform !== 'darwin' }, async () => {
  await jobFixture(async (job) => {
    job.pids = [process.pid]; job.exitTimeout = 1;
    await writeFile(join(job.target, 'version'), 'old');
    await writeFile(join(job.directory, 'install.sh'), MAC_HELPER);
    await startUpdateHelper(job, 'darwin');
    assert.equal(await untilFile(join(job.directory, 'result')), 'unchanged');
    assert.equal(await readFile(join(job.target, 'version'), 'utf8'), 'old');
    await assert.rejects(access(join(job.directory, 'previous')));
  });
});

test('helper handshake failure keeps the current app untouched', { skip: process.platform !== 'darwin' }, async () => {
  await jobFixture(async (job) => {
    await writeFile(join(job.target, 'version'), 'old');
    await assert.rejects(startUpdateHelper(job, 'darwin'), /終了|종료/);
    assert.equal(await readFile(join(job.target, 'version'), 'utf8'), 'old');
  });
});
