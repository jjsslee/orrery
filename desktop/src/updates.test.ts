import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetName, checkUpdate, downloadUpdate, newerVersion, RELEASES, selectUpdate } from './updates';

const bytes = Buffer.from('dummy update ZIP');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const asset = (name = 'Orrery-macos-arm64.zip') => ({ name, browser_download_url: `${RELEASES}/download/v0.10.0/${name}`, size: bytes.length, digest: `sha256:${sha256}`, state: 'uploaded' });
const release = () => ({ tag_name: 'v0.10.0', prerelease: false, draft: false, assets: [asset()] });
const update = () => selectUpdate(release(), '0.9.2', 'darwin', 'arm64')!;
const request = (fn: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch => (async (url, init) => fn(String(url), init)) as typeof fetch;

test('versions compare numerically, never downgrade or install preview versions', () => {
  assert.equal(newerVersion('0.10.0', '0.9.2'), true);
  assert.equal(newerVersion('1.0.0', '0.99.99'), true);
  assert.equal(newerVersion('0.9.2', '0.9.2'), false);
  assert.equal(newerVersion('0.9.1', '0.9.2'), false);
  for (const invalid of ['0.10.0-beta.1', '../app', '1.2', '99999999999999999.1.1']) assert.throws(() => newerVersion(invalid, '0.9.2'));
  assert.equal(selectUpdate({ ...release(), prerelease: true }, '0.9.2', 'darwin', 'arm64'), undefined);
  assert.equal(selectUpdate({ ...release(), draft: true }, '0.9.2', 'darwin', 'arm64'), undefined);
  assert.equal(selectUpdate(release(), '0.10.0', 'darwin', 'arm64'), undefined);
});

test('selects exact platform and architecture assets', () => {
  for (const [platform, arch, name] of [['darwin', 'arm64', 'Orrery-macos-arm64.zip'], ['darwin', 'x64', 'Orrery-macos-x64.zip'], ['win32', 'x64', 'Orrery-windows-x64.zip']]) {
    assert.equal(assetName(platform, arch), name);
    assert.equal(selectUpdate({ ...release(), assets: [asset(name)] }, '0.9.2', platform, arch)?.name, name);
  }
  assert.throws(() => assetName('win32', 'arm64'));
  assert.throws(() => assetName('linux', 'x64'));
  assert.throws(() => selectUpdate(release(), '0.9.2', 'darwin', 'x64'), /아직 게시/);
});

test('refuses missing digest, malformed sizes, incomplete uploads and foreign URLs', () => {
  for (const change of [{ digest: null }, { digest: '' }, { digest: 'sha512:abc' }, { size: 0 }, { size: 0.5 }, { size: 700 * 1024 ** 2 }, { state: 'new' }, { browser_download_url: 'https://example.com/app.zip' }, { browser_download_url: `${RELEASES}/download/v0.9.9/Orrery-macos-arm64.zip` }]) {
    assert.throws(() => selectUpdate({ ...release(), assets: [{ ...asset(), ...change }] }, '0.9.2', 'darwin', 'arm64'), /SHA-256/);
  }
});

test('release lookup uses the fixed public API, handles network/rate-limit failures', async () => {
  assert.equal((await checkUpdate('0.9.2', 'darwin', 'arm64', request(async (url, init) => {
    assert.equal(url, 'https://api.github.com/repos/jjsslee/orrery/releases/latest');
    assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as Record<string, string>).authorization, undefined);
    return Response.json(release());
  })))?.version, '0.10.0');
  await assert.rejects(checkUpdate('0.9.2', 'darwin', 'arm64', request(async () => new Response('', { status: 403 }))), /HTTP 403/);
});

test('download follows GitHub redirects and writes only an exact size and SHA-256 match', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orrery-download-'));
  try {
    let calls = 0;
    const destination = join(dir, 'update.zip');
    await downloadUpdate(update(), destination, request(async (url) => {
      calls++;
      return calls === 1 ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/dummy.zip' } }) : new Response(bytes);
    }));
    assert.equal(calls, 2);
    assert.deepEqual(await readFile(destination), bytes);
    await assert.rejects(downloadUpdate(update(), destination, request(async () => new Response(bytes))), /EEXIST/);
    assert.deepEqual(await readFile(destination), bytes);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('corrupt, truncated, oversized and interrupted downloads leave no ZIP', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orrery-download-'));
  try {
    for (const body of [Buffer.from('x'.repeat(bytes.length)), bytes.subarray(1), Buffer.concat([bytes, bytes])]) {
      await assert.rejects(downloadUpdate(update(), join(dir, 'update.zip'), request(async () => new Response(body))));
      assert.deepEqual(await readdir(dir), []);
    }
    const broken = new ReadableStream({ start(controller) { controller.error(new Error('connection lost')); } });
    await assert.rejects(downloadUpdate(update(), join(dir, 'update.zip'), request(async () => new Response(broken))), /connection lost/);
    assert.deepEqual(await readdir(dir), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('refuses external or non-HTTPS redirects and redirect loops before writing files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orrery-download-'));
  try {
    for (const location of ['http://github.com/dummy', 'https://github.com.evil.test/dummy', 'https://example.com/dummy', 'https://user:pass@github.com/dummy', 'https://github.com:444/dummy']) {
      let calls = 0;
      await assert.rejects(downloadUpdate(update(), join(dir, 'update.zip'), request(async () => { calls++; return new Response(null, { status: 302, headers: { location } }); })), /허용되지/);
      assert.equal(calls, 1);
    }
    await assert.rejects(downloadUpdate(update(), join(dir, 'update.zip'), request(async () => new Response(null, { status: 302, headers: { location: update().url } }))), /다운로드하지/);
    assert.deepEqual(await readdir(dir), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
