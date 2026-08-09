/* Captures README screenshots from the running dashboard (client-side sample data only). */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = 'http://127.0.0.1:3801';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = fileURLToPath(new URL('../docs/screenshots/', import.meta.url));
mkdirSync(OUT, { recursive: true });

const SAMPLE = `(() => {
  // --- realistic sample data (renderer-only; the server is untouched) ---
  renderSchedule([
    { date: '2026-08-05', subject: 'Computer Networks', classId: '21438bc2-2344-4c4d-85d4-2a0b4e23528b', url: 'https://playback.myaie.ac/presentation_video/abc/video.mp4', status: 'ready' },
    { date: '2026-08-05', subject: 'DPOA101 Digital Productivity & Office Applications', classId: 'bda87e60-001e-450d-babd-fd1a22c4e3ec', url: 'https://playback.myaie.ac/presentation_video/def/video.mp4', status: 'ready' },
    { date: '2026-08-04', subject: 'Object Oriented Programming', classId: 'fd2b2d5d-c174-467e-af7a-a36d500c6849', url: null, status: 'pending' },
    { date: '2026-08-04', subject: 'Cloud Platforms, Databases & Application Development', classId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', url: 'https://playback.myaie.ac/presentation_video/ghi/video.mp4', status: 'ready' },
    { date: '2026-08-03', subject: 'Mathematics for Information Technology', classId: '09876543-2109-8765-4321-098765432109', url: null, status: 'not recorded' },
    { date: '2026-08-03', subject: 'Software Development Fundamentals', classId: '11223344-5566-7788-99aa-bbccddeeff00', url: 'https://playback.myaie.ac/presentation_video/jkl/video.mp4', status: 'ready' },
  ]);
  renderUpcoming([
    { id: '272256', date: '2026-08-11', start: new Date('2026-08-11T08:00:00'), end: new Date('2026-08-11T09:45:00'), subject: 'Computer Networks', joinUrl: 'https://live.myaie.ac/room/abc', status: 'upcoming' },
    { id: '272257', date: '2026-08-11', start: new Date('2026-08-11T10:00:00'), end: new Date('2026-08-11T10:45:00'), subject: 'Object Oriented Programming', joinUrl: '', status: 'no-join-link' },
    { id: '272258', date: '2026-08-11', start: new Date('2026-08-11T11:00:00'), end: new Date('2026-08-11T12:00:00'), subject: 'Mathematics for Information Technology', joinUrl: 'https://live.myaie.ac/room/def', status: 'upcoming' },
  ]);
  renderFiles([
    { id: 'f1', name: 'Lecture_1_Computer_Networks.pdf', subject: 'Computer Networks', size: '2.4 MB', date: '2026-08-05' },
    { id: 'f2', name: 'Assignment_Brief_DPOA101.docx', subject: 'DPOA101 Digital Productivity', size: '312 KB', date: '2026-08-04' },
    { id: 'f3', name: 'OOP_Slides_Week_3.pptx', subject: 'Object Oriented Programming', size: '8.1 MB', date: '2026-08-03' },
    { id: 'f4', name: 'Networks_Tutorial_Notes.pdf', subject: 'Computer Networks', size: '1.1 MB', date: '2026-08-03' },
  ]);
  state.dl = { total: 4, done: 1, skipped: 0, failed: 0, bytes: 118, now: { subject: 'Computer Networks', name: 'video.mp4' }, nowReceived: 52, nowTotal: 124, paused: false };
  renderDownloads();
  const ts = new Date().toISOString();
  appendLogLine('step', 'Run started — date range 2026-05-09 → 2026-08-07', ts);
  appendLogLine('info', 'Gathered 14 class session(s) across 11 subject(s) — checking which are joinable right now.', ts);
  appendLogLine('ok', 'Found 2 classes you can join today.', ts);
  appendLogLine('info', 'Downloading Computer Networks — stream download …', ts);
  return true;
})()`;

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.evaluate(SAMPLE);
  await page.waitForTimeout(600);

  await page.screenshot({ path: OUT + 'dashboard-dark.png', fullPage: true });
  console.log('captured dashboard-dark.png');

  await page.evaluate(`applyTheme('light')`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: OUT + 'dashboard-light.png', fullPage: true });
  console.log('captured dashboard-light.png');

  await page.evaluate(`applyTheme('dark'); switchTab('newsroom');`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: OUT + 'newsroom-dark.png', fullPage: true });
  console.log('captured newsroom-dark.png');
} finally {
  await browser.close();
}
