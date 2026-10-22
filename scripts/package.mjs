#!/usr/bin/env node
/**
 * Builds single-file executables of Orrery (Node SEA) for macOS and Windows.
 * Run on macOS: `npm run package` (all targets) or `npm run package -- macos-arm64`.
 *
 * 1. Bundle the server into one CommonJS file (SEA entry points are CommonJS).
 * 2. Embed web/dist as SEA assets ("web/<path>") and build the SEA blob with
 *    the same Node version the executables run on.
 * 3. Per target: take the official Node runtime (downloaded once into
 *    release/.node, SHA-256 checked against nodejs.org's SHASUMS256.txt),
 *    drop its signature, inject the blob with postject, and ad-hoc sign the
 *    macOS binaries (Apple Silicon refuses to run unsigned code).
 */
import { build } from 'esbuild';
import postject from 'postject';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_VERSION = '24.22.1';
const NODE_DIST = `https://nodejs.org/dist/v${NODE_VERSION}`;
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const TARGETS = [
  { name: 'macos-arm64', dist: 'darwin-arm64', file: 'orrery-macos-arm64' },
  { name: 'macos-x64', dist: 'darwin-x64', file: 'orrery-macos-x64' },
  { name: 'windows-x64', dist: 'win-x64', file: 'orrery-windows-x64.exe' },
];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'release');
const work = join(out, '.work');
const runtimes = join(out, '.node', `v${NODE_VERSION}`);
const webDist = join(root, 'web', 'dist');

const wanted = process.argv.slice(2);
const targets = wanted.length ? TARGETS.filter((t) => wanted.includes(t.name)) : TARGETS;
if (wanted.length && targets.length !== wanted.length) fail(`알 수 없는 대상: ${wanted.join(', ')} (가능: ${TARGETS.map((t) => t.name).join(', ')})`);
if (process.platform !== 'darwin') fail('macOS에서 실행하세요: macOS 실행파일은 codesign으로 서명해야 합니다.');
if (!existsSync(join(webDist, 'index.html'))) fail('web/dist가 없습니다. 먼저 `npm run build`를 실행하세요.');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function filesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

let sums;
async function expectedSha(remote) {
  if (!sums) {
    const res = await fetch(`${NODE_DIST}/SHASUMS256.txt`);
    if (!res.ok) fail(`SHASUMS256.txt를 받지 못했습니다: ${res.status}`);
    sums = new Map((await res.text()).trim().split('\n').map((line) => line.split(/\s+/).reverse()));
  }
  return sums.get(remote) ?? fail(`SHASUMS256.txt에 ${remote}가 없습니다`);
}

/** The official Node runtime for one platform, downloaded once and checksum-verified. */
async function nodeRuntime(dist) {
  const windows = dist.startsWith('win');
  const binary = join(runtimes, dist, windows ? 'node.exe' : 'node');
  if (existsSync(binary)) return binary;
  const remote = windows ? `${dist}/node.exe` : `node-v${NODE_VERSION}-${dist}.tar.gz`;
  console.log(`  Node ${NODE_VERSION} ${dist} 받는 중`);
  const res = await fetch(`${NODE_DIST}/${remote}`);
  if (!res.ok) fail(`${remote}를 받지 못했습니다: ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  const sha = createHash('sha256').update(data).digest('hex');
  if (sha !== (await expectedSha(remote))) fail(`${remote}의 SHA-256이 맞지 않습니다`);
  mkdirSync(dirname(binary), { recursive: true });
  if (windows) {
    writeFileSync(binary, data);
  } else {
    const tarball = `${binary}.tar.gz`;
    writeFileSync(tarball, data);
    execFileSync('tar', ['-xzf', tarball, '-C', dirname(binary), '--strip-components=2', `node-v${NODE_VERSION}-${dist}/bin/node`]);
    rmSync(tarball);
  }
  return binary;
}

/**
 * node.exe ships Authenticode-signed and injecting the blob breaks that
 * signature; drop it (what `signtool remove /s` does) rather than ship a
 * broken one. Clears the PE security directory and cuts the certificate table.
 */
function stripAuthenticode(file) {
  const pe = readFileSync(file);
  const optionalHeader = pe.readUInt32LE(0x3c) + 24;
  const pe32plus = pe.readUInt16LE(optionalHeader) === 0x20b;
  const securityDir = optionalHeader + (pe32plus ? 112 : 96) + 4 * 8;
  const offset = pe.readUInt32LE(securityDir);
  const size = pe.readUInt32LE(securityDir + 4);
  if (!offset || !size) return;
  pe.writeUInt32LE(0, securityDir);
  pe.writeUInt32LE(0, securityDir + 4);
  pe.writeUInt32LE(0, optionalHeader + 64); // checksum: only verified for drivers
  writeFileSync(file, offset + size === pe.length ? pe.subarray(0, offset) : pe);
}

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

console.log('서버 번들');
await build({
  entryPoints: [join(root, 'server', 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: `node${NODE_VERSION.split('.')[0]}`,
  minify: true,
  outfile: join(work, 'server.cjs'),
  // The server derives repo paths from import.meta.url; CommonJS has __filename (the executable, under SEA).
  define: { 'import.meta.url': '__orreryMetaUrl' },
  banner: { js: 'var __orreryMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
  logLevel: 'warning',
});

console.log('SEA blob');
const assets = Object.fromEntries(filesUnder(webDist).map((path) => [`web/${relative(webDist, path).split(sep).join('/')}`, path]));
const seaConfig = join(work, 'sea-config.json');
const blob = join(work, 'sea-prep.blob');
writeFileSync(seaConfig, JSON.stringify({
  main: join(work, 'server.cjs'),
  output: blob,
  disableExperimentalSEAWarning: true,
  // Off so one blob fits every platform's runtime.
  useSnapshot: false,
  useCodeCache: false,
  assets,
}, null, 2));
execFileSync(await nodeRuntime(`darwin-${process.arch}`), ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });
const blobData = readFileSync(blob);

for (const t of targets) {
  console.log(t.name);
  const exe = join(out, t.file);
  const macos = t.dist.startsWith('darwin');
  rmSync(exe, { force: true });
  copyFileSync(await nodeRuntime(t.dist), exe);
  chmodSync(exe, 0o755);
  if (macos) execFileSync('codesign', ['--remove-signature', exe]);
  else stripAuthenticode(exe);
  await postject.inject(exe, 'NODE_SEA_BLOB', blobData, { sentinelFuse: SEA_FUSE, ...(macos ? { machoSegmentName: 'NODE_SEA' } : {}) });
  if (macos) execFileSync('codesign', ['--sign', '-', exe]);
  // Browsers, messengers and cloud drives drop the executable bit of a bare file, and Finder then
  // opens it as a document. A zip made by ditto keeps the bit; the signature lives inside the binary,
  // so extended attributes (which would add a stray ._ file) are left out.
  const zip = `${exe.replace(/\.exe$/, '')}.zip`;
  rmSync(zip, { force: true });
  execFileSync('ditto', ['-c', '-k', '--norsrc', '--noextattr', '--noacl', exe, zip]);
  const mb = (path) => `${(statSync(path).size / 1024 / 1024).toFixed(0)}MB`;
  console.log(`  ${relative(root, exe)} (${mb(exe)}) → ${relative(root, zip)} (${mb(zip)})`);
}
