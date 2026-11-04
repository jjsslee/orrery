import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { extractUpdate } from './update-archive';
import { MAC_HELPER, macHelperArgs, windowsHelper, type InstallJob } from './update-helper';
import { downloadUpdate, type Update, type UpdateFetch } from './updates';

const execute = promisify(execFile);
const pendingPath = (userData: string) => join(userData, 'updates', 'pending.json');

export function installTarget(executable: string, platform: string): string {
  const target = platform === 'darwin' ? dirname(dirname(dirname(executable))) : dirname(executable);
  if (platform === 'darwin' && (basename(target) !== 'Orrery.app' || executable !== join(target, 'Contents', 'MacOS', 'Orrery'))) throw new Error('Orrery.app에서 업데이트를 실행하세요.');
  if (platform === 'win32' && (basename(target).toLowerCase() !== 'orrery' || basename(executable) !== 'Orrery.exe')) throw new Error('ZIP을 Orrery 폴더에 모두 푼 뒤 업데이트를 실행하세요.');
  if (target.includes('/AppTranslocation/') || target.startsWith('/Volumes/')) throw new Error('앱을 응용 프로그램 폴더로 옮긴 뒤 업데이트를 실행하세요.');
  return target;
}

async function pending(userData: string): Promise<InstallJob | undefined> {
  try {
    const job = JSON.parse(await readFile(pendingPath(userData), 'utf8')) as InstallJob;
    // This is local transaction state, never a renderer-supplied path. Only our sibling staging directories qualify.
    if (!job || typeof job.directory !== 'string' || typeof job.target !== 'string' || dirname(job.directory) !== dirname(job.target) || !basename(job.directory).startsWith('.orrery-update-') || !/^[a-f0-9-]{36}$/.test(job.token) || !/^\d+\.\d+\.\d+$/.test(job.version)) throw new Error('업데이트 복구 기록을 확인할 수 없습니다.');
    return job;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

export async function updateOutcome(userData: string): Promise<{ job: InstallJob; result: string } | undefined> {
  const job = await pending(userData);
  if (!job) return;
  try { return { job, result: await readFile(join(job.directory, 'result'), 'utf8') }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { job, result: 'pending' };
    throw error;
  }
}

/** Keep recovery files, but claim a failure notice only once for each transaction. */
export async function updateNotice(userData: string): Promise<Awaited<ReturnType<typeof updateOutcome>>> {
  const outcome = await updateOutcome(userData);
  if (!outcome || !['unchanged', 'rolled-back', 'failed'].includes(outcome.result)) return;
  try { await writeFile(join(outcome.job.directory, 'notice-shown'), 'shown', { mode: 0o600, flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    throw error;
  }
  return outcome;
}

/** Avoid a user launch acquiring the instance lock in the gap while the helper swaps the app. */
export async function updateInProgress(userData: string, args: string[]): Promise<boolean> {
  try {
    const outcome = await updateOutcome(userData);
    if (!outcome || outcome.result !== 'pending' || args.includes(`--orrery-update=${outcome.job.token}`)) return false;
    const pid = Number(await readFile(join(outcome.job.directory, 'helper-pid'), 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

/** Called only after the new app's own local page has loaded and its window can be shown. */
export async function acknowledgeUpdate(userData: string, version: string, executable: string, token: string | undefined): Promise<void> {
  if (!token) return;
  const job = await pending(userData);
  if (!job || job.token !== token || job.version !== version || await realpath(job.target) !== await realpath(installTarget(executable, process.platform))) return;
  await writeFile(join(job.directory, 'ready'), 'ready', { mode: 0o600, flag: 'wx' });
}

export async function validatePackage(root: string, update: Update, platform: string, arch: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const resources = platform === 'darwin' ? join(root, 'Contents', 'Resources') : join(root, 'resources');
  for (const path of [root, resources, join(resources, 'app.asar'), join(resources, 'orrery-update.json')]) {
    if ((await lstat(path)).isSymbolicLink()) throw new Error('업데이트 필수 파일이 심볼릭 링크입니다.');
  }
  const metadata = JSON.parse(await readFile(join(resources, 'orrery-update.json'), 'utf8'));
  if (metadata.version !== update.version || metadata.platform !== platform || metadata.arch !== arch || metadata.format !== 1) throw new Error('업데이트 파일의 버전·운영체제·CPU가 일치하지 않습니다.');
  if (platform === 'darwin') {
    await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', root], { timeout: 30_000, signal });
  } else {
    const executable = join(root, 'Orrery.exe');
    if ((await lstat(executable)).isSymbolicLink()) throw new Error('Windows 실행 파일을 확인할 수 없습니다.');
    const file = await open(executable, 'r');
    try {
      const header = Buffer.alloc(2);
      await file.read(header, 0, 2, 0);
      if (header.toString() !== 'MZ') throw new Error('Windows 실행 파일을 확인할 수 없습니다.');
    } finally { await file.close(); }
  }
}

/** Does not quit or mutate the installed app. Preparation failures remove only this attempt's private staging directory. */
export async function prepareUpdate(update: Update, userData: string, executable: string, platform: string, arch: string, pids: number[], request?: UpdateFetch, signal?: AbortSignal): Promise<InstallJob> {
  signal?.throwIfAborted();
  const previous = await updateOutcome(userData);
  if (previous) {
    if (!['success', 'rolled-back', 'unchanged', 'cancelled'].includes(previous.result)) throw new Error(`이전 업데이트가 완료되지 않았습니다. 복구 기록을 확인하세요: ${previous.job.directory}`);
    await rm(previous.job.directory, { recursive: true, force: true });
    await rm(pendingPath(userData), { force: true });
  }
  const target = installTarget(executable, platform);
  if (await realpath(target) !== target || (await lstat(target)).isSymbolicLink()) throw new Error('심볼릭 링크로 실행한 앱은 원래 위치에서 업데이트하세요.');
  await access(dirname(target), constants.W_OK);
  const directory = await mkdtemp(join(dirname(target), '.orrery-update-'));
  try {
    const zip = join(directory, update.name);
    await downloadUpdate(update, zip, request, signal);
    const next = await extractUpdate(zip, join(directory, 'extracted'), platform, signal);
    await validatePackage(next, update, platform, arch, signal);
    await rm(zip);
    const job: InstallJob = { directory, target, next, version: update.version, token: randomUUID(), pids };
    await writeFile(join(directory, platform === 'darwin' ? 'install.sh' : 'install.ps1'), platform === 'darwin' ? MAC_HELPER : windowsHelper(job), { mode: 0o700 });
    await mkdir(dirname(pendingPath(userData)), { recursive: true, mode: 0o700 });
    await writeFile(pendingPath(userData), JSON.stringify(job), { mode: 0o600, flag: 'wx' });
    return job;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function cancelPreparedUpdate(job: InstallJob, userData: string): Promise<void> {
  await rm(job.directory, { recursive: true, force: true });
  await rm(pendingPath(userData), { force: true });
}

/** Handshake before quitting: a spawn success alone does not prove PowerShell execution policy allowed the helper. */
export async function startUpdateHelper(job: InstallJob, platform: string): Promise<void> {
  const command = platform === 'darwin' ? '/bin/bash' : join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = platform === 'darwin' ? [join(job.directory, 'install.sh'), ...macHelperArgs(job)] : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(job.directory, 'install.ps1')];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd: job.directory });
  let failure: Error | undefined;
  child.on('error', (error) => { failure = error; });
  child.on('exit', (code) => { failure = new Error(`업데이트 프로그램이 종료되었습니다(${code}).`); });
  child.unref();
  for (let i = 0; i < 100; i++) {
    if (failure) throw failure;
    try {
      await access(join(job.directory, 'helper-ready'));
      await writeFile(join(job.directory, 'commit'), 'commit', { mode: 0o600, flag: 'wx' });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error('업데이트 프로그램을 시작하지 못했습니다. 기존 앱은 변경하지 않았습니다.');
}
