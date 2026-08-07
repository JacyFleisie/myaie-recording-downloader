# 🎓 myAIE Lecture Downloader

**Built by [JacyFleisie](https://github.com/JacyFleisie)**

[![Release](https://img.shields.io/github/v/release/JacyFleisie/myaie-recording-downloader?label=Latest%20release&color=4f46e5)](https://github.com/JacyFleisie/myaie-recording-downloader/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/JacyFleisie/myaie-recording-downloader/release.yml?branch=main&label=Build)](https://github.com/JacyFleisie/myaie-recording-downloader/actions)
[![Node](https://img.shields.io/badge/Node-22.18%2B-339933)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

> A desktop app that downloads your past live **lecture recordings** from the
> myAIE Student Portal — automatically. Pick a date range, and it works through
> your calendar schedule, finds every recording that has a download button, and
> saves the MP4s to a folder you choose. It can even **join and leave your live
> classes for you** with the built-in Class Assistant. It drives **your own
> logged-in Chrome session**, so no passwords are ever stored.

## ⬇️ Download the app

**Windows users — no Node, no terminal, nothing else needed:**

[![Download for Windows](https://img.shields.io/badge/⬇%20Download%20for%20Windows-4f46e5?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/JacyFleisie/myaie-recording-downloader/releases/latest)

1. Open the [latest release](https://github.com/JacyFleisie/myaie-recording-downloader/releases/latest) on GitHub.
2. Download **`myAIE Lecture Downloader Setup <version>.exe`**.
3. Run the installer and pick any install folder.
4. Launch **myAIE Lecture Downloader** from the Start menu — done.

The app **updates itself when you say so**: a **Check for updates** button in
the dashboard's footer looks for new versions published here on GitHub. The app
never checks, downloads, or installs on its own — so it never closes or
reinstalls itself without your go-ahead. When a new version is found you click
**Download update** (with live progress), then **Restart & install** whenever
you're ready.

## ✨ What it does

- **Scans your calendar schedule** for a date range you choose (7d / 30d / 90d /
  6mo presets, or any custom range) and lists every recorded session.
- **Two-phase downloads** — hit **Find recordings** to see what's available
  first, tick the classes you want (or select all), then **Download selected**.
  No more downloading everything blindly.
- **News Room files** — **Find news room files** scans every subject's news room
  and lists the file attachments (PDF / PPTX / DOCX …) in your date range, with
  sizes and subjects, so you can tick and download exactly the study material
  you need alongside the recordings.
- **Class Assistant (auto-join)** — **Scan upcoming classes** lists everything
  on your calendar from now to 7 days out, then arm **Auto-join my classes** and
  the app opens each live class in its own tab, clicks **Join** when it starts,
  and clicks **Leave** when it ends — on its own. See below for details.
- **Downloads the recordings** as MP4s to a folder you pick — including
  embedded Vimeo/YouTube videos (via a bundled yt-dlp with your session's
  cookies), so nothing is missed.
- **Live dashboard** — a real-time log of everything the bot detects and does,
  a schedule table with status chips (Download ready / Recording pending /
  Saved…), and a run summary. Accessible by keyboard and screen reader.
- **Resumes cleanly** — already-downloaded files are skipped on reruns, and
  your settings persist between sessions.
- **Your login stays private** — it reuses your real Chrome profile; you log in
  once (like on the website) and your session is reused, never stored or shared.

## 🎯 Typical flow

1. Pick a **date range** (or use a preset).
2. **Find recordings** — the bot logs in, scans every subject's calendar and
   lists each session with a status chip (Download ready / Recording pending…).
3. **Tick the recordings you want** and hit **Download selected** — only those
   download.
4. **Find news room files** — the same scan against every subject's News Room
   returns file attachments (with size + subject + date). Tick and hit
   **Download files**.
5. **Class Assistant** — hit **Scan upcoming classes** to see the next 7 days of
   live classes, then flip on **Auto-join my classes** to have the app join and
   leave each one for you.

Both lists keep their checkboxes between runs, and the CLI has matching flags
(`--scan-only`, `--select`, `--scan-files`, `--download-files`).

## 🤖 Class Assistant (auto-join)

The dashboard's **Class assistant** card turns the app into your personal
attendance bot:

1. **Scan upcoming classes** — reads your portal calendar and lists every class
   from now until 7 days out, sorted by time, with date, time, subject, class
   ID, live link, and status. Scanning on a Saturday automatically shows the
   next weekday's classes (the feed simply has none scheduled on weekends).
2. **Auto-join my classes** — arm the toggle and the app walks through the list
   in order:
   - waits until each class is **join-before minutes before it starts**
     (default **2 min**, configurable),
   - opens the class's live link in its own browser tab and clicks **Join**
     (auto-accepting leave/end confirmation dialogs),
   - waits until **leave-after minutes after it ends** (default **1 min**,
     configurable),
   - searches the page for a **Leave/Exit** button, clicks it, closes the tab,
     and moves to the next class.

You get live feedback the whole time — "Waiting — will join Computer Networks
at 08:58", "In class — will leave at 09:31" — and each row flips to
**Joined ✓ / Left ✓ / Skipped / Failed**.

**Built to handle real classes:**

- If a class starts late, the bot **keeps retrying every ~20 seconds** until it
  begins (watching for the Join button and the page's "waiting for moderator"
  state), only giving up if the class never starts by its end time.
- Classes without a live link or a start time are skipped with a note.
- Join-URL detection never mistakes a download/recording link for a live link;
  end time comes from the portal, else the session duration, else a 1-hour
  default.
- If Join or Leave isn't found, the app **logs the buttons it actually sees on
  the page** so the click patterns can be fine-tuned to your portal's wording.
- You can't start a download run while the assistant is armed (and vice versa).

**Requirements:** keep the app open (and logged in) while armed — each class
opens in a tab inside the app, so closing the app mid-class drops you from that
session.

## 🚀 Quick start (for developers)

```bash
npm install            # install dependencies
npm run desktop        # launch the desktop app (Electron)
npm run gui            # …or the same dashboard in your browser
node myaie-bot.ts --help   # …or the CLI
```

Requires **Node.js 22.18+** and **Google Chrome** (or Edge) installed.

## 🧠 How it works

The portal's frontend was reverse-engineered from its own JavaScript bundles:

1. `GET /getAllSubjectCalendar` returns your **subjects** (e.g. `DPOA101 …`).
2. Each subject has a paginated **class feed** whose items carry a `ClassArray`
   — one entry per live session with `class_date`, `isRecorded`,
   `isRecordingAvailable` and a `recordings` HTML string.
3. Most sessions have **no `downloadURL` field** — the portal renders the
   "Download" button into that `recordings` HTML (a `url="…"` attribute pointing
   at `playback.myaie.ac/presentation_video/<meeting>/video.mp4`). The bot parses
   exactly what the portal page shows, so a session is "Download ready"
   precisely when you'd see a Download button on the site.

Downloads use a three-tier fallback chain — the browser download engine → a
cookie-authenticated streaming download → **yt-dlp** (which also handles
embedded Vimeo/YouTube with your exported session cookies). Files land as
`YYYY-MM-DD_Subject_classId.mp4`.

The Class Assistant reuses the same portal session: upcoming classes come from
the calendar feed entries (with a second data source when entries carry a date)
and their live links are picked from the feed item's known join-link fields.

Want the full story? Read the [case study](docs/CASE_STUDY.md).

## 🖥️ Building the installer

```bash
npm run desktop:build     # produces dist\myAIE Lecture Downloader Setup x.y.z.exe
```

## 📁 Project layout

```
electron/main.ts     Electron desktop wrapper (native window, manual updates, folder picker)
gui-server.ts        Zero-framework HTTP + SSE dashboard server (incl. update + auto-attend APIs)
bot-core.ts          The automation engine (Playwright, download chain, auto-join engine)
myaie-bot.ts         CLI entry point
public/              Dashboard UI (HTML/CSS/JS, accessible)
docs/CASE_STUDY.md   The story behind the project
```

## 🧪 Tests & checks

```bash
npm run selftest     # engine self-test (real captured portal data)
npm run typecheck    # strict TypeScript, no build step (native type stripping)
```

## 🔧 CLI reference

| Option | Meaning |
|---|---|
| `--from <YYYY-MM-DD>` / `--to <YYYY-MM-DD>` | date range (default: last 90 days → today) |
| `--subject <text>` | only sessions whose subject contains text |
| `--max <n>` | at most n downloads this run |
| `--dir <folder>` | save folder (default `./downloads`) |
| `--dry-run` | list what would download; download nothing |
| `--headless` | invisible Chrome (after logging in once) |
| `--no-audit` | skip the portal's audit call |
| `--fallback-recording` | use `recordingURL` when `downloadURL` is missing |
| `--yt-dlp` | use yt-dlp for embedded videos (Vimeo/YouTube); also a fallback for failed direct downloads |
| `--yt-dlp-path <path>` | yt-dlp executable (default: bundled `./yt-dlp.exe`) |
| `--channel <chrome\|edge>` | browser selection |
| `--login-timeout <sec>` | how long to wait for manual login (default 300) |

The Class Assistant (upcoming scan + auto-join) is available in the desktop
dashboard; the CLI covers downloads and file scans.

## 🛠 Troubleshooting

- **"Failed to launch Chrome"** → try `--channel edge` or set the executable
  with `--executable-path "C:\Program Files\Google\Chrome\Application\chrome.exe"`.
- **Login timeout** → finish logging in within the window, or raise
  `--login-timeout`; your session persists in `./chrome-profile` afterwards.
- **HTTP 401/403** → session expired; log in again in the opened browser.
- **Download failed / 403** → the recording's signed URL may have expired; rerun
  (already-downloaded files are skipped).
- **Scan shows 0 upcoming classes** → the log now dumps the exact fields the
  portal returned and the calendar API endpoints it calls, so the scanner can be
  wired to your portal's exact shape — paste that log to the author.
- **Auto-join couldn't find Join/Leave** → the log prints the buttons the page
  actually shows; send it over and the click patterns get tuned to your portal.
- **Embedded video won't download** → see the yt-dlp note in the docs; on some
  networks Vimeo/YouTube are blocked at the network level (a VPN fixes it).
- **Dashboard port busy** → it auto-picks a free port in 3801–3820 (set `PORT`).

## 📜 Notes

- Personal use on your own account — respect your institution's policies on
  downloading lecture recordings.
- "Recording pending" means the portal recorded the class but the download isn't
  published yet; rerun later to pick it up.
