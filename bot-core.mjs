/**
 * bot-core.mjs — myAIE Student Portal lecture-recording downloader (engine)
 *
 * Pure engine, no CLI/GUI concerns: `runBot(cfg, events)` drives the portal
 * and reports everything through event callbacks so any front end (terminal,
 * web dashboard, ...) can render a live view.
 *
 * Events (all optional):
 *   log(level, message)      level: info|ok|warn|err|step|debug
 *   stage(stageName)         launching|opening-portal|waiting-login|
 *                            fetching-calendar|filtering|downloading|done
 *   schedule(rows)           detected schedule, after filtering/classification
 *   item({kind, row, detail}) kind: skipped|started|downloaded|failed
 *   summary(summary)         {downloaded, skipped, failed, pending, cancelled}
 *   isCancelled()            return true to abort between steps/downloads
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

// ---------------------------------------------------------------------------
// Constants (discovered from the portal's JS bundles)
// ---------------------------------------------------------------------------
export const DEFAULT_API_BASE = 'https://testapi.myaie.ac/api/v1';
export const CALENDAR_URL = 'https://student.myaie.ac/calendar';
export const HOME_URL = 'https://student.myaie.ac/home/';
export const PORTAL_ORIGIN = 'https://student.myaie.ac';

export const EXT_BY_MIME = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/x-matroska': '.mkv',
  'video/quicktime': '.mov',
  'video/mpeg': '.mpeg',
  'application/x-mpegURL': '.m3u8',
  'audio/mp4': '.m4a',
  'application/octet-stream': '.mp4',
};

export const DATE_KEYS = [
  'startDateTime', 'startDate', 'start', 'StartDate', 'StartDateTime',
  'date', 'classDate', 'class_date', 'meetingDate', 'meeting_date',
  'from', 'start_time', 'startTime', 'classDateTime',
];

export const SUBJECT_KEYS = ['class_title', 'subjectName', 'subject', 'title', 'classTitle', 'subject_name'];

// ---------------------------------------------------------------------------
// Pure helpers (exported for selftest / reuse)
// ---------------------------------------------------------------------------
export function dateStr(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d;
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    const c1 = new Date(y, b - 1, a); // day-first
    const c2 = new Date(y, a - 1, b); // month-first
    if (!Number.isNaN(c1.getTime()) && a <= 12) return c1;
    if (!Number.isNaN(c2.getTime())) return c2;
  }
  return null;
}

export function pick(ev, keys) {
  for (const k of keys) {
    const v = ev?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

export function parseEventDate(ev) {
  const raw = pick(ev, DATE_KEYS);
  if (raw === undefined) return null;
  if (typeof raw === 'number') {
    const d = new Date(raw < 1e12 ? raw * 1000 : raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof raw === 'string') {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
    return parseDate(raw);
  }
  return null;
}

export function eventSubject(ev) {
  const s = pick(ev, SUBJECT_KEYS);
  return s === undefined ? '' : String(s);
}

export function eventClassId(ev) {
  const v = pick(ev, ['class_id', 'classId', 'id']);
  return v === undefined || v === null ? '' : String(v);
}

export function isRecorded(ev) {
  const v = pick(ev, ['IsRecorded', 'is_recorded', 'isRecorded']);
  return v === 1 || v === '1' || v === true;
}

export function isDownloadable(ev) {
  // Class sessions expose downloadURL + isRecordingAvailable; the calendar
  // table variant uses DownloadAvailable. A missing flag means "unknown —
  // rely on the URL"; explicit 0/false/null means "not ready yet".
  const v = pick(ev, ['DownloadAvailable', 'downloadAvailable', 'isRecordingAvailable']);
  if (v === undefined || v === null || v === '') return true;
  return !(v === 0 || v === '0' || v === false || v === 'false');
}

export function looksLikeDirectMedia(url) {
  if (!url) return false;
  if (/vimeo\.com|youtube\.com|youtu\.be|player\.vimeo/i.test(url)) return false;
  if (/index\.html|playback|player/i.test(url)) return false;
  return true;
}

export function looksYtDlpSupported(url) {
  return /vimeo\.com|youtube\.com|youtu\.be|player\.vimeo/i.test(String(url || ''));
}

// The class feed usually has no downloadURL field: the portal renders the
// "Download" button server-side into the `recordings` HTML as
//   <button ... url="https://playback.myaie.ac/presentation_video/<meetingId>/video.mp4"
//             class="... download-video" ...>
export function extractRecordingsUrl(html) {
  if (!html || typeof html !== 'string') return null;
  // 1) the Download button's url attribute
  const btn = html.match(/<button[^>]*url\s*=\s*["']([^"']+)["'][^>]*class\s*=\s*["'][^"']*download-video/i);
  if (btn && btn[1]) return btn[1].trim();
  // 2) any url="...mp4" attribute
  const any = html.match(/url\s*=\s*["']([^"']*\.mp4[^"']*)["']/i);
  if (any && any[1]) return any[1].trim();
  // 3) any absolute .mp4 link
  const href = html.match(/https?:\/\/[^"'\s<>]*\.mp4[^"'\s<>]*/i);
  return href ? href[0] : null;
}

export function resolvePortalUrl(u) {
  try { return new URL(u, PORTAL_ORIGIN).toString(); } catch { return u; }
}

export function pickDownloadUrl(ev, fallbackToRecording, allowEmbed = false) {
  const dl = pick(ev, ['downloadURL', 'downloadUrl', 'download_url']);
  if (dl) return resolvePortalUrl(String(dl));
  // No downloadURL: the Download button lives in the server-rendered recordings HTML.
  const recHtml = pick(ev, ['recordings']);
  if (recHtml) {
    const u = extractRecordingsUrl(String(recHtml));
    if (u) return resolvePortalUrl(u);
  }
  if (fallbackToRecording) {
    const rec = pick(ev, ['recordingURL', 'recordingUrl', 'recording_url']);
    if (rec) {
      const s = String(rec);
      if (allowEmbed) {
        // Embedded player pages (Vimeo/YouTube) are usable when yt-dlp is on.
        if (looksLikeDirectMedia(s) || looksYtDlpSupported(s)) return resolvePortalUrl(s);
      } else if (looksLikeDirectMedia(s)) {
        return resolvePortalUrl(s);
      }
    }
  }
  return null;
}

export function shortUrl(u) {
  if (!u) return '';
  try { return String(u).split('?')[0]; } catch { return u; }
}

export function sanitize(name) {
  return String(name).replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120) || 'unknown';
}

export function extractList(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  if (payload && payload.data && Array.isArray(payload.data.data)) return payload.data.data;
  if (payload && Array.isArray(payload.records)) return payload.records;
  if (payload && Array.isArray(payload.list)) return payload.list;
  if (payload && Array.isArray(payload.result)) return payload.result;
  return [];
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
export function buildConfig(parts, baseDir = process.cwd()) {
  const resolve = (p) => (p ? path.resolve(baseDir, String(p)) : null);
  const parseDateOrNull = (s) => {
    if (s === undefined || s === null || s === '') return null;
    return parseDate(String(s));
  };
  const fromProvided = parts.from !== undefined && parts.from !== null && String(parts.from).trim() !== '';
  const toProvided = parts.to !== undefined && parts.to !== null && String(parts.to).trim() !== '';

  const c = {
    from: parseDateOrNull(parts.from),
    to: parseDateOrNull(parts.to),
    subject: String(parts.subject || '').toLowerCase(),
    max: parts.max === undefined || parts.max === null || parts.max === '' ? null : parseInt(parts.max, 10),
    dir: resolve(parts.dir) || path.join(baseDir, 'downloads'),
    profile: resolve(parts.profile) || path.join(baseDir, 'chrome-profile'),
    channel: parts.channel || 'chrome',
    executablePath: parts.executablePath || undefined,
    apiBase: parts.apiBase || DEFAULT_API_BASE,
    loginTimeout: parts.loginTimeout ? parseInt(parts.loginTimeout, 10) : 300,
    dryRun: !!parts.dryRun,
    inspect: !!parts.inspect,
    headless: !!parts.headless,
    noAudit: !!parts.noAudit,
    fallbackRecording: !!parts.fallbackRecording,
    ytdlp: !!parts.ytdlp,
    ytDlpPath: parts.ytDlpPath || undefined,
    ytDlpTimeout: parts.ytDlpTimeout ? parseInt(parts.ytDlpTimeout, 10) : 1200,
    verbose: !!parts.verbose,
    inspectPath: path.join(baseDir, 'calendar_dump.json'),
  };

  if (fromProvided && !c.from) throw new Error(`Invalid --from date: ${parts.from} (use YYYY-MM-DD)`);
  if (toProvided && !c.to) throw new Error(`Invalid --to date: ${parts.to} (use YYYY-MM-DD)`);
  if (c.from && Number.isNaN(c.from.getTime())) throw new Error(`Invalid --from date: ${parts.from}`);
  if (c.to && Number.isNaN(c.to.getTime())) throw new Error(`Invalid --to date: ${parts.to}`);
  if (c.from && c.to && c.from.getTime() > c.to.getTime()) throw new Error('--from must be <= --to');
  if (c.max !== null && (!Number.isInteger(c.max) || c.max <= 0)) throw new Error('--max must be a positive integer');
  if (!c.channel && !c.executablePath) c.channel = 'chrome';

  const now = new Date();
  if (!c.from) c.from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 90);
  if (!c.to) c.to = now;
  return c;
}

// ---------------------------------------------------------------------------
// Browser launch (persistent profile => login persists between runs)
// ---------------------------------------------------------------------------
async function launchBrowser(cfg) {
  const options = {
    channel: cfg.channel,
    headless: cfg.headless,
    acceptDownloads: true,
    downloadsPath: path.join(cfg.dir, '.tmp'),
    viewport: { width: 1366, height: 900 },
  };
  if (cfg.executablePath) {
    delete options.channel;
    options.executablePath = cfg.executablePath;
  }
  fs.mkdirSync(cfg.profile, { recursive: true });
  fs.mkdirSync(cfg.dir, { recursive: true });
  fs.mkdirSync(options.downloadsPath, { recursive: true });

  let context;
  try {
    context = await chromium.launchPersistentContext(cfg.profile, options);
  } catch (e) {
    const hint =
      /executable doesn't exist/i.test(e.message) || /channel.*not installed/i.test(e.message)
        ? '\n  Hint: Chrome was not found. Use --channel edge or --executable-path "C:\path\to\chrome.exe".'
        : '';
    throw new Error('Failed to launch Chrome: ' + e.message + hint);
  }
  return { context, browser: context.browser() };
}

// ---------------------------------------------------------------------------
// In-page API access (uses the session's Bearer token from localStorage)
// ---------------------------------------------------------------------------
async function pageFetchJson(page, apiBase, token, apiPath) {
  return page.evaluate(
    async ({ apiBase, apiPath, token }) => {
      const res = await fetch(apiBase + apiPath, {
        headers: {
          Accept: 'application/json, text/plain, */*',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, ok: res.ok, json, preview: text.slice(0, 400) };
    },
    { apiBase, apiPath, token }
  );
}

async function getToken(page) {
  return page.evaluate(() => localStorage.getItem('token'));
}

async function getUserId(page) {
  try {
    const raw = await page.evaluate(() => localStorage.getItem('user'));
    const u = raw ? JSON.parse(raw) : null;
    if (u && u.id) return u.id;
  } catch { /* not JSON */ }
  return null;
}

// The portal keeps per-subject class feeds. Subjects come from
// getAllSubjectCalendar; each subject's sessions (with isRecorded,
// downloadURL, recordingURL, class_date) come from the paginated
// getPostFeedMessagesPaginateTz feed.
async function fetchAllClasses(page, cfg, log) {
  const token = await getToken(page);
  if (!token) throw new Error('No token found in localStorage — are you logged in?');
  const userId = await getUserId(page);
  if (!userId) throw new Error('Could not read your user id from localStorage — are you logged in?');
  log('debug', 'Bearer token + user id present.');

  log('step', `Fetching subjects via ${cfg.apiBase}/getAllSubjectCalendar ...`);
  const subjRes = await pageFetchJson(page, cfg.apiBase, token, '/getAllSubjectCalendar');
  if (subjRes.status === 401 || subjRes.status === 403) {
    throw new Error(`Calendar API returned HTTP ${subjRes.status} — session expired. Log in again in the opened browser and rerun.`);
  }
  if (!subjRes.ok) {
    throw new Error(`Calendar API returned HTTP ${subjRes.status}. Body preview: ${subjRes.preview}`);
  }
  const subjects = extractList(subjRes.json);
  if (subjects.length === 0) log('warn', 'Subject calendar returned no subjects (or an unexpected shape).');
  log('ok', `${subjects.length} subject(s) found.`);

  const classes = [];
  for (const subj of subjects) {
    const sid = pick(subj, ['id', 'subjectId', 'subject_id', 'room_id']);
    if (sid === undefined) continue;
    const sname = pick(subj, ['name', 'subjectName', 'subject', 'subject_name']) ?? sid;
    log('info', `  fetching classes for "${sname}" ...`);
    let pageNum = 1, lastPage = 1;
    while (pageNum <= lastPage && pageNum <= 25) {
      const feedPath = `/getPostFeedMessagesPaginateTz?page=${pageNum}&limit=50&needOnlineClass=1&room_id=${encodeURIComponent(sid)}&user_id=${encodeURIComponent(userId)}`;
      const res = await pageFetchJson(page, cfg.apiBase, token, feedPath);
      if (!res.ok) { log('warn', `    feed page ${pageNum} failed (HTTP ${res.status})`); break; }
      const payload = res.json || {};
      if (Number.isInteger(payload.lastPage)) lastPage = payload.lastPage;
      const items = Array.isArray(payload.data) ? payload.data : [];
      for (const it of items) {
        const ca = it && it.ClassArray;
        if (Array.isArray(ca)) classes.push(...ca);
        else if (ca) classes.push(ca);
      }
      pageNum++;
    }
  }
  log('ok', `Collected ${classes.length} class session(s) across ${subjects.length} subject(s).`);
  return classes;
}

async function fireAuditCall(page, cfg, classId) {
  if (cfg.noAudit || !classId) return;
  try {
    const token = await page.evaluate(() => localStorage.getItem('token'));
    await pageFetchJson(page, cfg.apiBase, token,
      `/saveRecordingAction?id=${encodeURIComponent(classId)}&action=download_recording`);
  } catch { /* audit call is best-effort */ }
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------
async function downloadViaBrowser(context, url, targetPath) {
  const page = await context.newPage();
  const dlPromise = page.waitForEvent('download', { timeout: 60000 }).catch(() => null);
  let navErr = null;
  let gotResponse = false;
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    gotResponse = !!resp;
    if (resp) {
      if (!resp.ok()) navErr = 'HTTP ' + resp.status();
      else if ((resp.headers()['content-type'] || '').startsWith('text/html')) {
        navErr = 'server returned an HTML page, not a direct media file';
      }
    }
  } catch (e) {
    navErr = e.message; // navigation may abort when a download starts — that is fine
  }
  let dl = null;
  if (navErr) {
    dl = await Promise.race([dlPromise, Promise.resolve(null)]); // known failure — skip waiting
  } else if (gotResponse) {
    // Page loaded fine (e.g. video plays in-tab). Give downloads a short grace
    // window, then fall back to streaming instead of stalling the full timeout.
    dl = await Promise.race([dlPromise, new Promise((r) => setTimeout(() => r(null), 3000))]);
  } else {
    dl = await dlPromise; // navigation aborted — a download is likely on its way
  }
  await page.close().catch(() => {});
  if (!dl) throw new Error(navErr || 'no download was triggered');
  await dl.saveAs(targetPath);
  return dl.suggestedFilename() || '';
}

async function streamDownload(context, url, targetPath) {
  const cookies = await context.cookies(url);
  const cookieHeader = cookies.map((ck) => `${ck.name}=${ck.value}`).join('; ');
  const resp = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(5 * 60 * 1000),
    headers: {
      Cookie: cookieHeader,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      Accept: '*/*',
    },
  });
  if (!resp.ok) throw new Error('stream HTTP ' + resp.status());
  const contentType = resp.headers.get('content-type') || '';
  if (contentType.startsWith('text/html')) throw new Error('stream returned HTML, not a media file');
  await new Promise((resolve, reject) => {
    Readable.fromWeb(resp.body).pipe(fs.createWriteStream(targetPath))
      .on('finish', resolve)
      .on('error', reject);
  });
  return contentType;
}

function ensureMediaExt(filePath, preferred) {
  if (!preferred) return filePath;
  const m = preferred.match(/\.[a-z0-9]{2,5}$/i);
  if (!m) return filePath;
  const ext = m[0].toLowerCase();
  const current = path.extname(filePath);
  if (current && current !== ext && Object.values(EXT_BY_MIME).includes(ext)) {
    const renamed = filePath.slice(0, filePath.length - current.length) + ext;
    try { fs.renameSync(filePath, renamed); return renamed; } catch { /* keep original */ }
  }
  return filePath;
}

function findExisting(dir, base) {
  const exts = [...new Set(Object.values(EXT_BY_MIME))];
  for (const ext of exts) {
    const p = path.join(dir, base + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || stdout || err.message).trim().slice(0, 500)));
      else resolve({ stdout, stderr });
    });
  });
}

const CORE_DIR = path.dirname(fileURLToPath(import.meta.url));

async function resolveYtDlp(cfg) {
  const candidates = [];
  if (cfg.ytDlpPath) candidates.push(cfg.ytDlpPath);
  candidates.push(path.join(CORE_DIR, 'yt-dlp.exe'), path.join(CORE_DIR, 'yt-dlp'));
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* not there */ }
  }
  return 'yt-dlp'; // rely on PATH
}

async function ytDlpAvailable(cfg) {
  try { await execFileAsync(await resolveYtDlp(cfg), ['--version'], { timeout: 15000 }); return true; }
  catch { return false; }
}

// Export the browser session's cookies (Netscape format) so yt-dlp can reach
// embedded/private videos exactly like your logged-in browser.
async function writeNetscapeCookies(context, url) {
  // Sweep cookie files left behind by hard-killed runs (they hold session cookies).
  try {
    for (const f of fs.readdirSync(os.tmpdir())) {
      if (!f.startsWith('myaie-ytdlp-')) continue;
      const fp = path.join(os.tmpdir(), f);
      try { if (Date.now() - fs.statSync(fp).mtimeMs > 6 * 3600 * 1000) fs.unlinkSync(fp); } catch { /* busy or gone */ }
    }
  } catch { /* temp dir unreadable */ }
  let cookies = [];
  try { cookies = await context.cookies(url); } catch { /* ignore */ }
  if (!cookies.length) return null;
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of cookies) {
    const dom = c.domain.startsWith('.') ? c.domain : '.' + c.domain;
    const exp = c.expires && c.expires > 0 ? Math.floor(c.expires) : 0;
    lines.push([dom, 'TRUE', c.path || '/', c.secure ? 'TRUE' : 'FALSE', exp, c.name, c.value].join('\t'));
  }
  const file = path.join(os.tmpdir(), `myaie-ytdlp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

async function downloadWithYtDlp(context, url, targetPath, cfg, log) {
  const exe = await resolveYtDlp(cfg);
  const base = targetPath.slice(0, targetPath.length - path.extname(targetPath).length);
  const t0 = Date.now();
  const args = [
    '--no-playlist', '--no-progress', '--newline',
    '--retries', '5', '--fragment-retries', '5',
    '-o', base + '.%(ext)s', url,
  ];
  let cookieFile = null;
  try {
    cookieFile = await writeNetscapeCookies(context, url);
    if (cookieFile) args.push('--cookies', cookieFile);
    log('debug', `  yt-dlp: ${exe} ${shortUrl(url)}`);
    const { stdout } = await execFileAsync(exe, args, { timeout: (cfg.ytDlpTimeout || 1200) * 1000 });
    const tail = stdout.split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' | ');
    if (tail) log('debug', '  yt-dlp: ' + tail);
  } catch (e) {
    return { ok: false, error: 'yt-dlp failed: ' + e.message };
  } finally {
    if (cookieFile) { try { fs.unlinkSync(cookieFile); } catch { /* ignore */ } }
  }
  // locate the file yt-dlp wrote (base + real extension)
  const dir = path.dirname(base);
  const prefix = path.basename(base) + '.';
  let best = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith(prefix)) continue;
      const fp = path.join(dir, f);
      const st = fs.statSync(fp);
      if (st.mtimeMs < t0 - 60000) continue; // stale file from before this run
      if (!best || st.size > best.size) best = { p: fp, size: st.size, ext: path.extname(f) };
    }
  } catch { /* no dir */ }
  if (!best) return { ok: false, error: 'yt-dlp finished but no output file was found' };
  let final = best.p;
  if (final !== targetPath) {
    const renamed = base + best.ext;
    try { if (final !== renamed) fs.renameSync(final, renamed); final = renamed; } catch { /* keep original */ }
  }
  return { ok: true, method: 'ytdlp', file: final, ext: best.ext };
}

async function downloadOne(context, url, targetPath, cfg, log) {
  // Embedded player pages (Vimeo/YouTube) can only be fetched with yt-dlp.
  if (cfg.ytdlp && looksYtDlpSupported(url)) {
    log('warn', '  embedded video detected — using yt-dlp ...');
    return downloadWithYtDlp(context, url, targetPath, cfg, log);
  }
  try {
    const suggested = await downloadViaBrowser(context, url, targetPath);
    return { ok: true, method: 'browser', suggested };
  } catch (e) {
    try {
      const ct = await streamDownload(context, url, targetPath);
      return { ok: true, method: 'stream', contentType: ct, browserError: e.message };
    } catch (e2) {
      if (cfg.ytdlp && looksYtDlpSupported(url)) {
        log('warn', `  direct download failed; trying yt-dlp ...`);
        return downloadWithYtDlp(context, url, targetPath, cfg, log);
      }
      return { ok: false, error: `${e.message} | ${e2.message}` };
    }
  }
}

// ---------------------------------------------------------------------------
// Selftest (pure logic, no browser)
// ---------------------------------------------------------------------------
export function runSelftest() {
  const assert = (cond, msg) => {
    if (!cond) { console.error('SELFTEST FAIL: ' + msg); process.exitCode = 1; }
    else console.log('  ok: ' + msg);
  };
  console.log('Running selftest ...');

  assert(dateStr(new Date(2026, 5, 7)) === '2026-06-07', 'dateStr pads correctly');
  assert(parseDate('2026-07-31').getMonth() === 6, 'parseDate ISO');
  assert(parseDate('31/07/2026').getMonth() === 6, 'parseDate day-first');
  assert(parseDate('07/31/2026').getMonth() === 6, 'parseDate month-first');

  const ev = {
    class_id: 123,
    class_title: 'Computer Networks',
    startDateTime: '2026-07-31T09:00:00',
    IsRecorded: 1,
    DownloadAvailable: 1,
    downloadURL: 'https://s3.af-south-1.amazonaws.com/x/y.mp4',
  };
  assert(dateStr(parseEventDate(ev)) === '2026-07-31', 'parseEventDate picks startDateTime');
  assert(eventSubject(ev) === 'Computer Networks', 'eventSubject');
  assert(eventClassId(ev) === '123', 'eventClassId');
  assert(isRecorded(ev), 'isRecorded true for 1');
  assert(isDownloadable(ev), 'isDownloadable true for 1');
  assert(isDownloadable({ DownloadAvailable: null }), 'isDownloadable null => true (lenient)');
  assert(!isDownloadable({ DownloadAvailable: 0 }), 'isDownloadable 0 => false');
  assert(isDownloadable({ isRecordingAvailable: 1 }), 'isRecordingAvailable 1 => true');
  assert(isDownloadable({}), 'isDownloadable missing flag => true');
  assert(pickDownloadUrl(ev, false) === ev.downloadURL, 'pickDownloadUrl');
  assert(!isRecorded({ IsRecorded: 0 }), 'isRecorded false for 0');
  assert(looksLikeDirectMedia('https://player.vimeo.com/video/123') === false, 'vimeo not direct media');
  assert(looksYtDlpSupported('https://player.vimeo.com/video/123') === true, 'vimeo is yt-dlp supported');
  assert(looksYtDlpSupported('https://playback.myaie.ac/playback23/index.html?m=1') === false, 'BBB player not yt-dlp supported');
  assert(pickDownloadUrl({ recordingURL: 'https://player.vimeo.com/video/123' }, true, true) === 'https://player.vimeo.com/video/123', 'allowEmbed picks vimeo');
  assert(pickDownloadUrl({ recordingURL: 'https://player.vimeo.com/video/123' }, true, false) === null, 'no embed without allowEmbed');

  // recordings HTML carries the Download button's url when downloadURL is absent
  const dlHtml = '<li><button name="X.mp4" url= "https://playback.myaie.ac/presentation_video/abc-123/video.mp4" class="btn btn-primary download-video" class_id="1"><i class="fal fa-download"></i> Download</button></li>';
  assert(extractRecordingsUrl(dlHtml) === 'https://playback.myaie.ac/presentation_video/abc-123/video.mp4', 'extractRecordingsUrl from download button');
  assert(extractRecordingsUrl('<li><a class="btn btn-primary class-files">Class Files</a></li>') === null, 'extractRecordingsUrl null when watch-only');
  assert(extractRecordingsUrl('') === null, 'extractRecordingsUrl empty');
  const feedEv = { class_date: '2026-07-05', class_title: 'OOP', class_id: 42, isRecorded: 1, isRecordingAvailable: 1, recordings: dlHtml };
  assert(pickDownloadUrl(feedEv, false) === 'https://playback.myaie.ac/presentation_video/abc-123/video.mp4', 'pickDownloadUrl from recordings HTML');
  assert(pickDownloadUrl({ recordings: '<li><a class="btn btn-primary class-files">Files</a></li>' }, false) === null, 'no URL from watch-only HTML');

  assert(extractList({ data: [1, 2] }).length === 2, 'extractList {data}');
  assert(extractList({ data: { data: [1] } }).length === 1, 'extractList nested');
  assert(extractList([1, 2, 3]).length === 3, 'extractList array');
  assert(extractList({ foo: 'bar' }).length === 0, 'extractList unknown shape');

  assert(sanitize('Object Oriented Programming') === 'Object_Oriented_Programming', 'sanitize');

  // date-range filtering
  const from = parseDate('2026-07-01'), to = parseDate('2026-07-31');
  const inRange = (d) => {
    const s = dateStr(d);
    return s >= dateStr(from) && s <= dateStr(to);
  };
  assert(inRange(parseEventDate(ev)), 'event inside range');
  assert(!inRange(parseEventDate({ startDateTime: '2026-08-01T09:00:00' })), 'event outside range');

  if (process.exitCode) { console.error('Selftest FAILED.'); process.exit(1); }
  console.log('Selftest PASSED.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main engine
// ---------------------------------------------------------------------------
export async function runBot(cfg, events = {}) {
  const log = (level, msg) => events.log && events.log(level, msg);
  const stage = (s) => events.stage && events.stage(s);
  const emitSchedule = (rows) => events.schedule && events.schedule(rows);
  const emitItem = (it) => events.item && events.item(it);
  const isCancelled = events.isCancelled || (() => false);
  const checkCancel = () => {
    if (isCancelled()) { log('warn', 'Cancellation requested — stopping.'); return true; }
    return false;
  };

  stage('launching');
  log('info', `Run started — date range ${dateStr(cfg.from)} → ${dateStr(cfg.to)}`);
  if (cfg.subject) log('info', `Subject filter: "${cfg.subject}"`);
  log('info', `Save folder: ${cfg.dir}`);
  log('info', `Browser: ${cfg.channel || cfg.executablePath}${cfg.headless ? ' (headless)' : ''}${cfg.dryRun ? ' (DRY RUN)' : ''}`);
  if (cfg.ytdlp) {
    if (cfg.ytDlpPath) {
      try { if (!fs.statSync(cfg.ytDlpPath).isFile()) throw new Error('not a file'); }
      catch { log('warn', `yt-dlp path not found: ${cfg.ytDlpPath} - falling back to the bundled binary / PATH.`); }
    }
    const ok = await ytDlpAvailable(cfg);
    if (ok) log('ok', 'yt-dlp available — embedded (Vimeo/YouTube) recordings will be downloaded with it.');
    else log('warn', 'yt-dlp requested but not found — run `pip install yt-dlp` or place yt-dlp.exe next to the bot (or set --yt-dlp-path); embedded videos will be skipped.');
  }

  const { context, browser } = await launchBrowser(cfg);
  let page;
  try {
    page = context.pages()[0] || (await context.newPage());
  } catch (e) {
    await context.close().catch(() => {});
    try { await browser.close(); } catch { /* already closed */ }
    throw e;
  }

  try {
    stage('opening-portal');
    log('step', 'Opening the portal calendar ...');
    await page.goto(CALENDAR_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(async () => {
      await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    });

    // ---- wait for login ----
    stage('waiting-login');
    const deadline = Date.now() + cfg.loginTimeout * 1000;
    let token = await page.evaluate(() => localStorage.getItem('token')).catch(() => null);
    while (!token && Date.now() < deadline) {
      if (checkCancel()) return { cancelled: true };
      log('warn', 'Not logged in yet — please log in in the opened Chrome window (the bot will continue automatically).');
      await page.waitForTimeout(4000);
      token = await page.evaluate(() => localStorage.getItem('token')).catch(() => null);
    }
    if (!token) throw new Error(`Login timeout (${cfg.loginTimeout}s). Log in and rerun — your session is saved in ${cfg.profile}`);
    log('ok', 'Logged in (session token found).');

    // ---- fetch subjects + class sessions ----
    stage('fetching-calendar');
    const classesArr = await fetchAllClasses(page, cfg, log);
    if (cfg.inspect) {
      fs.writeFileSync(cfg.inspectPath, JSON.stringify(classesArr, null, 2));
      log('ok', `Wrote ${classesArr.length} raw class sessions to ${cfg.inspectPath}`);
      log('info', 'Inspect mode — open that file to see the exact field names, then rerun without --inspect.');
      return { inspect: true, count: classesArr.length };
    }

    // ---- filter by date range + subject ----
    stage('filtering');
    const fromStr = dateStr(cfg.from), toStr = dateStr(cfg.to);
    const candidates = classesArr
      .map((ev) => ({ ev, date: parseEventDate(ev) }))
      .filter(({ date }) => date && dateStr(date) >= fromStr && dateStr(date) <= toStr)
      .filter(({ ev }) => !cfg.subject || eventSubject(ev).toLowerCase().includes(cfg.subject))
      .sort((a, b) => a.date - b.date);

    log('ok', `${candidates.length} class session(s) in the requested date range${cfg.subject ? ' for "' + cfg.subject + '"' : ''}.`);

    // ---- classify ----
    const rows = candidates.map(({ ev, date }) => {
      const url = pickDownloadUrl(ev, cfg.fallbackRecording, cfg.ytdlp);
      return {
        date: dateStr(date),
        subject: eventSubject(ev),
        classId: eventClassId(ev),
        url,
        status: !isRecorded(ev) ? 'not recorded' : (!url || !isDownloadable(ev)) ? 'recording pending' : 'ready',
      };
    });
    emitSchedule(rows);

    const ready = rows.filter((r) => r.status === 'ready');
    const pending = rows.filter((r) => r.status !== 'ready').length;
    if (checkCancel()) return { downloaded: 0, skipped: 0, failed: 0, pending, cancelled: true };
    if (cfg.dryRun) {
      log('ok', `DRY RUN — ${ready.length} recording(s) ready. Nothing was downloaded.`);
      return { downloaded: 0, skipped: 0, failed: 0, pending, wouldDownload: ready.length, dryRun: true };
    }
    if (ready.length === 0) {
      log('warn', 'Nothing to download (no ready recordings in range).');
      return { downloaded: 0, skipped: 0, failed: 0, pending };
    }

    // ---- download ----
    stage('downloading');
    const budget = cfg.max ?? ready.length;
    log('step', `Downloading (budget ${budget}, skipping files already present) ...`);
    fs.mkdirSync(cfg.dir, { recursive: true });

    let okCount = 0, skipCount = 0, failCount = 0;
    for (const r of ready) {
      if (checkCancel()) break;
      if (okCount >= budget) { log('info', 'Budget reached — stopping.'); break; }
      const base = sanitize(`${r.date}_${r.subject || 'subject'}_${r.classId || 'noid'}`);
      let target = path.join(cfg.dir, base + '.mp4');

      const existing = findExisting(cfg.dir, base);
      if (existing) {
        log('ok', `skipped (already downloaded): ${path.basename(existing)}`);
        emitItem({ kind: 'skipped', row: r, detail: path.basename(existing) });
        skipCount++;
        continue;
      }

      log('step', `  downloading: ${base}`);
      emitItem({ kind: 'started', row: r });
      await fireAuditCall(page, cfg, r.classId);

      const result = await downloadOne(context, r.url, target, cfg, log);
      if (!result.ok) {
        log('err', `  FAILED: ${result.error}`);
        emitItem({ kind: 'failed', row: r, detail: result.error });
        failCount++;
        try { fs.unlinkSync(target); } catch { /* not created */ }
        continue;
      }
      if (result.method === 'browser' && result.suggested) target = ensureMediaExt(target, result.suggested);
      else if (result.method === 'stream' && result.contentType) {
        const mimeExt = EXT_BY_MIME[result.contentType.split(';')[0].trim()];
        if (mimeExt) target = ensureMediaExt(target, mimeExt);
      } else if (result.method === 'ytdlp' && result.file) {
        target = result.file;
      }
      const sizeMb = fs.existsSync(target) ? (fs.statSync(target).size / 1e6).toFixed(1) : '?';
      log('ok', `  saved ${path.basename(target)} (${sizeMb} MB, via ${result.method}${result.browserError ? ' fallback' : ''})`);
      emitItem({ kind: 'downloaded', row: r, detail: path.basename(target), sizeMb, method: result.method });
      okCount++;
    }

    const cancelled = checkCancel();
    stage('done');
    const summary = { downloaded: okCount, skipped: skipCount, failed: failCount, pending, cancelled };
    log('step', 'Summary:');
    log('info', `  downloaded: ${okCount}`);
    log('info', `  already present / skipped: ${skipCount}`);
    if (failCount) log('err', `  failed: ${failCount}`);
    log('info', `  not recorded / pending in range: ${pending}`);
    if (cancelled) log('warn', '  run was cancelled before finishing.');
    return summary;
  } finally {
    await context.close().catch(() => {});
    try { await browser.close(); } catch { /* already closed */ }
  }
}
