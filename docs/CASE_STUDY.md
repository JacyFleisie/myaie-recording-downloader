# Case Study: myAIE Lecture Recording Downloader

**Author:** JacyFleisie · **Stack:** Node.js (ESM), Playwright-core, zero-dependency HTTP + SSE dashboard · **Repo:** [github.com/JacyFleisie/myaie-recording-downloader](https://github.com/JacyFleisie/myaie-recording-downloader)

## The problem

My university's student portal records every live lecture and offers a
"Download Video" button on each class session — but nothing else. To keep a
semester's recordings I had to visit the portal, wait for it to load, and
click the download button for every single class, one at a time. With
~400 sessions a semester, that is hours of tedious clicking, and there is no
bulk-download feature at all.

I wanted a tool that would: scan my calendar for a date range I choose,
figure out which recordings actually exist, and download them automatically —
using my own logged-in session, so no credentials are ever stored.

## Reverse-engineering the portal

The portal is a React SPA, so its entire data layer ships to the browser as
JavaScript bundles. I downloaded the site's HTML and JS, and read the bundles
to find the API:

1. **The calendar endpoint** (`getAllSubjectCalendar`) returns only your
   *subjects* — not individual class sessions. That was the first surprise.
2. Each subject has a paginated **class feed**
   (`getPostFeedMessagesPaginateTz`) whose items carry a `ClassArray` — one
   entry per live session, with `class_date`, `isRecorded`, and a `recordings`
   HTML string.
3. The second surprise: sessions rarely have a `downloadURL` field. The portal
   *renders* the Download button server-side into the `recordings` HTML, as a
   `url="..."` attribute pointing at `playback.myaie.ac/.../video.mp4`. So the
   bot parses exactly the same markup the portal page shows — a session is
   "Download ready" precisely when you would see a Download button in the
   browser.
4. **Auth** is a Bearer token kept in `localStorage`. Instead of handling
   passwords, the bot drives your real Chrome via Playwright's persistent
   profile: you log in once, the session persists, and every API call runs
   inside the page context with the session's own token. Zero credential
   storage.

Probing the live API during development paid off: the first version assumed
the calendar endpoint returned sessions directly — it did not. A live probe
with the real session revealed the two-stage subject → class-feed model and
the `recordings` HTML trick, and the bot was rewritten to match reality.

## Architecture

```
bot-core.ts   — event-driven engine: browser session → fetch subjects →
                 fetch class feeds → filter by date/subject → classify →
                 download. Emits log/stage/schedule/item/summary events and
                 supports cancellation. No UI concerns.
myaie-bot.ts  — CLI wrapper (all flags, --selftest).
gui-server.ts — zero-dependency HTTP + SSE server that runs the engine
                 in-process and streams live events to the dashboard.
public/        — dark-theme dashboard: date pickers, folder picker, live
                 log, schedule table with status chips, run summary.
electron/      — desktop wrapper: embeds the dashboard in a native window.
```

Downloads use a three-tier fallback chain, so one failure mode never kills a
file: **browser download engine → cookie-authenticated HTTP stream → yt-dlp**
(with the browser's session cookies exported to a temp Netscape file for
embedded Vimeo/YouTube recordings). Files land as `YYYY-MM-DD_Subject_id.mp4`,
already-downloaded files are skipped, and each download fires the portal's
own audit call just like a real click.

## Results

- Detects ~391 class sessions across 11 subjects automatically.
- Classifies each one as *Download ready / Recording pending / Not recorded*
  — matching what the portal actually shows, verified against a live run.
- Downloads lectures at scale (a real 54.7 MB OOP lecture was downloaded
  end-to-end; 18 recordings in a week-long range were detected as ready).
- Ships as a CLI, a web dashboard, and now a desktop app — all driven by one
  shared engine with 25 selftest assertions and live-verified behavior.

## Lessons

- **Don't trust assumptions — probe the live system.** The API's real shape
  differed from what the frontend bundles implied; live probing with the
  saved session found the truth and fixed a bug where every recording looked
  like "pending".
- **Match the user's source of truth.** Reading the same server-rendered
  markup the portal shows made the bot's statuses exactly match what a human
  sees on the site.
- **Design failure chains, not happy paths.** Browser → stream → yt-dlp means
  a single blocked method can't sink a download.
- **Session reuse beats credential handling.** Driving the real browser means
  the bot never sees a password, and "login once" is a better UX than any
  password form.

## What's next

- Proper test suite with real captured API data as fixtures + CI on GitHub.
- TypeScript migration (types derived from the real portal JSON).
- Parallel downloads with per-file progress, and resume for interrupted files.
- PWA / thin mobile client that talks to the desktop engine over SSE.
