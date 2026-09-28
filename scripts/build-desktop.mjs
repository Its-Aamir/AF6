#!/usr/bin/env node
/**
 * Build the desktop app (Windows installer .exe, or an unpacked Linux dir for local checks).
 *
 *   npm run desktop:build              # target = this OS
 *   npm run desktop:build -- --win     # Windows NSIS installer (build on Windows for the exe icon + bundled MSVC runtime)
 *   npm run desktop:build -- --skip-build
 *
 * Steps: build web+server → stage an app folder (dist, drizzle, main.cjs, production
 * node_modules incl. embedded PostgreSQL for the target OS) → gather resources
 * (ffmpeg/ffprobe for the target OS, verified by SHA-256; caption fonts) → electron-builder.
 * Output: ./release
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const root = path.resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const target = args.has('--win') ? 'win32' : args.has('--linux') ? 'linux' : process.platform;
const stage = path.join(root, 'build', 'desktop-app');
const resDir = path.join(root, 'build', 'desktop-resources');
const cacheDir = path.join(root, 'build', 'cache');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const PG_VERSION = '17.10.0-beta.17';

// Windows ffmpeg 6.1.1 (GPL build with libass/freetype/x264), as published by ffmpeg-static.
const FFMPEG_WIN = {
  ffmpeg: { url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-win32-x64.gz', sha256: '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00' },
  ffprobe: { url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffprobe-win32-x64.gz', sha256: '3a7e2dc003dc2cd1472827e4c7c4f056ae1ae0ae7c5bbc580c99b49827351ba4' },
};

const step = (m) => console.log(`\n[desktop] ${m}`);
const run = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: 'inherit', env: { ...process.env } });
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function download(url, expectedSha, gz) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const cached = path.join(cacheDir, expectedSha);
  if (fs.existsSync(cached)) return fs.readFileSync(cached);
  console.log(`  downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  let buf = Buffer.from(await res.arrayBuffer());
  if (gz) buf = gunzipSync(buf);
  const got = sha256(buf);
  if (got !== expectedSha) throw new Error(`Checksum mismatch for ${url}: expected ${expectedSha}, got ${got}`);
  fs.writeFileSync(cached, buf);
  return buf;
}

function findOnPath(bin) {
  const cmd = process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`;
  try { return execSync(cmd, { encoding: 'utf8' }).split(/\r?\n/)[0].trim(); } catch { return null; }
}

async function main() {
  if (!args.has('--skip-build')) { step('Building web + server'); run('npm run build'); }
  for (const p of ['dist/server/main.js', 'dist/worker/main.js', 'dist/web/index.html']) {
    if (!fs.existsSync(path.join(root, p))) throw new Error(`Missing ${p} — run npm run build first`);
  }

  step(`Staging app for ${target}`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  fs.cpSync(path.join(root, 'dist'), path.join(stage, 'dist'), { recursive: true, filter: (s) => !s.endsWith('.map') });
  fs.cpSync(path.join(root, 'drizzle'), path.join(stage, 'drizzle'), { recursive: true });
  fs.copyFileSync(path.join(root, 'desktop', 'main.cjs'), path.join(stage, 'main.cjs'));
  const pgBinPkg = `@embedded-postgres/${target === 'win32' ? 'windows' : target}-x64`;
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
    name: pkg.name, productName: 'AF6 Studio', version: pkg.version, description: pkg.description,
    author: 'AF6 Studio', license: 'UNLICENSED', type: 'module', main: 'main.cjs',
    // The platform binaries are optionalDependencies of embedded-postgres; --os/--cpu select the target's.
    dependencies: { ...pkg.dependencies, 'embedded-postgres': PG_VERSION },
  }, null, 2));
  run(`npm install --omit=dev --no-audit --no-fund --os=${target} --cpu=x64`, stage);

  const pgBin = path.join(stage, 'node_modules', pgBinPkg, 'native', 'bin');
  if (!fs.existsSync(pgBin)) throw new Error(`PostgreSQL binaries missing in ${pgBin}`);
  if (target === 'win32') {
    // PostgreSQL for Windows needs the MSVC runtime; ship it app-locally so PCs without
    // the VC++ redistributable still work (Microsoft's documented app-local deployment).
    const sys = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32') : null;
    const dlls = ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll'];
    if (sys && process.platform === 'win32') {
      for (const d of dlls) fs.copyFileSync(path.join(sys, d), path.join(pgBin, d));
      console.log(`  bundled ${dlls.join(', ')}`);
    } else {
      console.warn('  WARNING: not building on Windows — MSVC runtime DLLs not bundled (the installer then needs the VC++ redistributable).');
    }
  }

  step('Gathering resources (ffmpeg, fonts)');
  fs.rmSync(resDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(resDir, 'bin'), { recursive: true });
  if (target === 'win32') {
    for (const [name, { url, sha256: sum }] of Object.entries(FFMPEG_WIN)) {
      fs.writeFileSync(path.join(resDir, 'bin', `${name}.exe`), await download(url, sum, true));
    }
  } else {
    for (const name of ['ffmpeg', 'ffprobe']) {
      const src = process.env[`${name.toUpperCase()}_PATH`] || findOnPath(name);
      if (!src) throw new Error(`${name} not found on PATH`);
      fs.copyFileSync(src, path.join(resDir, 'bin', name));
      fs.chmodSync(path.join(resDir, 'bin', name), 0o755);
    }
  }
  fs.writeFileSync(path.join(resDir, 'bin', 'FFMPEG-NOTICE.txt'),
    'ffmpeg and ffprobe are from the FFmpeg project (https://ffmpeg.org), licensed under the GNU GPL v3.\n' +
    'Windows builds: https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1 (source: https://ffmpeg.org/releases/ffmpeg-6.1.1.tar.xz).\n');
  fs.cpSync(path.join(root, 'desktop', 'fonts'), path.join(resDir, 'fonts'), { recursive: true });

  step('Packaging with electron-builder');
  const { build, Platform } = await import('electron-builder');
  const electronVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
  await build({
    projectDir: stage,
    targets: (target === 'win32' ? Platform.WINDOWS : Platform.LINUX).createTarget(),
    config: {
      appId: 'com.af6studio.desktop',
      productName: 'AF6 Studio',
      electronVersion,
      asar: false,
      npmRebuild: false,
      directories: { output: path.join(root, 'release') },
      files: ['**/*'],
      extraResources: [{ from: resDir, to: '.' }],
      win: {
        target: [{ target: 'nsis', arch: ['x64'] }],
        icon: path.join(root, 'desktop', 'icon.png'),
        // Setting the exe icon/version info needs rcedit (Windows, or Wine elsewhere).
        signAndEditExecutable: process.platform === 'win32',
      },
      nsis: {
        oneClick: false,
        perMachine: false,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: true,
        createStartMenuShortcut: true,
        shortcutName: 'AF6 Studio',
        artifactName: 'AF6-Studio-Setup-${version}.exe',
        deleteAppDataOnUninstall: false,
      },
      linux: { target: ['dir'], icon: path.join(root, 'desktop', 'icon.png'), category: 'Video' },
    },
  });
  step(`Done → ${path.join(root, 'release')}`);
}

main().catch((e) => { console.error(`\n[desktop] FAILED: ${e.stack || e}`); process.exit(1); });
