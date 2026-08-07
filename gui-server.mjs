#!/usr/bin/env node
/**
 * gui-server.mjs — professional web dashboard for the myAIE downloader.
 *
 * Serves a local dashboard on http://127.0.0.1:<port> with:
 *   - date-range + download-path + option controls
 *   - a live log of everything the bot detects and does (SSE)
 *   - a live schedule table, run/cancel, and a run summary
 *
 * The bot engine (bot-core.mjs) runs in this same process, so the live
 * feed needs no IPC. Settings persist to gui-settings.json.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { connect as netConnect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { buildConfig, dateStr, runBot } from './bot-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const SETTINGS_FILE = path.join(__dirname, 'gui-settings.json');
const RUN_LOG_FILE = path.join(__dirname, 'bot-run.log');
const HOST = '127.0.0.1';

// ---------------------------------------------------------------------------
// Settings (persisted between runs)
// ---------------------------------------------------------------------------
function defaultSettings() {
  const today = new Date();
  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 90);
  return {
    from: dateStr(from),
    to: dateStr(today),
    subject: '',
    dir: path.join(__dirname, 'downloads'),
    max: '',
    dryRun: false,
    headless: false,
    noAudit: false,
    fallbackRecording: false,
    ytdlp: false,
    channel: 'chrome',
    loginTimeout: 300,
  };
}

function loadSettings() {
  try {
    return { ...defaultSettings(), ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {
    return defaultSettings();
  }
}

function saveSettings(settings) {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch { /* best-effort */ }
}

function appendRunLog(line) {
  try {
    if (fs.existsSync(RUN_LOG_FILE) && fs.statSync(RUN_LOG_FILE).size > 1024 * 1024) {
      const buf = fs.readFileSync(RUN_LOG_FILE);
      fs.writeFileSync(RUN_LOG_FILE, buf.slice(buf.length - 512 * 1024));
    }
    fs.appendFileSync(RUN_LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let settings = loadSettings();
let state = 'idle'; // idle | running | done | error
let cancelFlag = false;
let statusText = 'Ready';

const clients = new Set();          // SSE responses
const eventHistory = [];            // recent events for late-joining clients
const MAX_HISTORY = 300;

function broadcast(type, payload = {}) {
  const evt = { type, ts: new Date().toISOString(), ...payload };
  eventHistory.push(evt);
  if (eventHistory.length > MAX_HISTORY) eventHistory.shift();
  const frame = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of clients) {
    try { res.write(frame); } catch { clients.delete(res); }
  }
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------
function startRun(body) {
  if (state === 'running') {
    return { ok: false, error: 'A run is already in progress.' };
  }
  let cfg;
  try {
    const parts = {
      from: body.from || settings.from,
      to: body.to || settings.to,
      subject: body.subject,
      max: body.max,
      dir: body.dir,
      channel: body.channel,
      executablePath: body.executablePath,
      apiBase: body.apiBase,
      loginTimeout: body.loginTimeout,
      dryRun: body.dryRun,
      inspect: body.inspect,
      headless: body.headless,
      noAudit: body.noAudit,
      fallbackRecording: body.fallbackRecording,
      ytdlp: !!body.ytdlp,
    };
    cfg = buildConfig(parts, __dirname);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  // persist the user's choices for next time
  settings = {
    from: dateStr(cfg.from),
    to: dateStr(cfg.to),
    subject: cfg.subject,
    dir: cfg.dir,
    max: cfg.max === null ? '' : String(cfg.max),
    dryRun: cfg.dryRun,
    headless: cfg.headless,
    noAudit: cfg.noAudit,
    fallbackRecording: cfg.fallbackRecording,
    ytdlp: cfg.ytdlp,
    channel: cfg.channel,
    loginTimeout: cfg.loginTimeout,
  };
  saveSettings(settings);

  cancelFlag = false;
  state = 'running';
  statusText = 'Running…';
  broadcast('status', { state, statusText, settings });
  broadcast('run_started', { settings });
  appendRunLog(`run started: ${dateStr(cfg.from)} → ${dateStr(cfg.to)}${cfg.dryRun ? ' (dry-run)' : ''}`);

  void (async () => {
    try {
      const summary = await runBot(cfg, {
        log: (level, message) => {
          broadcast('log', { level, message });
          appendRunLog(`${level}: ${message}`);
        },
        stage: (stage) => {
          statusText = stage;
          broadcast('stage', { stage });
        },
        schedule: (rows) => broadcast('schedule', { rows }),
        item: (item) => broadcast('item', { item }),
        isCancelled: () => cancelFlag,
      });
      state = 'done';
      statusText = summary.cancelled ? 'Cancelled' : 'Finished';
      broadcast('run_finished', { summary, cancelled: summary.cancelled });
      appendRunLog(`run finished: ${JSON.stringify(summary)}`);
    } catch (e) {
      state = 'error';
      statusText = 'Error';
      broadcast('log', { level: 'err', message: 'Run error: ' + e.message });
      broadcast('run_error', { error: e.message });
      appendRunLog(`run error: ${e.message}`);
    } finally {
      state = state === 'running' ? 'done' : state;
      broadcast('status', { state, statusText });
    }
  })();

  return { ok: true };
}

function handleBrowseFolder(res) {
  if (process.platform !== 'win32') {
    sendJson(res, 200, { ok: false, path: '', error: 'Native folder picker is Windows-only — type the path manually.' });
    return;
  }
  const ps = [
    '-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -AssemblyName System.Windows.Forms;',
    '$f = New-Object System.Windows.Forms.FolderBrowserDialog;',
    '$f.Description = "Choose download folder";',
    'if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $f.SelectedPath }',
  ].join(' ');
  exec(ps, { timeout: 120000, windowsHide: true }, (err, stdout) => {
    const picked = String(stdout || '').trim();
    if (err || !picked) {
      sendJson(res, 200, { ok: false, path: '', error: err ? 'Folder picker could not open (' + String(err.message).slice(0, 80) + ')' : 'No folder chosen.' });
      return;
    }
    sendJson(res, 200, { ok: true, path: picked });
  });
}

function cancelRun() {
  if (state !== 'running') return { ok: false, error: 'Nothing is running.' };
  cancelFlag = true;
  broadcast('log', { level: 'warn', message: 'Cancel requested — finishing current download, then stopping.' });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res, status, obj) {
  if (res.writableEnded) return;
  const body = JSON.stringify(obj);
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  } catch { /* client disconnected */ }
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) { sendJson(res, 403, { error: 'Forbidden' }); return; }
  fs.readFile(file, (err, data) => {
    if (err) { sendJson(res, 404, { error: 'Not found' }); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
}

function handleSse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  try { res.write(': connected\n\n'); } catch { clients.delete(res); return; }
  // replay recent history so the UI is up to date on (re)load, but skip
  // state-changing events — the fresh status line below is the source of truth.
  for (const evt of eventHistory) {
    if (evt.type === 'status' || evt.type === 'run_started' || evt.type === 'stage') continue;
    try { res.write(`data: ${JSON.stringify(evt)}\n\n`); } catch { clients.delete(res); return; }
  }
  try {
    res.write(`data: ${JSON.stringify({ type: 'status', ts: new Date().toISOString(), state, statusText, settings })}\n\n`);
  } catch { clients.delete(res); return; }
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  const p = url.pathname;

  if (p === '/api/events') { handleSse(req, res); return; }
  if (p === '/api/status') { sendJson(res, 200, { state, statusText, settings }); return; }
  if (p === '/api/config') { sendJson(res, 200, { settings }); return; }

  if (req.method === 'POST') {
    const body = await readBody(req);
    if (p === '/api/run') {
      const result = startRun(body);
      if (result.ok) sendJson(res, 200, { ok: true });
      else sendJson(res, 409, { ok: false, error: result.error });
      return;
    }
    if (p === '/api/cancel') {
      const result = cancelRun();
      if (result.ok) sendJson(res, 200, { ok: true });
      else sendJson(res, 409, { ok: false, error: result.error });
      return;
    }
    if (p === '/api/browse') {
      handleBrowseFolder(res);
      return;
    }
  }

  serveStatic(res, p);
});

// heartbeat keeps proxies from dropping idle SSE connections
const heartbeat = setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 25000);

// ---------------------------------------------------------------------------
// Port selection (PORT env, else first free in 3801..3820)
// ---------------------------------------------------------------------------
function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = netConnect({ port, host: HOST });
    probe.once('connect', () => { probe.destroy(); resolve(false); });
    probe.once('error', () => resolve(true));
  });
}

async function pickPort() {
  // Respect PORT only if it is actually free (the shell may export a PORT
  // that belongs to another app).
  if (process.env.PORT && Number(process.env.PORT) > 0 && await isPortFree(Number(process.env.PORT))) {
    return Number(process.env.PORT);
  }
  for (let port = 3801; port <= 3820; port++) {
    if (await isPortFree(port)) return port;
  }
  return 0; // let the OS choose
}

function openBrowser(url) {
  const cmd = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  const port = await pickPort();
  server.listen(port, HOST, () => {
    const url = `http://${HOST}:${port}/`;
    console.log('┌────────────────────────────────────────────────────────────┐');
    console.log('│  myAIE Lecture Recording Downloader — dashboard            │');
    console.log('└────────────────────────────────────────────────────────────┘');
    console.log(`  Dashboard:  ${url}`);
    console.log(`  Runs save to:  ${settings.dir}`);
    console.log('  Press Ctrl+C to stop the dashboard.');
    openBrowser(url);
  });
}

boot().catch((e) => {
  console.error('Failed to start dashboard:', e.message);
  process.exit(1);
});

// graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    clearInterval(heartbeat);
    console.log('\nShutting down…');
    process.exit(0);
  });
}
