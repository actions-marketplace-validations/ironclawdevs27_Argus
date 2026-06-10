#!/usr/bin/env node
/**
 * Argus Chrome Launcher — npm run chrome / argus-chrome
 *
 * Finds system Chrome / Chromium on Windows, macOS, and Linux,
 * then launches it with the remote debugging port Argus needs.
 *
 * Exported for testing:
 *   findChrome()       — returns path string or null
 *   launchChrome(opts) — returns { chromePath, process }
 *
 * CLI flags:
 *   --port=N       debugging port (default: 9222)
 *   --headless     launch headless (default: visible)
 *   --url=URL      initial URL (default: about:blank)
 */

import { execFileSync, spawn } from 'child_process';
import fs   from 'fs';
import os   from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

const CHROME_PATHS = {
  win32: [
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
      : null,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Chromium', 'Application', 'chrome.exe')
      : null,
  ].filter(Boolean),
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
  ],
};

/**
 * Find the first Chrome/Chromium binary available on this system.
 * Returns the absolute path string or null if none found.
 *
 * Resolution order:
 *   1. ARGUS_CHROME_PATH env var
 *   2. Known platform-specific paths
 *   3. `which` / `where` fallback
 *
 * @returns {string|null}
 */
export function findChrome() {
  if (process.env.ARGUS_CHROME_PATH && fs.existsSync(process.env.ARGUS_CHROME_PATH)) {
    return process.env.ARGUS_CHROME_PATH;
  }

  const platform   = process.platform;
  const candidates = CHROME_PATHS[platform] ?? CHROME_PATHS.linux;
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }

  try {
    const cmd   = platform === 'win32' ? 'where' : 'which';
    const names = platform === 'win32'
      ? ['chrome', 'chromium']
      : ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium'];
    for (const name of names) {
      try {
        const found = execFileSync(cmd, [name], {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore'],
        }).trim().split('\n')[0].trim();
        if (found && fs.existsSync(found)) return found;
      } catch { /* binary not in PATH */ }
    }
  } catch { /* which/where not available */ }

  return null;
}

/**
 * Launch Chrome with remote debugging enabled and return the spawned process.
 *
 * @param {{ port?: number, headless?: boolean, userDataDir?: string, url?: string }} [options]
 * @returns {{ chromePath: string, process: import('child_process').ChildProcess }}
 * @throws {Error} if Chrome binary cannot be found
 */
export function launchChrome(options = {}) {
  const {
    port        = 9222,
    headless    = false,
    userDataDir = path.join(os.tmpdir(), 'argus-chrome'),
    url         = 'about:blank',
  } = options;

  const chromePath = findChrome();
  if (!chromePath) {
    throw new Error(
      'Chrome not found. Install Google Chrome, then retry.\n' +
      '  Download: https://www.google.com/chrome/\n' +
      '  Or set ARGUS_CHROME_PATH=/path/to/chrome.'
    );
  }

  const flags = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--metrics-recording-only',
    '--no-sandbox',
    '--disable-gpu',
  ];
  if (headless) flags.push('--headless=new');
  flags.push(url);

  const child = spawn(chromePath, flags, { stdio: 'ignore', detached: true });
  child.unref();
  return { chromePath, process: child };
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  const opts = { port: 9222, headless: false, url: 'about:blank' };
  for (const arg of args) {
    if (arg === '--headless' || arg === '--headless=new') { opts.headless = true; continue; }
    const m = arg.match(/^--(\w[\w-]*)(?:=(.*))?$/);
    if (!m) continue;
    const [, key, val] = m;
    if (key === 'port') { opts.port = parseInt(val, 10) || 9222; continue; }
    if (key === 'url')  { opts.url  = val ?? opts.url;           continue; }
  }
  return opts;
}

if (process.argv[1] === __filename) {
  const opts = parseCliArgs();
  const ok   = s => process.stdout.write(`  ✓ ${s}\n`);
  const fail = s => process.stderr.write(`  ✗ ${s}\n`);

  process.stdout.write('\n');
  process.stdout.write('  ╬ Argus Chrome Launcher\n\n');

  const chromePath = findChrome();
  if (!chromePath) {
    fail('Chrome not found. Install Google Chrome or set ARGUS_CHROME_PATH.');
    process.stdout.write('\n  Download: https://www.google.com/chrome/\n\n');
    process.exit(1);
  }

  ok(`Found: ${chromePath}`);

  try {
    const { process: child } = launchChrome(opts);
    ok(`Launched (PID ${child.pid}) — remote debugging on port ${opts.port}`);
    process.stdout.write(`\n  CDP endpoint:  http://localhost:${opts.port}\n`);
    process.stdout.write(`  Run \`npm run doctor\` to verify Argus can reach Chrome.\n\n`);
  } catch (err) {
    fail(err.message);
    process.exit(1);
  }
}
