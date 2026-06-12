#!/usr/bin/env node
/**
 * Argus Doctor — npm run doctor / argus-doctor
 *
 * Pre-flight check before running any Argus audit. Runs three checks:
 *   1. Chrome CDP reachable at localhost:9222 (or ARGUS_CHROME_PORT)
 *   2. .mcp.json exists, is valid JSON, has a chrome-devtools server entry
 *   3. TARGET_DEV_URL is set (in .env or already in process.env)
 *
 * All three check functions are exported as pure async functions so the
 * test harness can unit-test them without a real Chrome instance or disk setup.
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

/**
 * Check whether Chrome's CDP endpoint is reachable on the given port.
 *
 * @param {number} [port=9222]
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
export async function checkChrome(port = 9222) {
  try {
    const res = await fetch(`http://localhost:${port}/json/version`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, detail: data.Browser ?? 'reachable' };
  } catch (err) {
    return { ok: false, detail: err.message ?? String(err) };
  }
}

/**
 * Check that .mcp.json exists, is valid JSON, and contains a chrome-devtools
 * MCP server entry in mcpServers.
 *
 * @param {string} [filePath='.mcp.json']
 * @returns {{ ok: boolean, detail: string }}
 */
export function checkMcpConfig(filePath = '.mcp.json') {
  if (!fs.existsSync(filePath)) {
    return {
      ok:     false,
      detail: `${path.basename(filePath)} not found — create it with: {"mcpServers":{"chrome-devtools":{"command":"npx","args":["-y","chrome-devtools-mcp@1.1.1"]}}}`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return { ok: false, detail: `Invalid JSON in ${path.basename(filePath)}: ${err.message}` };
  }
  const servers = parsed?.mcpServers ?? parsed?.servers ?? {};
  const hasCdp  = Object.values(servers).some(s => {
    const cmd  = String(s.command ?? '');
    const args = Array.isArray(s.args) ? s.args.map(String) : [];
    return cmd.includes('chrome-devtools') || args.some(a => a.includes('chrome-devtools'));
  });
  if (!hasCdp) {
    return { ok: false, detail: 'No chrome-devtools entry in mcpServers — add: "chrome-devtools": {"command":"npx","args":["-y","chrome-devtools-mcp@1.1.1"]}' };
  }
  return { ok: true, detail: `${Object.keys(servers).length} server(s) configured` };
}

/**
 * Check that TARGET_DEV_URL is set — either already in process.env or present
 * and non-empty in the .env file on disk.
 *
 * @param {string} [envFile='.env']
 * @returns {{ ok: boolean, detail: string }}
 */
export function checkEnvKeys(envFile = '.env') {
  if (process.env.TARGET_DEV_URL) {
    return { ok: true, detail: `TARGET_DEV_URL=${process.env.TARGET_DEV_URL}` };
  }
  if (!fs.existsSync(envFile)) {
    return {
      ok:     false,
      detail: `.env not found — run \`argus init\` to generate one`,
    };
  }
  const content = fs.readFileSync(envFile, 'utf8');
  const match   = content.match(/^TARGET_DEV_URL\s*=\s*(.+)$/m);
  if (!match || !match[1].trim()) {
    return {
      ok:     false,
      detail: 'TARGET_DEV_URL not set in .env — add TARGET_DEV_URL=http://localhost:3000',
    };
  }
  return { ok: true, detail: `TARGET_DEV_URL=${match[1].trim()}` };
}

// ── CLI entry ─────────────────────────────────────────────────────────────────

const PAD = 42;

function row(label, result) {
  const icon   = result.ok ? '✓' : '✗';
  const status = result.ok ? 'OK  ' : 'FAIL';
  process.stdout.write(`  ${icon} ${label.padEnd(PAD)} ${status}  ${result.detail}\n`);
}

if (process.argv[1] === __filename) {
  const port = parseInt(process.env.ARGUS_CHROME_PORT ?? '9222', 10);

  process.stdout.write('\n  ╬ Argus Doctor — pre-flight check\n\n');

  const [chromeRes, mcpRes, envRes] = await Promise.all([
    checkChrome(port),
    Promise.resolve(checkMcpConfig()),
    Promise.resolve(checkEnvKeys()),
  ]);

  row(`Chrome CDP reachable (port ${port})`, chromeRes);
  row('.mcp.json valid + chrome-devtools entry', mcpRes);
  row('TARGET_DEV_URL configured', envRes);

  const allOk = chromeRes.ok && mcpRes.ok && envRes.ok;
  process.stdout.write('\n');
  if (allOk) {
    process.stdout.write('  All checks passed — run `npm run crawl` to start auditing.\n\n');
    process.exit(0);
  } else {
    process.stdout.write('  One or more checks failed — fix the issues above and retry.\n\n');
    process.exit(1);
  }
}
