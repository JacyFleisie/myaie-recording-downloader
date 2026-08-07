#!/usr/bin/env node
/**
 * myaie-bot.mjs — CLI for the myAIE lecture-recording downloader.
 * Thin wrapper around bot-core.mjs. Run `node myaie-bot.mjs --help`.
 */

import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConfig, runBot, runSelftest, shortUrl } from './bot-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  return `
myAIE Student Portal — lecture recording downloader

USAGE
  node myaie-bot.mjs [options]

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
  -h, --help                Show this help

EXAMPLES
  node myaie-bot.mjs --from 2026-06-01 --to 2026-07-31
  node myaie-bot.mjs --from 2026-06-01 --subject "Computer Networks" --dry-run
  node myaie-bot.mjs --from 2026-01-01 --to 2026-12-31 --max 10

GUI
  node gui-server.mjs       Launch the professional web dashboard instead.
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
    help: !!values.help,
  };
}

function makeConsoleLog(verbose) {
  const out = (prefix, color, msg) => console.log(`${color}${prefix}\x1b[0m`, msg);
  return {
    info: (msg) => out('[i]', '\x1b[36m', msg),
    ok: (msg) => out('[+]', '\x1b[32m', msg),
    warn: (msg) => out('[!]', '\x1b[33m', msg),
    err: (msg) => out('[-]', '\x1b[31m', msg),
    step: (msg) => out('[*]', '\x1b[35m', msg),
    debug: (msg) => { if (verbose) console.log('[debug]', msg); },
  };
}

async function main() {
  const parts = parseCliArgs();
  if (parts.help) { console.log(usage()); return; }
  if (parts.selftest) { runSelftest(); return; }

  let cfg;
  try {
    cfg = buildConfig(parts, __dirname);
  } catch (e) {
    console.error('Error: ' + e.message);
    console.error('Run `node myaie-bot.mjs --help` for usage.');
    process.exit(1);
  }

  const log = makeConsoleLog(cfg.verbose);

  const summary = await runBot(cfg, {
    log: (level, msg) => log[level] && log[level](msg),
    stage: () => {},
    schedule: (rows) => {
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
  console.error('\nError: ' + e.message);
  console.error('Run `node myaie-bot.mjs --help` for usage, or --selftest to verify the installation.');
  process.exit(1);
});
