/* myAIE Lecture Downloader — dashboard front end */
'use strict';

const $ = (id) => document.getElementById(id);

const els = {
  from: $('from'), to: $('to'), subject: $('subject'), dir: $('dir'),
  dryRun: $('dryRun'), headless: $('headless'), noAudit: $('noAudit'),
  fallbackRecording: $('fallbackRecording'), ytdlp: $('ytdlp'), max: $('max'), channel: $('channel'),
  runBtn: $('runBtn'), cancelBtn: $('cancelBtn'), browseBtn: $('browseBtn'),
  statusPill: $('statusPill'), statusText: $('statusText'), conn: $('conn'),
  scheduleBody: $('scheduleBody'), scheduleEmpty: $('scheduleEmpty'), scheduleCount: $('scheduleCount'),
  logBox: $('logBox'), clearLog: $('clearLog'), logFilter: $('logFilter'),
  toast: $('toast'),
  statDown: $('statDown'), statSkip: $('statSkip'), statFail: $('statFail'), statPending: $('statPending'),
  runProgress: $('runProgress'), runProgressBar: $('runProgressBar'), runProgressText: $('runProgressText'),
  hint: $('hint'), hintClose: $('hintClose'),
  appVersion: $('appVersion'), footerVersion: $('footerVersion'),
};

const state = { running: false, rows: new Map(), logLines: [], filter: 'all', runProgress: { done: 0, total: 0 } };

/* ---------------- toast ---------------- */
let toastTimer = null;
function toast(message, isError) {
  els.toast.textContent = message;
  els.toast.classList.toggle('error', !!isError);
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 3800);
}

/* ---------------- log ---------------- */
const LEVEL_LABEL = { info: 'INFO', ok: 'OK', warn: 'WARN', err: 'ERR', step: 'STEP', debug: 'DEBUG' };
const FILTER_LEVELS = {
  all: ['info', 'ok', 'warn', 'err', 'step', 'debug'],
  info: ['info', 'ok', 'step', 'debug'],
  warn: ['warn', 'err'],
  err: ['err'],
};

function tsTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-GB', { hour12: false });
  } catch { return '--:--:--'; }
}

function logVisible(level) {
  return FILTER_LEVELS[state.filter]?.includes(level) ?? true;
}

function appendLogLine(level, message, iso) {
  const line = document.createElement('div');
  line.className = `log-line ${level}`;
  line.innerHTML = '';
  const t = document.createElement('span');
  t.className = 't'; t.textContent = tsTime(iso);
  const lv = document.createElement('span');
  lv.className = 'lv ' + level; lv.textContent = LEVEL_LABEL[level] || level.toUpperCase();
  const msg = document.createElement('span');
  msg.className = 'msg'; msg.textContent = message;
  line.append(t, lv, msg);

  const nearBottom = els.logBox.scrollHeight - els.logBox.scrollTop - els.logBox.clientHeight < 40;
  els.logBox.appendChild(line);
  if (!logVisible(level)) line.style.display = 'none';

  state.logLines.push(line);
  if (state.logLines.length > 2500) {
    const removed = state.logLines.splice(0, state.logLines.length - 2500);
    removed.forEach((el) => el.remove());
  }
  if (nearBottom) els.logBox.scrollTop = els.logBox.scrollHeight;
  els.logBox.querySelector('.log-placeholder')?.remove();
}

function applyLogFilter() {
  for (const line of state.logLines) {
    const level = line.classList[1]; // log-line <level>
    line.style.display = logVisible(level) ? '' : 'none';
  }
}

function clearLog() {
  els.logBox.innerHTML = '';
  state.logLines = [];
  const ph = document.createElement('div');
  ph.className = 'log-placeholder';
  ph.textContent = 'Log cleared — next run will appear here.';
  els.logBox.appendChild(ph);
}

/* ---------------- run progress ---------------- */
function resetProgress() {
  state.runProgress = { done: 0, total: 0 };
  els.runProgressBar.style.width = '0%';
  els.runProgressText.textContent = '0%';
  els.runProgress.hidden = true;
}

function setProgressTotal(rows) {
  state.runProgress.total = rows.filter((r) => r.status === 'ready').length;
  updateProgress();
}

function updateProgress() {
  const { done, total } = state.runProgress;
  if (!total) return;
  const pct = Math.min(100, Math.round((done / total) * 100));
  els.runProgressBar.style.width = pct + '%';
  els.runProgressText.textContent = pct + '%';
  els.runProgress.hidden = false;
}

/* ---------------- schedule table ---------------- */
function rowKey(r) { return `${r.date}|${r.classId || r.subject || Math.random()}`; }

function chip(label, kind) {
  const el = document.createElement('span');
  el.className = 'chip ' + kind;
  if (kind === 'downloading') {
    const spin = document.createElement('span');
    spin.className = 'spin';
    el.append(spin, document.createTextNode(label));
  } else {
    el.textContent = label;
  }
  return el;
}

function renderSchedule(rows) {
  els.scheduleBody.innerHTML = '';
  state.rows.clear();
  if (!rows.length) {
    els.scheduleEmpty.textContent = 'No events found in the selected date range.';
    els.scheduleEmpty.style.display = '';
    els.scheduleCount.textContent = '0 events';
    return;
  }
  els.scheduleEmpty.style.display = 'none';
  els.scheduleCount.textContent = `${rows.length} event${rows.length === 1 ? '' : 's'}`;

  for (const r of rows) {
    const tr = document.createElement('tr');
    const tdDate = document.createElement('td');
    tdDate.className = 'date-cell'; tdDate.textContent = r.date;
    const tdSubj = document.createElement('td');
    tdSubj.className = 'subj-cell'; tdSubj.textContent = r.subject || '(no subject)';
    const tdId = document.createElement('td');
    tdId.className = 'id-cell'; tdId.textContent = r.classId || '-';
    const tdRec = document.createElement('td');
    const kind = r.status === 'ready' ? 'ready' : r.status === 'not recorded' ? 'not-recorded' : 'pending';
    const label = r.status === 'ready' ? 'Download ready' : r.status === 'not recorded' ? 'Not recorded' : 'Recording pending';
    const chipEl = chip(label, kind);
    tdRec.appendChild(chipEl);
    tr.append(tdDate, tdSubj, tdId, tdRec);
    els.scheduleBody.appendChild(tr);
    state.rows.set(rowKey(r), { tr, chip: chipEl });
  }
}

function updateRow(key, { chipLabel, chipKind, rowClass }) {
  const entry = state.rows.get(key);
  if (!entry) return;
  if (chipLabel !== undefined && chipKind) {
    const fresh = chip(chipLabel, chipKind);
    entry.chip.replaceWith(fresh);
    entry.chip = fresh;
  }
  if (rowClass) entry.tr.className = rowClass;
}

const ITEM_CHIP = {
  started: () => ({ chipLabel: 'Downloading…', chipKind: 'downloading' }),
  downloaded: (it) => ({ chipLabel: 'Saved ✓', chipKind: 'done', rowClass: 'dl', detail: it.detail }),
  failed: () => ({ chipLabel: 'Failed', chipKind: 'failed', rowClass: 'failed' }),
  skipped: (it) => ({ chipLabel: 'Already present', chipKind: 'skipped', detail: it.detail }),
};

function handleItem(it) {
  const key = rowKey(it.row);
  const fmt = ITEM_CHIP[it.kind];
  if (!fmt) return;
  const upd = fmt(it);
  updateRow(key, upd);
  if (it.kind === 'downloaded' || it.kind === 'failed' || it.kind === 'skipped') {
    state.runProgress.done++;
    updateProgress();
  }
}

/* ---------------- status / controls ---------------- */
function setStatus(stateName, text) {
  els.statusPill.className = 'status-pill ' + (stateName === 'idle' ? '' : stateName === 'done' ? 'done' : stateName === 'error' ? 'error' : 'running');
  els.statusText.textContent = text || stateName;
}

function setRunning(running) {
  state.running = running;
  els.runBtn.disabled = running;
  els.cancelBtn.disabled = !running;
  if (running) {
    els.runBtn.innerHTML = '<span class="icon">&#9654;</span> Starting…';
    els.runBtn.setAttribute('aria-label', 'Starting download');
  } else {
    els.runBtn.innerHTML = '<span class="icon">&#9654;</span> Start download';
    els.runBtn.setAttribute('aria-label', 'Start download');
  }
}

function setStats(s) {
  els.statDown.textContent = s.downloaded ?? 0;
  els.statSkip.textContent = s.skipped ?? 0;
  els.statFail.textContent = s.failed ?? 0;
  els.statPending.textContent = s.pending ?? 0;
}

function resetRunView() {
  resetProgress();
  els.scheduleBody.innerHTML = '';
  state.rows.clear();
  els.scheduleEmpty.textContent = 'Running… waiting for the calendar.';
  els.scheduleEmpty.style.display = '';
  els.scheduleCount.textContent = '…';
  setStats({ downloaded: 0, skipped: 0, failed: 0, pending: 0 });
}

/* ---------------- SSE ---------------- */
function connect() {
  const es = new EventSource('/api/events');
  els.conn.textContent = 'live';
  els.conn.className = 'conn on';

  es.onmessage = (e) => {
    let evt;
    try { evt = JSON.parse(e.data); } catch { return; }
    switch (evt.type) {
      case 'status':
        setStatus(evt.state, evt.statusText);
        if (evt.state === 'running' && !state.running) setRunning(true);
        if (evt.state !== 'running' && state.running) setRunning(false);
        // Only sync the form from server settings when idle, so a run
        // finishing never clobbers fields the user is mid-editing.
        if (evt.settings && evt.state === 'idle') populate(evt.settings);
        break;
      case 'run_started':
        resetRunView();
        appendLogLine('step', 'Run started.', evt.ts);
        break;
      case 'stage':
        setStatus('running', evt.stage);
        break;
      case 'log':
        appendLogLine(evt.level, evt.message, evt.ts);
        break;
      case 'schedule':
        renderSchedule(evt.rows);
        setProgressTotal(evt.rows);
        break;
      case 'item':
        handleItem(evt.item);
        break;
      case 'run_finished':
        setStats(evt.summary);
        appendLogLine('ok', evt.cancelled ? 'Run cancelled.' : 'Run finished.', evt.ts);
        break;
      case 'run_error':
        appendLogLine('err', 'Run error: ' + evt.error, evt.ts);
        break;
    }
  };

  es.onerror = () => {
    els.conn.textContent = 'reconnecting…';
    els.conn.className = 'conn off';
    // EventSource reconnects automatically; if the server is gone it keeps trying.
  };
}

/* ---------------- form ---------------- */
function populate(settings) {
  els.from.value = settings.from || '';
  els.to.value = settings.to || '';
  els.subject.value = settings.subject || '';
  els.dir.value = settings.dir || '';
  els.dryRun.checked = !!settings.dryRun;
  els.headless.checked = !!settings.headless;
  els.noAudit.checked = !!settings.noAudit;
  els.fallbackRecording.checked = !!settings.fallbackRecording;
  els.ytdlp.checked = !!settings.ytdlp;
  els.max.value = settings.max || '';
  els.channel.value = settings.channel || 'chrome';
}

function collectForm() {
  return {
    from: els.from.value,
    to: els.to.value,
    subject: els.subject.value.trim(),
    dir: els.dir.value.trim(),
    max: els.max.value,
    channel: els.channel.value,
    dryRun: els.dryRun.checked,
    headless: els.headless.checked,
    noAudit: els.noAudit.checked,
    fallbackRecording: els.fallbackRecording.checked,
    ytdlp: els.ytdlp.checked,
  };
}

function localDateStr(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function applyPreset(days) {
  const today = new Date();
  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - days);
  els.from.value = localDateStr(from);
  els.to.value = localDateStr(today);
}

async function browseFolder() {
  els.browseBtn.disabled = true;
  els.browseBtn.textContent = '…';
  try {
    const res = await fetch('/api/browse', { method: 'POST' });
    const data = await res.json();
    if (data.ok && data.path) {
      els.dir.value = data.path;
    } else if (data.error) {
      toast(data.error + ' Type the path manually.', true);
    } else {
      toast('No folder chosen.', true);
    }
  } catch {
    toast('Folder picker failed — type the path manually.', true);
  } finally {
    els.browseBtn.disabled = false;
    els.browseBtn.textContent = 'Browse…';
  }
}

/* ---------------- actions ---------------- */
async function startRun() {
  if (state.running) return;
  const form = collectForm();
  if (!form.from || !form.to) { toast('Please choose both dates.', true); return; }
  if (!form.dir) { toast('Please choose a download folder.', true); return; }
  if (form.from > form.to) { toast('"From" must be before "To".', true); return; }

  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      toast(data.error || 'Could not start the run.', true);
      return;
    }
    // SSE 'run_started' will reset the view; flip the buttons immediately for responsiveness
    setRunning(true);
  } catch {
    toast('Could not reach the dashboard server.', true);
  }
}

async function cancelRun() {
  if (!state.running) return;
  try {
    const res = await fetch('/api/cancel', { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.ok) toast(data.error || 'Could not cancel.', true);
  } catch {
    toast('Could not reach the dashboard server.', true);
  }
}

/* ---------------- init ---------------- */
function init() {
  // load persisted settings + version
  fetch('/api/config')
    .then((r) => r.json())
    .then((d) => {
      populate(d.settings);
      if (d.version) {
        const v = 'v' + d.version;
        els.appVersion.textContent = v;
        els.footerVersion.textContent = v;
      }
    })
    .catch(() => {});

  // dismissible quick-start hint (remembered between sessions)
  if (localStorage.getItem('myaie-hint') === '1') {
    els.hint.style.display = 'none';
  } else {
    els.hintClose.addEventListener('click', () => {
      els.hint.style.display = 'none';
      localStorage.setItem('myaie-hint', '1');
    });
  }

  clearLog();

  els.runBtn.addEventListener('click', startRun);
  els.cancelBtn.addEventListener('click', cancelRun);
  els.browseBtn.addEventListener('click', browseFolder);

  for (const btn of document.querySelectorAll('.preset')) {
    btn.addEventListener('click', () => applyPreset(Number(btn.dataset.days)));
  }

  for (const btn of els.logFilter.querySelectorAll('button')) {
    btn.addEventListener('click', () => {
      els.logFilter.querySelectorAll('button').forEach((b) => {
        b.classList.remove('active');
        b.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');
      state.filter = btn.dataset.level;
      applyLogFilter();
    });
  }

  els.clearLog.addEventListener('click', clearLog);

  connect();
}

init();
