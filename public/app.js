/* myAIE Lecture Downloader — dashboard front end */
'use strict';

const $ = (id) => document.getElementById(id);

const els = {
  from: $('from'), to: $('to'), subject: $('subject'), dir: $('dir'),
  dryRun: $('dryRun'), headless: $('headless'), noAudit: $('noAudit'),
  fallbackRecording: $('fallbackRecording'), ytdlp: $('ytdlp'), max: $('max'), channel: $('channel'),
  runBtn: $('runBtn'), scanBtn: $('scanBtn'), dlSelBtn: $('dlSelBtn'),
  scanFilesBtn: $('scanFilesBtn'), dlFilesBtn: $('dlFilesBtn'),
  cancelBtn: $('cancelBtn'), browseBtn: $('browseBtn'),
  scheduleSelectAll: $('scheduleSelectAll'),
  statusPill: $('statusPill'), statusText: $('statusText'), conn: $('conn'),
  scheduleBody: $('scheduleBody'), scheduleEmpty: $('scheduleEmpty'), scheduleCount: $('scheduleCount'),
  filesBody: $('filesBody'), filesEmpty: $('filesEmpty'), filesCount: $('filesCount'), filesSelectAll: $('filesSelectAll'),
  logBox: $('logBox'), clearLog: $('clearLog'), logFilter: $('logFilter'),
  toast: $('toast'),
  statDown: $('statDown'), statSkip: $('statSkip'), statFail: $('statFail'), statPending: $('statPending'),
  runProgress: $('runProgress'), runProgressBar: $('runProgressBar'), runProgressText: $('runProgressText'),
  hint: $('hint'), hintClose: $('hintClose'), hintGotIt: $('hintGotIt'), showTips: $('showTips'),
  appVersion: $('appVersion'), footerVersion: $('footerVersion'),
};

/* extra tooltips for controls without a data-tip attribute in the HTML */
const EXTRA_TIPS = {
  browseBtn: 'Open a folder picker and use the chosen folder as the download destination.',
  subject: 'Optional: only keep sessions whose subject name contains this text.',
  dir: 'Where the recordings and files are saved. Each video gets its own file here.',
  max: 'Cap how many recordings to download per run. Empty means no limit.',
  channel: 'Which browser the bot drives. Use the same one you log into the portal with.',
  dryRun: 'Preview only: scan and show what would download, but save nothing.',
  headless: 'Run the browser without a visible window after the first login is saved.',
  noAudit: 'Skip the portal audit call for faster runs on flaky connections.',
  fallbackRecording: 'If a download button is missing, try grabbing the recording URL directly.',
  ytdlp: 'Use yt-dlp as a fallback for embedded videos (Vimeo / YouTube) that have no direct file.',
  scheduleSelectAll: 'Tick every recording that is ready to download.',
  filesSelectAll: 'Tick every file in the list.',
  clearLog: 'Empty the live log below.',
  hintClose: 'Dismiss the quick-start tutorial.',
  cancelBtn: 'Stop after the current file finishes. Downloads already saved stay saved.',
};

function initTooltips() {
  for (const [id, tip] of Object.entries(EXTRA_TIPS)) {
    const el = $(id);
    if (el && !el.dataset.tip) el.setAttribute('data-tip', tip);
  }
  // checkbox labels are the hover targets (the tiny input itself is too small)
  for (const lbl of document.querySelectorAll('.check')) {
    const input = lbl.querySelector('input');
    if (input && !lbl.dataset.tip) lbl.setAttribute('data-tip', EXTRA_TIPS[input.id] || '');
  }
}

const state = { running: false, rows: new Map(), files: new Map(), logLines: [], filter: 'all', runProgress: { done: 0, total: 0 } };

function selectedClassIds() {
  const ids = [];
  for (const [key, entry] of state.rows) {
    if (entry.checkbox && entry.checkbox.checked) ids.push(entry.classId);
  }
  return ids;
}

function selectedFileIds() {
  const ids = [];
  for (const [key, entry] of state.files) {
    if (entry.checkbox && entry.checkbox.checked) ids.push(entry.id);
  }
  return ids;
}

function updateSelectionButtons() {
  const c = selectedClassIds().length;
  const f = selectedFileIds().length;
  els.dlSelBtn.disabled = state.running || c === 0;
  els.dlFilesBtn.disabled = state.running || f === 0;
  els.dlSelBtn.innerHTML = '<span class="icon">&#11015;</span> Download selected' + (c ? ` (${c})` : '');
  els.dlFilesBtn.innerHTML = '<span class="icon">&#11015;</span> Download files' + (f ? ` (${f})` : '');
}

function pickCheckbox(checked, enabled, ariaLabel) {
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!checked;
  cb.disabled = !enabled;
  cb.setAttribute('aria-label', ariaLabel);
  cb.addEventListener('change', updateSelectionButtons);
  return cb;
}

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
  els.runProgressBar.setAttribute('aria-valuenow', '0');
  els.runProgressText.textContent = '0%';
  els.runProgress.hidden = true;
}

function setProgressTotal(rows) {
  const ready = rows.filter((r) => r.status === 'ready').length;
  state.runProgress.total = state.selectionSize ? Math.min(ready, state.selectionSize) : ready;
  updateProgress();
}

function updateProgress() {
  const { done, total } = state.runProgress;
  if (!total) return;
  const pct = Math.min(100, Math.round((done / total) * 100));
  els.runProgressBar.style.width = pct + '%';
  els.runProgressBar.setAttribute('aria-valuenow', String(pct));
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

  els.scheduleSelectAll.checked = false;
  for (const r of rows) {
    const tr = document.createElement('tr');
    const tdPick = document.createElement('td');
    tdPick.className = 'pick-col';
    const canPick = r.status === 'ready' && !!r.classId;
    const cb = pickCheckbox(false, canPick, `Select recording ${r.subject || ''} ${r.date}${r.classId ? ' id ' + r.classId : ''}`.trim());
    tdPick.appendChild(cb);
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
    tr.append(tdPick, tdDate, tdSubj, tdId, tdRec);
    els.scheduleBody.appendChild(tr);
    state.rows.set(rowKey(r), { tr, chip: chipEl, checkbox: cb, classId: r.classId || '' });
  }
  updateSelectionButtons();
}

/* ---------------- news room files table ---------------- */
function renderFiles(files) {
  els.filesBody.innerHTML = '';
  state.files.clear();
  els.filesSelectAll.checked = false;
  if (!files.length) {
    els.filesEmpty.textContent = 'No downloadable files found in the selected date range.';
    els.filesEmpty.style.display = '';
    els.filesCount.textContent = '0 files';
    updateSelectionButtons();
    return;
  }
  els.filesEmpty.style.display = 'none';
  els.filesCount.textContent = `${files.length} file${files.length === 1 ? '' : 's'}`;

  for (const f of files) {
    const tr = document.createElement('tr');
    const tdPick = document.createElement('td');
    tdPick.className = 'pick-col';
    const cb = pickCheckbox(false, true, `Select file ${f.name}`);
    tdPick.appendChild(cb);
    const tdName = document.createElement('td');
    tdName.className = 'name-cell'; tdName.textContent = f.name;
    const tdSubj = document.createElement('td');
    tdSubj.className = 'subj-cell'; tdSubj.textContent = f.subject || '(no subject)';
    const tdSize = document.createElement('td');
    tdSize.className = 'size-cell'; tdSize.textContent = f.size || '?';
    const tdDate = document.createElement('td');
    tdDate.className = 'date-cell'; tdDate.textContent = f.date || '-';
    tr.append(tdPick, tdName, tdSubj, tdSize, tdDate);
    els.filesBody.appendChild(tr);
    state.files.set(f.id, { tr, checkbox: cb, id: f.id, sizeCell: tdSize });
  }
  updateSelectionButtons();
}

function updateFileRow(id, kind, detail) {
  const entry = state.files.get(id);
  if (!entry) return;
  if (kind === 'downloaded') {
    entry.sizeCell.textContent = '';
    entry.sizeCell.appendChild(chip('Saved ✓', 'done'));
    entry.tr.className = 'dl';
  } else if (kind === 'failed') {
    entry.sizeCell.textContent = '';
    entry.sizeCell.appendChild(chip('Failed', 'failed'));
    entry.tr.className = 'failed';
  } else if (kind === 'started') {
    entry.sizeCell.textContent = '';
    entry.sizeCell.appendChild(chip('Downloading…', 'downloading'));
  } else if (kind === 'skipped') {
    entry.sizeCell.textContent = '';
    entry.sizeCell.appendChild(chip('Already present', 'skipped'));
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
  els.scanBtn.disabled = running;
  els.scanFilesBtn.disabled = running;
  els.cancelBtn.disabled = !running;
  updateSelectionButtons();
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
        if (evt.kind !== 'files-scan' && evt.kind !== 'files-download') resetRunView();
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
      case 'files':
        renderFiles(evt.files);
        break;
      case 'file_item':
        updateFileRow(evt.item.file.id, evt.item.kind, evt.item.detail);
        break;
      case 'run_finished':
        if (evt.filesSummary) {
          setStats({ downloaded: evt.filesSummary.downloaded ?? 0, skipped: evt.filesSummary.skipped ?? 0, failed: evt.filesSummary.failed ?? 0, pending: 0 });
        } else if (evt.filesCount !== undefined) {
          setStats({ downloaded: 0, skipped: 0, failed: 0, pending: 0 });
          appendLogLine('ok', `Found ${evt.filesCount} file(s) — tick the ones you want, then hit Download files.`, evt.ts);
          return;
        } else {
          setStats(evt.summary);
        }
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
function formValid() {
  const form = collectForm();
  if (!form.from || !form.to) { toast('Please choose both dates.', true); return null; }
  if (!form.dir) { toast('Please choose a download folder.', true); return null; }
  if (form.from > form.to) { toast('"From" must be before "To".', true); return null; }
  return form;
}

async function postRun(path, body) {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      toast(data.error || 'Could not start the run.', true);
      return false;
    }
    setRunning(true); // SSE 'run_started' will reset the view; flip buttons now for responsiveness
    return true;
  } catch {
    toast('Could not reach the dashboard server.', true);
    return false;
  }
}

async function findRecordings() {
  if (state.running) return;
  const form = formValid();
  if (!form) return;
  appendLogLine('step', 'Scanning the calendar for downloadable recordings …', new Date().toISOString());
  state.selectionSize = null;
  await postRun('/api/run', { ...form, scanOnly: true });
}

async function downloadSelected() {
  if (state.running) return;
  const form = formValid();
  if (!form) return;
  const onlyIds = selectedClassIds();
  if (!onlyIds.length) { toast('Tick at least one ready recording first.', true); return; }
  appendLogLine('step', `Downloading ${onlyIds.length} selected recording(s) …`, new Date().toISOString());
  state.selectionSize = onlyIds.length;
  await postRun('/api/run', { ...form, scanOnly: false, onlyIds });
}

async function scanNewsRoomFiles() {
  if (state.running) return;
  const form = formValid();
  if (!form) return;
  appendLogLine('step', 'Scanning every subject news room for downloadable files …', new Date().toISOString());
  state.selectionSize = null;
  await postRun('/api/scan-files', form);
}

async function downloadFiles() {
  if (state.running) return;
  const form = formValid();
  if (!form) return;
  const fileIds = selectedFileIds();
  if (!fileIds.length) { toast('Tick at least one file first.', true); return; }
  appendLogLine('step', `Downloading ${fileIds.length} selected news room file(s) …`, new Date().toISOString());
  state.selectionSize = null;
  await postRun('/api/run-files', { ...form, fileIds });
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
  const hideHint = () => {
    els.hint.style.display = 'none';
    localStorage.setItem('myaie-hint', '1');
  };
  els.hintClose.addEventListener('click', hideHint);
  els.hintGotIt.addEventListener('click', hideHint);
  if (localStorage.getItem('myaie-hint') === '1') els.hint.style.display = 'none';
  els.showTips.addEventListener('click', () => {
    els.hint.style.display = '';
    localStorage.removeItem('myaie-hint');
    toast('Quick-start tips are back in the corner.');
  });

  initTooltips();

  clearLog();

  els.scanBtn.addEventListener('click', findRecordings);
  els.dlSelBtn.addEventListener('click', downloadSelected);
  els.scanFilesBtn.addEventListener('click', scanNewsRoomFiles);
  els.dlFilesBtn.addEventListener('click', downloadFiles);
  els.cancelBtn.addEventListener('click', cancelRun);
  els.browseBtn.addEventListener('click', browseFolder);

  els.scheduleSelectAll.addEventListener('change', () => {
    for (const [key, entry] of state.rows) {
      if (!entry.checkbox.disabled) entry.checkbox.checked = els.scheduleSelectAll.checked;
    }
    updateSelectionButtons();
  });
  els.filesSelectAll.addEventListener('change', () => {
    for (const [key, entry] of state.files) {
      entry.checkbox.checked = els.filesSelectAll.checked;
    }
    updateSelectionButtons();
  });

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
