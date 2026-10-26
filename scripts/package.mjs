#!/usr/bin/env node
/**
 * Builds the Orrery desktop app (Electron) for macOS and Windows.
 * Run on macOS: `npm run package` (all targets) or `npm run package -- macos-arm64`.
 *
 * 1. Bundle the server (server.cjs) and the Electron main process (main.cjs)
 *    with esbuild and stage them with the built web app (web/) as the app.
 * 2. Per target: @electron/packager takes the official Electron build
 *    (downloaded once by @electron/get and checked against Electron's
 *    published SHA-256 sums), names it Orrery, sets the icon and packs the
 *    staged app into app.asar. Renaming breaks Electron's own macOS signature
 *    and Apple Silicon refuses to run unsigned code, so the apps are ad-hoc
 *    signed again.
 * 3. Zip each app for handing out: one per Mac chip, since an app for both
 *    would carry Electron twice.
 *
 * release/ ends up with Orrery.app (for this Mac), Orrery-macos-arm64.zip,
 * Orrery-macos-x64.zip and Orrery-windows-x64.zip; everything else stays in
 * the hidden .work folder.
 */
import { build } from 'esbuild';
import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const TARGETS = [
  { name: 'macos-arm64', platform: 'darwin', arch: 'arm64', zip: 'Orrery-macos-arm64.zip' },
  { name: 'macos-x64', platform: 'darwin', arch: 'x64', zip: 'Orrery-macos-x64.zip' },
  { name: 'windows-x64', platform: 'win32', arch: 'x64', zip: 'Orrery-windows-x64.zip' },
];

const BUNDLE_ID = 'io.github.jjsslee.orrery';
// The Node inside Electron 44; raise with the electron devDependency.
const NODE_TARGET = 'node24';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
// The installed electron package (the main process typings) decides the Electron that ships.
const electronVersion = createRequire(import.meta.url)('electron/package.json').version;
// Distinct per build so a newly opened Orrery replaces a different one still running.
const buildId = `${version}+${new Date().toISOString().replace(/[-:]|\.\d+/g, '')}`;
const out = join(root, 'release');
const work = join(out, '.work');
const stage = join(work, 'app');
const webDist = join(root, 'web', 'dist');
const iconSource = join(root, 'scripts', 'icon', 'orrery-app-1024.png');

const wanted = process.argv.slice(2);
const targets = wanted.length ? TARGETS.filter((t) => wanted.includes(t.name)) : TARGETS;
if (wanted.length && targets.length !== wanted.length) fail(`알 수 없는 대상: ${wanted.join(', ')} (가능: ${TARGETS.map((t) => t.name).join(', ')})`);
if (process.platform !== 'darwin') fail('macOS에서 실행하세요: macOS 앱은 codesign으로 서명해야 합니다.');
if (!statSync(join(webDist, 'index.html'), { throwIfNoEntry: false })) fail('web/dist가 없습니다. 먼저 `npm run build`를 실행하세요.');

function fail(message) {
  console.error(message);
  process.exit(1);
}

const mb = (path) => `${(statSync(path).size / 1024 / 1024).toFixed(0)}MB`;

/**
 * Browsers, messengers and cloud drives drop the executable bit of a bare
 * file, and Finder then opens it as a document; a zip made by ditto keeps it.
 * Signatures live inside the binaries and the app's _CodeSignature, so
 * extended attributes (a stray ._ file in the zip) are left out.
 */
function zip(source, dest) {
  rmSync(dest, { force: true });
  const keepParent = statSync(source).isDirectory() ? ['--keepParent'] : [];
  execFileSync('ditto', ['-c', '-k', '--norsrc', '--noextattr', '--noacl', ...keepParent, source, dest]);
  console.log(`  ${relative(root, dest)} (${mb(dest)})`);
}

/** Orrery.icns from the 1024px render of scripts/icon/orrery-app.svg, with macOS's own sips and iconutil. */
function appIcon(dest) {
  const iconset = join(work, 'Orrery.iconset');
  mkdirSync(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const px = String(size * scale);
      execFileSync('sips', ['-z', px, px, iconSource, '--out', join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)], { stdio: 'ignore' });
    }
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', dest]);
}

/** Orrery.ico for the Windows exe from the same render; the images stay PNG, which Windows reads since Vista. */
function windowsIcon(dest) {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = sizes.map((size) => {
    const png = join(work, `ico-${size}.png`);
    execFileSync('sips', ['-z', String(size), String(size), iconSource, '--out', png], { stdio: 'ignore' });
    return readFileSync(png);
  });
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((png, i) => {
    const entry = 6 + 16 * i;
    header.writeUInt8(sizes[i] % 256, entry); // width and height; 0 means 256
    header.writeUInt8(sizes[i] % 256, entry + 1);
    header.writeUInt16LE(1, entry + 4); // color planes
    header.writeUInt16LE(32, entry + 6); // bits per pixel
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  writeFileSync(dest, Buffer.concat([header, ...images]));
}

rmSync(work, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

console.log('번들');
const bundle = (entry, outfile, options) => build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: NODE_TARGET,
  minify: true,
  outfile,
  logLevel: 'warning',
  ...options,
});
await bundle(join(root, 'server', 'src', 'index.ts'), join(stage, 'server.cjs'), {
  // The server derives paths from import.meta.url; CommonJS has __filename (server.cjs inside app.asar).
  define: { 'import.meta.url': '__orreryMetaUrl', __ORRERY_BUILD__: JSON.stringify(buildId) },
  banner: { js: 'var __orreryMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
});
await bundle(join(root, 'desktop', 'src', 'main.ts'), join(stage, 'main.cjs'), { external: ['electron'] });
cpSync(webDist, join(stage, 'web'), { recursive: true });
writeFileSync(join(stage, 'package.json'), `${JSON.stringify({ name: 'orrery', productName: 'Orrery', version, main: 'main.cjs' }, null, 2)}\n`);

const icons = { darwin: join(work, 'Orrery.icns'), win32: join(work, 'Orrery.ico') };
if (targets.some((t) => t.platform === 'darwin')) appIcon(icons.darwin);
if (targets.some((t) => t.platform === 'win32')) windowsIcon(icons.win32);

console.log(`Electron ${electronVersion}`);
for (const t of targets) {
  console.log(t.name);
  const [dir] = await packager({
    dir: stage,
    out: work,
    name: 'Orrery',
    platform: t.platform,
    arch: t.arch,
    electronVersion,
    appVersion: version,
    buildVersion: version,
    appBundleId: BUNDLE_ID,
    // Otherwise Windows shows Electron's own "Copyright (C) 2015 GitHub, Inc.".
    appCopyright: `Copyright © ${new Date().getFullYear()} jjsslee`,
    icon: icons[t.platform],
    asar: true,
    prune: false,
    quiet: true,
    win32metadata: { CompanyName: 'Orrery', ProductName: 'Orrery', FileDescription: 'Orrery', OriginalFilename: 'Orrery.exe' },
  });
  if (t.platform === 'darwin') {
    const app = join(dir, 'Orrery.app');
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: ['ignore', 'ignore', 'pipe'] });
    zip(app, join(out, t.zip));
    // The app for this Mac's chip stays next to the zips to open right away.
    if (t.arch === process.arch) {
      const local = join(out, 'Orrery.app');
      rmSync(local, { recursive: true, force: true });
      renameSync(app, local);
      console.log(`  ${relative(root, local)}`);
    }
  } else {
    // Unzipped, the folder reads Orrery\Orrery.exe rather than Orrery-win32-x64.
    const folder = join(work, 'Orrery');
    rmSync(folder, { recursive: true, force: true });
    renameSync(dir, folder);
    zip(folder, join(out, t.zip));
  }
}
