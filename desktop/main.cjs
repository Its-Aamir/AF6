/**
 * AF6 Studio desktop shell (Electron).
 *
 * Runs the same production build as the server install, entirely on this PC:
 *   1. a private PostgreSQL cluster (binaries from @embedded-postgres, run via initdb/pg_ctl) in the user's app-data folder,
 *   2. the API and the worker as two child processes (Electron's Node, ELECTRON_RUN_AS_NODE),
 *   3. a window on http://127.0.0.1:<port>.
 * ffmpeg/ffprobe and the caption fonts ship inside the installer (resources/).
 * Everything listens on 127.0.0.1 only. Closing the window stops all of it.
 */
const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const APP_DIR = app.getAppPath();
const RES_DIR = app.isPackaged ? process.resourcesPath : path.join(__dirname, 'resources');
const EXE = process.platform === 'win32' ? '.exe' : '';
const DEFAULT_PORT = Number(process.env.AF6_PORT) || 8787;

let userDir, logDir, mainWindow;
const children = [];
let quitting = false;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(path.join(logDir, 'desktop.log'), line); } catch { /* log dir not ready */ }
  if (!app.isPackaged) process.stdout.write(line);
}

function readOrCreate(file, make) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { /* first run */ }
  const v = make();
  fs.writeFileSync(file, v, { mode: 0o600 });
  return v;
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

async function pickPort(preferred) {
  for (let p = preferred; p < preferred + 50; p++) if (await portFree(p)) return p;
  throw new Error(`No free port near ${preferred}`);
}

const PG_BIN = path.join(APP_DIR, 'node_modules', `@embedded-postgres/${process.platform === 'win32' ? 'windows' : process.platform}-x64`, 'native', 'bin');
let dbDir;

/** Run a PostgreSQL tool; resolves with its exit code and output. `quiet` = no pipes (pg_ctl start: postgres inherits them). */
function pgTool(tool, args, { quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(PG_BIN, `${tool}${EXE}`), args, { stdio: quiet ? 'ignore' : ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, LC_MESSAGES: 'C' } });
    let out = '';
    if (!quiet) { child.stdout.on('data', (b) => { out += b; }); child.stderr.on('data', (b) => { out += b; }); }
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, out: out.trim() }));
  });
}

/**
 * Private PostgreSQL cluster in the user's app-data folder, managed with initdb/pg_ctl.
 * pg_ctl (not a direct postgres spawn) is required on Windows: it drops administrator
 * rights before starting the server, which postgres otherwise refuses to run with.
 */
async function startDatabase() {
  dbDir = path.join(userDir, 'database');
  const password = readOrCreate(path.join(userDir, 'db-password'), () => crypto.randomBytes(24).toString('base64url'));
  const port = await pickPort(54329);
  if (!fs.existsSync(path.join(dbDir, 'PG_VERSION'))) {
    log('Creating database cluster');
    fs.rmSync(dbDir, { recursive: true, force: true }); // leftovers of an interrupted first start
    const pwFile = path.join(userDir, `.pw-${process.pid}`);
    fs.writeFileSync(pwFile, password, { mode: 0o600 });
    try {
      const r = await pgTool('initdb', ['-D', dbDir, '-U', 'studio', `--pwfile=${pwFile}`, '--auth=scram-sha-256', '--encoding=UTF8', '--locale=C']);
      log(`[initdb] ${r.out}`);
      if (r.code !== 0) throw new Error(`Could not create the database (initdb exit ${r.code}): ${r.out.slice(-800)}`);
    } finally { fs.rmSync(pwFile, { force: true }); }
  } else if (fs.existsSync(path.join(dbDir, 'postmaster.pid'))) {
    // A crash of the app can leave its postgres running on this data dir; stop it (no-op otherwise).
    const r = await pgTool('pg_ctl', ['stop', '-D', dbDir, '-m', 'fast', '-w', '-t', '20']);
    log(`pg_ctl stop (leftover check): ${r.out || r.code}`);
  }
  const pgLog = path.join(logDir, 'postgres.log');
  const r = await pgTool('pg_ctl', ['start', '-D', dbDir, '-l', pgLog, '-w', '-t', '90', '-o', `-p ${port} -c listen_addresses=127.0.0.1`], { quiet: true });
  if (r.code !== 0) {
    let tail = '';
    try { tail = fs.readFileSync(pgLog, 'utf8').slice(-1500); } catch { /* no log */ }
    throw new Error(`The database did not start (pg_ctl exit ${r.code}).\n${tail}`);
  }
  log(`Database running on port ${port}`);
  const { Client } = require('pg');
  const client = new Client({ host: '127.0.0.1', port, user: 'studio', password, database: 'postgres' });
  await client.connect();
  try {
    const exists = await client.query("select 1 from pg_database where datname = 'studio'");
    if (!exists.rowCount) await client.query('create database studio');
  } finally { await client.end(); }
  return `postgres://studio:${encodeURIComponent(password)}@127.0.0.1:${port}/studio`;
}

async function stopDatabase() {
  if (!dbDir || !fs.existsSync(path.join(dbDir, 'postmaster.pid'))) return;
  const r = await pgTool('pg_ctl', ['stop', '-D', dbDir, '-m', 'fast', '-w', '-t', '30']);
  log(`pg_ctl stop: ${r.out || r.code}`);
}

function startChild(name, script, env) {
  const out = fs.openSync(path.join(logDir, `${name}.log`), 'a');
  const child = spawn(process.execPath, [path.join(APP_DIR, script)], {
    cwd: APP_DIR,
    env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1', AF6_PARENT_PID: String(process.pid) },
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.on('exit', (code) => {
    log(`${name} exited (${code})`);
    if (!quitting) fail(`The ${name} process stopped unexpectedly (exit code ${code}).`);
  });
  children.push(child);
  return child;
}

async function waitForHealth(base, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < until) {
    try {
      const r = await fetch(`${base}/api/health`);
      const j = await r.json();
      if (j.ok) return;
      last = JSON.stringify(j);
    } catch (e) { last = e.message; }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`The studio did not become ready: ${last}`);
}

function splash(win, text) {
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0b0d12;color:#c9cfdb;font:14px system-ui,sans-serif">
    <div style="text-align:center"><div style="font-size:20px;color:#fff;margin-bottom:8px">AF6 Studio</div><div>${text}</div></div>`;
  return win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

let failed = false;
function fail(message) {
  if (failed) return;
  failed = true;
  log(`FATAL ${message}`);
  if (process.env.CI) { app.quit(); return; } // unattended (CI): no modal dialog
  const r = dialog.showMessageBoxSync({
    type: 'error', title: 'AF6 Studio', message: 'AF6 Studio could not run',
    detail: `${message}\n\nLogs: ${logDir}`, buttons: ['Open logs folder', 'Quit'], defaultId: 1,
  });
  if (r === 0) void shell.openPath(logDir);
  app.quit();
}

async function boot() {
  userDir = app.getPath('userData');
  logDir = path.join(userDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  log(`Starting ${app.getVersion()} (packaged=${app.isPackaged})`);

  mainWindow = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 700, backgroundColor: '#0b0d12', title: 'AF6 Studio',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  // Links and OAuth sign-in pages open in the user's browser, not inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  await splash(mainWindow, 'Starting the database…');

  const databaseUrl = await startDatabase();
  const port = await pickPort(DEFAULT_PORT);
  const base = `http://127.0.0.1:${port}`;
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(base)) { e.preventDefault(); void shell.openExternal(url); }
  });
  const env = {
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(port),
    PUBLIC_BASE_URL: base,
    DATABASE_URL: databaseUrl,
    STORAGE_DIR: path.join(userDir, 'data', 'storage'),
    FFMPEG_PATH: path.join(RES_DIR, 'bin', `ffmpeg${EXE}`),
    FFPROBE_PATH: path.join(RES_DIR, 'bin', `ffprobe${EXE}`),
    FONT_DIR: path.join(RES_DIR, 'fonts'),
  };
  await splash(mainWindow, 'Starting the studio…');
  startChild('api', 'dist/server/main.js', env);
  await waitForHealth(base);
  startChild('worker', 'dist/worker/main.js', env);
  log(`Ready on ${base}`);
  await mainWindow.loadURL(base);
}

function stopChild(child, graceMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, graceMs);
    child.once('exit', () => { clearTimeout(t); resolve(); });
    try { child.kill('SIGTERM'); } catch { clearTimeout(t); resolve(); }
  });
}

async function shutdown() {
  // API/worker first (they hold DB connections; interrupted jobs are resumed on next start), then the database.
  await Promise.all(children.map((c) => stopChild(c, 5000)));
  try { await stopDatabase(); } catch (e) { log(`postgres stop failed: ${e.message}`); }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'File', submenu: [
        { label: 'Open data folder', click: () => void shell.openPath(userDir) },
        { label: 'Open logs folder', click: () => void shell.openPath(logDir) },
        { type: 'separator' }, { role: 'quit' },
      ] },
      { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    ]));
    return boot();
  }).catch((e) => fail(e instanceof Error ? (e.stack || e.message) : `Startup failed: ${JSON.stringify(e)}`));

  app.on('window-all-closed', () => app.quit());
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.quit());
  app.on('before-quit', (e) => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    shutdown().finally(() => app.exit(0));
  });
}
