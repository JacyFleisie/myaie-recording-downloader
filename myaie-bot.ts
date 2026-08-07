#!/usr/bin/env node
/**
 * myaie-bot.ts — CLI for the myAIE lecture-recording downloader.
 * Thin wrapper around bot-core.ts. Run `node myaie-bot.ts --help`.
 * Runs directly on Node 24+ (type stripping); `tsc --noEmit` typechecks.
 */

import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConfig, downloadFiles, runBot, runSelftest, scanNewsRoomWithLogin, shortUrl, type FeedFile, type LogLevel, type ScheduleRow } from './bot-core.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function usage(): string {
  return `
myAIE Student Portal — lecture recording downloader

USAGE
  node myaie-bot.ts [options]

OPTIONS
  --from <YYYY-MM-DD>       Start of date range (default: 90 days ago)
  --to   <YYYY-MM-DD>       End of date range   (default: today)
  --subject <text>          Only events whose subject name contains <text>
  --max <n>                 Download at most n videos this run
  --dir <folder>            Where to save videos (default: ./downloads)
  --dry-run                 List what WOULD be downloaded; download nothing
  --inspect                 Dump raw calendar JSON to calendar_dump.json and exit
  --headless                Run Chrome invisibly (use only after you have
                            logged in once in a normal run)
  --no-audit                Skip the portal's saveRecordingAction audit call
  --fallback-recording      Use recordingURL when downloadURL is missing
  --yt-dlp                  Download embedded recordings (Vimeo/YouTube) with
                            yt-dlp; also tried if a direct download fails
  --yt-dlp-path <path>      yt-dlp executable (default: ./yt-dlp.exe, else PATH)
  --yt-dlp-timeout <sec>    Max seconds per yt-dlp download (default: 1200)
  --profile <folder>        Chrome profile dir (default: ./chrome-profile)
  --channel <chrome|edge|msedge>  Browser channel to use (default: chrome)
  --executable-path <path>  Exact Chrome/Edge executable (overrides --channel)
  --api-base <url>          Override the portal API base
  --login-timeout <sec>     How long to wait for manual login (default: 300)
  --verbose                 Verbose logging
  --selftest                Run built-in logic tests and exit
  --scan-only               Find recordings and list them; download nothing
  --select <ids>            Download only the class ids listed (comma-separated,
                            as shown by the schedule listing)
  --scan-files              Scan News Room feeds for downloadable files and list
                            them (PDF/PPTX/DOCX attachments); download nothing
  --download-files <ids>    Download the News Room files whose attachment ids are
                            listed (comma-separated, as shown by --scan-files)
  -h, --help                Show this help

EXAMPLES
  node myaie-bot.ts --from 2026-06-01 --to 2026-07-31
  node myaie-bot.ts --from 2026-06-01 --subject "Computer Networks" --dry-run
  node myaie-bot.ts --from 2026-01-01 --to 2026-12-31 --max 10
  node myaie-bot.ts --scan-only --from 2026-07-01          # list ready recordings
  node myaie-bot.ts --select 272425,272430 --from 2026-07-01   # download only those
  node myaie-bot.ts --scan-files --from 2026-07-01         # list news-room files
  node myaie-bot.ts --download-files 15041,15042 --from 2026-07-01

GUI
  node gui-server.ts        Launch the professional web dashboard instead.
`;
}
function parseCliArgs() {
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      subject: { type: 'string' },
      max: { type: 'string' },
      dir: { type: 'string' },
      profile: { type: 'string' },
      channel: { type: 'string' },
      'executable-path': { type: 'string' },
      'api-base': { type: 'string' },
      'login-timeout': { type: 'string' },
      'dry-run': { type: 'boolean', short: 'd' },
      inspect: { type: 'boolean' },
      headless: { type: 'boolean' },
      'no-audit': { type: 'boolean' },
      'fallback-recording': { type: 'boolean' },
      'yt-dlp': { type: 'boolean' },
      'yt-dlp-path': { type: 'string' },
      'yt-dlp-timeout': { type: 'string' },
      verbose: { type: 'boolean' },
      selftest: { type: 'boolean' },
      'scan-only': { type: 'boolean' },
      select: { type: 'string' },
      'scan-files': { type: 'boolean' },
      'download-files': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  return {
    from: values.from,
    to: values.to,
    subject: values.subject,
    max: values.max,
    dir: values.dir,
    profile: values.profile,
    channel: values.channel,
    executablePath: values['executable-path'],
    apiBase: values['api-base'],
    loginTimeout: values['login-timeout'],
    dryRun: !!values['dry-run'],
    inspect: !!values.inspect,
    headless: !!values.headless,
    noAudit: !!values['no-audit'],
    fallbackRecording: !!values['fallback-recording'],
    ytdlp: !!values['yt-dlp'],
    ytDlpPath: values['yt-dlp-path'],
    ytDlpTimeout: values['yt-dlp-timeout'],
    verbose: !!values.verbose,
    selftest: !!values.selftest,
    scanOnly: !!values['scan-only'],
    selection: values.select ? String(values.select).split(',').map((x) => x.trim()).filter(Boolean) : undefined,
    scanFiles: !!values['scan-files'],
    downloadFiles: values['download-files'] ? String(values['download-files']).split(',').map((x) => x.trim()).filter(Boolean) : undefined,
    help: !!values.help,
  };
}

function makeConsoleLog(verbose: boolean) {
  const out = (prefix: string, color: string, msg: string) => console.log(`${color}${prefix}\x1b[0m`, msg);
  return {
    info: (msg: string) => out('[i]', '\x1b[36m', msg),
    ok: (msg: string) => out('[+]', '\x1b[32m', msg),
    warn: (msg: string) => out('[!]', '\x1b[33m', msg),
    err: (msg: string) => out('[-]', '\x1b[31m', msg),
    step: (msg: string) => out('[*]', '\x1b[35m', msg),
    debug: (msg: string) => { if (verbose) console.log('[debug]', msg); },
  };
}

async function main(): Promise<void> {
  const parts = parseCliArgs();
  if (parts.help) { console.log(usage()); return; }
  if (parts.selftest) { runSelftest(); return; }

  let cfg;
  try {
    cfg = buildConfig(parts, __dirname);
  } catch (e) {
    console.error('Error: ' + (e instanceof Error ? e.message : String(e)));
    console.error('Run `node myaie-bot.ts --help` for usage.');
    process.exit(1);
  }

  const log = makeConsoleLog(cfg.verbose);

  if (parts.scanFiles) {
    log.step('Scanning News Room feeds for downloadable files ...');
    const files = await scanNewsRoomWithLogin(cfg, { log: (level: LogLevel, msg: string) => { const fn = log[level]; if (fn) fn(msg); } });
    if (files.length === 0) { log.warn('No downloadable files found in the date range.'); return; }
    log.step(`Found ${files.length} file(s):`);
    for (const f of files) {
      log.info(`  ${f.date}  [${f.size || '?'}]  ${f.subject || '(no subject)'}  ${f.name}  id=${f.id}`);
    }
    log.info(`Download them with:  --download-files ${files.map((f) => f.id).join(',')}`);
    return;
  }

  if (parts.downloadFiles) {
    const wanted = new Set(parts.downloadFiles);
    log.step('Scanning News Room feeds to resolve the selected files ...');
    const files = await scanNewsRoomWithLogin(cfg, { log: (level: LogLevel, msg: string) => { const fn = log[level]; if (fn) fn(msg); } });
    const selected = files.filter((f) => wanted.has(f.id));
    const missing = [...wanted].filter((id) => !selected.some((f) => f.id === id)).length;
    if (selected.length === 0) {
      log.err(`None of the requested ids matched a file in the date range (${wanted.size} requested). Run --scan-files first to list ids.`);
      return;
    }
    if (missing > 0) log.warn(`${missing} requested id(s) not found in the date range — downloading the ${selected.length} matched.`);
    await downloadFiles(cfg, selected, {
      log: (level: LogLevel, msg: string) => { const fn = log[level]; if (fn) fn(msg); },
      stage: () => {},
      fileItem: (it) => {},
      isCancelled: () => false,
    });
    return;
  }

  await runBot(cfg, {
    log: (level: LogLevel, msg: string) => { const fn = log[level]; if (fn) fn(msg); },
    stage: () => {},
    schedule: (rows: ScheduleRow[]) => {
      log.step('Schedule overview:');
      for (const r of rows) {
        const flag = r.url ? (r.status === 'ready' ? 'DOWNLOAD' : r.status) : r.status;
        log.info(`  ${r.date}  [${flag}]  ${r.subject || '(no subject)'}  id=${r.classId || '-'}${r.url ? '  ' + shortUrl(r.url) : ''}`);
      }
    },
    item: () => {}, // core already logs each item via log()
    isCancelled: () => false,
  });

  if (cfg.inspect) {
    log.ok(`Inspect dump written to ${cfg.inspectPath}`);
  }
}

main().catch((e) => {
  console.error('\nError: ' + (e instanceof Error ? e.message : String(e)));
  console.error('Run `node myaie-bot.ts --help` for usage, or --selftest to verify the installation.');
  process.exit(1);
});
