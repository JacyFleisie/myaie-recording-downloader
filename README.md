# myAIE Lecture Downloader

**Built by [JacyFleisie](https://github.com/JacyFleisie)** — a student project automating my own lecture-recordings backlog.

Automates the **myAIE Student Portal** (`https://student.myaie.ac`): it scans your
calendar schedule, finds past live lecture recordings within a date range you
choose, and downloads them as MP4 files — using your own logged-in Chrome
session, so no credentials are ever stored.

Three ways to run it:

- **`npm run desktop`** — a dedicated **desktop app** (Electron): the dashboard
  in a native window, single instance, installable via `npm run desktop:build`.
- **`npm run gui`** — the same dashboard in your browser: date pickers, a
  download folder picker, a live log of everything the bot detects and does, a
  schedule table and a run summary.
- **`node myaie-bot.ts ...`** — the CLI (all flags still work).

Want the story behind it? Read the [case study](docs/CASE_STUDY.md).

## How it works

The portal's frontend was reverse-engineered from its own JavaScript bundles:

1. `GET /getAllSubjectCalendar` returns your **subjects** (e.g. `DPOA101 …`).
2. Each subject has a paginated **class feed**
   (`GET /getPostFeedMessagesPaginateTz?room_id=<subject>&user_id=<you>`), whose
   items carry a `ClassArray` — one entry per live session with `class_date`,
   `isRecorded`, `isRecordingAvailable` and a `recordings` HTML string.
3. Most sessions have **no `downloadURL` field** — the portal renders the
   "Download" button into that `recordings` HTML (a `url="…"` attribute pointing
   at `playback.myaie.ac/presentation_video/<meeting>/video.mp4`). The bot parses
   exactly what the portal page shows, so a session is "Download ready" precisely
   when you would see a Download button on the site. It then fetches the file
   (same `saveRecordingAction` audit call the portal fires) and saves it.

Downloads go through the browser download engine with a cookie-authenticated
streaming fallback, and files land as `YYYY-MM-DD_Subject_classId.mp4`.
Already-downloaded files are skipped on reruns.

## Requirements

- **Node.js 22.18+** (Node 24 works)
- **Google Chrome** installed (or Microsoft Edge — pick it in the GUI / use
  `--channel edge`)

No extra browser download is needed — the bot drives your installed Chrome.
For the desktop app you also need Node 22.18+ (`npm install` once, then
`npm run desktop`).

## Install

```bash
npm install
```

## GUI (recommended)

```bash
npm run gui
```

A browser tab opens the dashboard at `http://127.0.0.1:3801`:

- **Date from / to** — the recording range (with 7d/30d/90d/6mo presets)
- **Subject filter** — optional, e.g. `Computer Networks`
- **Download folder** — type a path or click **Browse…** for a native Windows
  folder dialog
- **Options** — dry run (preview only), headless (no window after first login),
  skip audit call, use recording URL as fallback, **use yt-dlp for embedded
  videos (Vimeo / YouTube)**, max videos, browser channel
- **Start download / Stop** — run and cancel; the bot opens the portal and waits
  if you need to log in (once; the session persists in `./chrome-profile`)
- **Detected schedule** — every session in range with a status chip that updates
  live (Download ready / Recording pending / Not recorded / Downloading… / Saved)
- **Live log** — everything the bot does and detects, color-coded, filterable by
  level (All / Info / Warnings / Errors), with auto-scroll
- **Run summary** — downloaded / skipped / failed / pending counters

Your settings persist between sessions (`gui-settings.json`), and every run is
appended to `bot-run.log`.

## CLI

```bash
node myaie-bot.ts --from 2026-06-01 --to 2026-07-31            # download the range
node myaie-bot.ts --from 2026-06-01 --subject "Networks" --dry-run   # preview
node myaie-bot.ts --inspect                                   # dump raw data
node myaie-bot.ts --selftest                                  # verify install
```

| Option | Meaning |
|---|---|
| `--from <YYYY-MM-DD>` / `--to <YYYY-MM-DD>` | date range (default: last 90 days → today) |
| `--subject <text>` | only sessions whose subject contains text |
| `--max <n>` | at most n downloads this run |
| `--dir <folder>` | save folder (default `./downloads`) |
| `--dry-run` | list what would download; download nothing |
| `--inspect` | dump raw class sessions to `calendar_dump.json` |
| `--headless` | invisible Chrome (after logging in once) |
| `--no-audit` | skip the portal's audit call |
| `--fallback-recording` | use `recordingURL` when `downloadURL` is missing |
| `--yt-dlp` | download embedded recordings (Vimeo/YouTube) with yt-dlp; also tried if a direct download fails |
| `--yt-dlp-path <path>` | yt-dlp executable (default: `./yt-dlp.exe`, else `yt-dlp` on PATH) |
| `--yt-dlp-timeout <sec>` | max seconds per yt-dlp download (default 1200) |
| `--profile <folder>` | Chrome profile (default `./chrome-profile`) |
| `--channel <chrome\|edge>` / `--executable-path` | browser selection |
| `--login-timeout <sec>` | how long to wait for manual login (default 300) |

## Embedded recordings (Vimeo / YouTube)

Most portal recordings are direct MP4 links on `playback.myaie.ac` and need no
special tooling. A few are embedded player pages (`player.vimeo.com`, YouTube)
— those can only be fetched with **yt-dlp**. Tick "Use yt-dlp for embedded
videos" in the GUI (or pass `--yt-dlp`). The bot then:

1. detects embedded URLs and hands them to yt-dlp, and
2. exports your browser session's cookies (Netscape format, written to a temp
   file and deleted afterwards) so private/unlisted videos resolve exactly like
   your logged-in browser, and
3. falls back to yt-dlp even for direct links when the normal download fails.

A portable `yt-dlp.exe` ships in the project folder. It is not tracked by git
(`.gitignore`), so if you clone this repo elsewhere, reinstall it:

```bash
# either drop the latest release here (https://github.com/yt-dlp/yt-dlp/releases)
curl -L -o yt-dlp.exe https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe
# or install the Python package (then the bot finds it on PATH)
pip install -U yt-dlp
```

> **Note:** on some networks public Vimeo/YouTube extraction is blocked at the
> network level (e.g. Vimeo 401s on its OAuth step, YouTube reports videos as
> unavailable even for known-good URLs). That is not a bot bug — if embeds fail
> to download from your network, a VPN/proxy usually fixes it. Direct MP4
> downloads from the portal are unaffected.

## Troubleshooting

- **"Failed to launch Chrome"** → try `--channel edge` or set the executable with
  `--executable-path "C:\Program Files\Google\Chrome\Application\chrome.exe"`.
- **Login timeout** → finish logging in within the window, or raise
  `--login-timeout`; your session persists in `./chrome-profile` afterwards.
- **HTTP 401/403** → session expired; log in again in the opened browser.
- **Download failed / 403** → the recording's signed URL may have expired; rerun
  (already-downloaded files are skipped).
- **Embedded video won't download** → see the yt-dlp section above; if it's a
  network block (Vimeo 401 / YouTube "Video unavailable"), try a VPN.
- **Dashboard port busy** → it auto-picks a free port in 3801–3820 (set `PORT`
  to pin one).

## Notes

- Personal use on your own account — respect your institution's policies on
  downloading lecture recordings.
- "Recording pending" means the portal recorded the class but the download
  isn't published yet (or only "Watch" is available); rerun later to pick it up.
