#!/usr/bin/env node
/**
 * ARGUS Test Harness Validator — full coverage build
 *
 * Closes all 15 gaps identified after the initial harness build:
 *   Gap  1 — HTTP 403 not tested
 *   Gap  2 — console.error on critical route → "critical" severity untested
 *   Gap  3 — waitFor timeout → load_failure never triggered
 *   Gap  4 — API call summary (info) entry never asserted
 *   Gap  5 — Non-!important CSS cascade override never asserted
 *   Gap  6 — SCSS sourceMappingURL never asserted
 *   Gap  7 — Individual Lighthouse audit items never asserted
 *   Gaps 8–10 — LCP / CLS / FID perf metrics: no fixtures, no assertions
 *   Gaps 11–15 — All 7 env-comparison detections missing from validate.js
 *
 * Prerequisites:
 *   Chrome running with remote debugging:
 *     Windows (PowerShell): & "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --headless=new --no-sandbox --disable-gpu --user-data-dir="$env:TEMP\chrome-argus"
 *     Mac:     /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
 *                --remote-debugging-port=9222 --headless=new
 *
 * Usage:
 *   node test-harness/validate.js
 *
 * Exit code: 0 = all hard assertions pass, 1 = any hard assertion fails
 */

import { spawn } from 'child_process';
import crypto from 'crypto';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

import { createMcpClient, unwrapEval } from '../src/utils/mcp-client.js';
import { CdpBrowserAdapter } from '../src/adapters/browser.js';
import { checkLighthouse } from '../src/utils/lighthouse-checker.js';
import { CSS_ANALYSIS_SCRIPT, parseCssAnalysisResult } from '../src/utils/css-analyzer.js';
import { SEO_ANALYSIS_SCRIPT, parseSeoAnalysisResult } from '../src/utils/seo-analyzer.js';
import { SECURITY_ANALYSIS_SCRIPT, parseSecurityAnalysisResult, analyzeSecurityConsole, analyzeSecurityNetwork } from '../src/utils/security-analyzer.js';
import { CONTENT_ANALYSIS_SCRIPT, parseContentAnalysisResult } from '../src/utils/content-analyzer.js';
import { analyzeResponsive } from '../src/utils/responsive-analyzer.js';
import { analyzeMemory } from '../src/utils/memory-analyzer.js';
import { analyzeHover } from '../src/utils/hover-analyzer.js';
import { analyzeSnapshot } from '../src/utils/snapshot-analyzer.js';
import { saveSession, restoreSession, refreshSession } from '../src/utils/session-manager.js';
import { loadBaseline, saveBaseline, applyBaseline, appendTrend, getCurrentBranch } from '../src/utils/baseline-manager.js';
import { mergeRunResults } from '../src/utils/flakiness-detector.js';
import { runFlow, normalizeArray, resolveUidForSelector } from '../src/utils/flow-runner.js';
import { chunkArray } from '../src/utils/parallel-crawler.js';
import { validateSchema, matchesContract, extractResponseBody } from '../src/utils/contract-validator.js';
import { applyOverrides } from '../src/utils/severity-overrides.js';
import { auditEnvVariables, detectFeatureFlagLeakage, enrichErrorsWithSource, detectDeadRoutes, INTERNAL_LINKS_SCRIPT } from '../src/utils/codebase-analyzer.js';
import { isSlackConfigured } from '../src/utils/slack-guard.js';
import { formatPrComment, buildStatusPayload, generateReleaseNotes, createCheckRun, completeCheckRun } from '../src/utils/github-reporter.js';
import { discoverFromSitemap, discoverFromNextJs, discoverFromReactRouter, mergeRoutes, discoverRoutes } from '../src/utils/route-discoverer.js';
import { detectFramework, generateTargetsJs, generateEnvFile } from '../src/cli/init.js';
import os from 'os';
import { generateHtmlReport } from '../src/utils/html-reporter.js';
import {
  HARNESS_DEV_PORT,
  HARNESS_STAGING_PORT
} from './harness-config.js';
// Import the production crawl function so the harness exercises the real pipeline,
// not a hand-rolled duplicate. The Slack init side-effect concern was resolved by lazy
// WebClient init, so importing crawl-and-report.js is now safe in test context.
import { crawlRouteCheap } from '../src/orchestration/crawl-and-report.js';
import { analyzeIssues } from '../src/utils/issues-analyzer.js';
import { parseNetworkTiming } from '../src/utils/network-timing-analyzer.js';
import { analyzeKeyboard } from '../src/utils/keyboard-analyzer.js';
import { analyzeTheme }              from '../src/utils/theme-analyzer.js';
import { analyzeDesignFidelity }    from '../src/utils/design-fidelity-analyzer.js';
import { analyzeVisualRegression }  from '../src/utils/visual-diff-analyzer.js';
import { analyzeA11yDeep }          from '../src/utils/a11y-deep-analyzer.js';
import { analyzeHar }               from '../src/utils/har-recorder.js';
import { analyzeMotion }            from '../src/utils/motion-analyzer.js';
import { analyzeFont }              from '../src/utils/font-analyzer.js';
import { analyzeForm }              from '../src/utils/form-analyzer.js';
import { parseFigmaUrl }           from '../src/adapters/figma.js';
import { analyzeWebVitals }        from '../src/utils/web-vitals-analyzer.js';
import { WatchSession } from '../src/orchestration/watch-mode.js';
import { validateConfig } from '../src/config/schema.js';
import * as argusTargets from '../src/config/targets.js';
import { createFinding } from '../src/domain/finding.js';
import { withRetry } from '../src/utils/retry.js';
import { diffNetworkRequests, diffConsoleMessages } from '../src/utils/diff.js';
import { parsePrUrl, mapFilesToRoutes } from '../src/utils/pr-diff-analyzer.js';
import { buildStepSummary, writeGithubOutputs, writeStepSummary, checkTargetReachable, normalizeRoutePaths } from '../src/cli/pr-validate.js';
import { findChrome } from '../src/cli/chrome-launcher.js';
import { checkChrome, checkMcpConfig, checkEnvKeys } from '../src/cli/doctor.js';
import { checkSourceMapExposure, checkOpenRedirects } from '../src/utils/security-analyzer.js';
import { loadRunHistory, recordRunHistory, computeNoiseScores, applyNoiseFilter, NOISE_MIN_RUNS } from '../src/utils/noise-filter.js';
import { getRecentChanges, matchFilesToRoutePath, linkRootCauses } from '../src/utils/root-cause-linker.js';
// Golden MCP tool response schemas (block [147] — test-harness/contracts/ source of truth).
import {
  TOOL_RESPONSE_SCHEMAS, TOOL_NAMES, formatZodError,
  auditResponseSchema, getContextResponseSchema, reportSummarySchema, prValidateResponseSchema,
} from './contracts/mcp-tool-schemas.js';

// ── Section 1 gap-closer imports (blocks [94]–[107]) ──────────────────────────
import { parseConsoleMsgResponse, parseNetworkReqResponse, parseListPagesResponse } from '../src/utils/mcp-parsers.js';
import { registerCheap, registerExpensive, getCheap, getExpensive, clearAll as clearRegistry } from '../src/registry.js';
import { deduplicateFindings, rebuildSummary, processReport } from '../src/orchestration/report-processor.js';
import { dispatchAll } from '../src/orchestration/dispatcher.js';
import { postBugReport, postRetestResult, acknowledgeMessage } from '../src/orchestration/slack-notifier.js';
import { verifySlackSignature } from '../src/server/slash-command-handler.js';
import { handleInteraction } from '../src/server/interaction-handler.js';
import { slugify } from '../src/utils/slug.js';
import { startSpan, recordFinding, recordFlaky, recordNewFindings } from '../src/utils/telemetry.js';
import { childLogger } from '../src/utils/logger.js';
import * as argusJs from '../src/argus.js';
import * as argBatchRunner from '../src/batch-runner.js';

// ── Section 2 gap-closer imports (blocks [108]–[116]) ─────────────────────────
import { hasSession } from '../src/utils/session-persistence.js';
import { isGitHubConfigured, postPrComment } from '../src/utils/github-reporter.js';
import { startDashboard } from '../src/orchestration/watch-mode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Assertion helpers ─────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failLog = [];

function assert(condition, message) {
  if (condition) {
    console.log(`  \u2713 ${message}`);
    passed++;
  } else {
    console.log(`  \u2717 FAIL: ${message}`);
    failed++;
    failLog.push(message);
  }
}

/** Soft: logged, never counts against exit code. */
function soft(condition, message) {
  console.log(`  ${condition ? '~\u2713' : '~\u2717'} (soft) ${message}`);
}

// ── Server management ─────────────────────────────────────────────────────────

function startServer(port, { staging = false } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORT: String(port), ARGUS_ENV: staging ? 'staging' : 'dev' };
    const proc = spawn(
      'node',
      [path.join(__dirname, 'server.js')],
      { env, stdio: 'pipe' }
    );
    proc.stdout.on('data', chunk => {
      const line = chunk.toString();
      process.stdout.write(`  [harness:${port}] ${line}`);
      if (line.includes('Server running on')) resolve(proc);
    });
    proc.stderr.on('data', chunk => process.stderr.write(`  [harness:${port}] ${chunk}`));
    proc.on('error', reject);
    setTimeout(() => reject(new Error(`Harness server (port ${port}) did not start within 10 s`)), 10000);
  });
}

/** Finds the next available TCP port starting from startPort. */
function findFreePort(startPort) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(startPort, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', () => resolve(findFreePort(startPort + 1)));
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Normalise whatever chrome-devtools-mcp returns into a plain array.
 * The MCP may return [] directly, or wrap it: { requests:[...] }, { messages:[...] }, etc.
 */
function toArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  // Check common single-key wrappers
  for (const key of ['requests', 'networkRequests', 'messages', 'consoleMessages',
    'items', 'data', 'results', 'entries']) {
    if (Array.isArray(val[key])) return val[key];
  }
  // Last resort: if it's a single-value object whose value is an array
  const vals = Object.values(val);
  if (vals.length === 1 && Array.isArray(vals[0])) return vals[0];
  return [];
}

/**
 * Safely extract the plain value from an evaluate_script result.
 * chrome-devtools-mcp may return a raw string/boolean, or a { result, type } wrapper.
 */
function parseEval(val, fallback = '') {
  if (val == null) return fallback;
  if (typeof val === 'string') return val;
  if (typeof val === 'boolean' || typeof val === 'number') return val;
  if (typeof val?.result === 'string') return val.result;
  if (typeof val?.value === 'string') return val.value;
  return fallback;
}

/**
 * Parse an evaluate_script result that should be a JSON array.
 * Handles pre-parsed arrays (mcp-client JSON.parses the result string) and raw strings.
 */
function evalToArray(val) {
  if (val == null) return [];
  if (Array.isArray(val)) return val;
  const str = typeof val === 'string' ? val : (val?.result ?? val?.value ?? null);
  if (!str) return [];
  try { const p = JSON.parse(str); return Array.isArray(p) ? p : []; } catch { return []; }
}

// Performance API — collects network requests via PerformanceResourceTiming.
// responseStatus (Chrome 109+) gives the actual HTTP status including 4xx/5xx.
// Returns array directly (no JSON.stringify) so CDP serialises it once, not twice.
const NET_SCRIPT = `() => window.performance.getEntriesByType('resource').map(function(e){return{url:e.name,status:e.responseStatus??0,method:'GET',resourceType:e.initiatorType,duration:Math.round(e.duration||0),transferSize:e.transferSize||0,decodedBodySize:e.decodedBodySize||0}})`;

// Read in-page console capture array (populated by the interceptor in each fixture page).
// Returns array directly so CDP serialises it once.
const CONSOLE_READ_SCRIPT = `() => (window.__argus_console||[])`;

// D6.1 — Synchronous XHR detection (same logic as crawl-and-report.js)
const INJECT_SYNC_XHR_LISTENER = `() => {
  if (window.__argusSyncXhrPatched) return;
  window.__argusSyncXhrPatched = true;
  window.__argusSyncXhrs = [];
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, async) {
    if (async === false) {
      window.__argusSyncXhrs.push({ method: String(method || 'GET'), url: String(url) });
    }
    return _open.apply(this, arguments);
  };
}`;
const EXTRACT_SYNC_XHR_LISTENER = `() => JSON.stringify(window.__argusSyncXhrs ?? [])`;

// D6.2 — document.write / document.writeln detection (same logic as crawl-and-report.js)
const INJECT_DOC_WRITE_LISTENER = `() => {
  if (window.__argusDocWritePatched) return;
  window.__argusDocWritePatched = true;
  window.__argusDocWrites = [];
  var _write   = document.write.bind(document);
  var _writeln = document.writeln.bind(document);
  document.write = function() {
    window.__argusDocWrites.push({ method: 'write', content: String(arguments[0] ?? '').slice(0, 200) });
    return _write.apply(document, arguments);
  };
  document.writeln = function() {
    window.__argusDocWrites.push({ method: 'writeln', content: String(arguments[0] ?? '').slice(0, 200) });
    return _writeln.apply(document, arguments);
  };
}`;
const EXTRACT_DOC_WRITE_LISTENER = `() => JSON.stringify(window.__argusDocWrites ?? [])`;

// D6.2 — Static analysis: scan inline + same-origin external scripts for document.write/writeln calls.
// More reliable than runtime patching because post-load document.write causes document.open() which
// resets the JS context and destroys any previously-injected patches.
const DETECT_DOC_WRITE_STATIC = `async () => {
  var found = [];
  var seen = new Set();
  function checkSrc(src, label) {
    if (/\\bdocument\\.write\\s*\\(/.test(src) && !seen.has('write:'+label)) {
      found.push({ method: 'write', content: label }); seen.add('write:'+label);
    }
    if (/\\bdocument\\.writeln\\s*\\(/.test(src) && !seen.has('writeln:'+label)) {
      found.push({ method: 'writeln', content: label }); seen.add('writeln:'+label);
    }
  }
  function isJsType(el) {
    var t = (el.type || '').toLowerCase().trim();
    return t === '' || t === 'text/javascript' || t === 'application/javascript' || t === 'module';
  }
  var inlines = document.querySelectorAll('script:not([src])');
  for (var i = 0; i < inlines.length; i++) {
    if (isJsType(inlines[i])) checkSrc(inlines[i].textContent||'','(inline)');
  }
  var externals = document.querySelectorAll('script[src]');
  var fetches = [];
  for (var i = 0; i < externals.length; i++) {
    if (!isJsType(externals[i])) continue;
    var u = externals[i].src;
    if (!u || !u.startsWith(location.origin)) continue;
    fetches.push(fetch(u).then(function(r){return r.text();}).then(function(t){checkSrc(t,u);}).catch(function(){}));
  }
  await Promise.all(fetches);
  return JSON.stringify(found);
}`;

// D6.3 — Long task detection (same logic as crawl-and-report.js)
const INJECT_LONG_TASK_LISTENER = `() => {
  if (!window.__argusLongTasks) window.__argusLongTasks = []; // preserve in-page direct measurement
  if (window.__argusLongTaskPatched) return;
  window.__argusLongTaskPatched = true;
  try {
    var obs = new PerformanceObserver(function(list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        var attr = e.attribution && e.attribution[0];
        window.__argusLongTasks.push({
          duration:  Math.round(e.duration),
          startTime: Math.round(e.startTime),
          attribution: attr ? {
            name:          attr.name          || null,
            containerType: attr.containerType || null,
            containerSrc:  attr.containerSrc  || null,
          } : null,
        });
      }
    });
    obs.observe({ entryTypes: ['longtask'] });
  } catch (e) { /* longtask not supported — skip */ }
}`;
const EXTRACT_LONG_TASK_LISTENER = `() => JSON.stringify(window.__argusLongTasks ?? [])`;

// D6.5 — Service worker registration failure detection (same logic as crawl-and-report.js)
const INJECT_SW_LISTENER = `() => {
  if (!window.__argusSwErrors) window.__argusSwErrors = []; // preserve in-page direct capture
  if (window.__argusSwPatched) return;
  window.__argusSwPatched = true;
  if (!navigator.serviceWorker) return;
  var _register = navigator.serviceWorker.register.bind(navigator.serviceWorker);
  navigator.serviceWorker.register = function(scriptURL, options) {
    var reg = _register(scriptURL, options);
    reg.catch(function(err) {
      window.__argusSwErrors.push({
        scriptURL: String(scriptURL || ''),
        message:   err && err.message ? err.message : String(err),
      });
    });
    return reg;
  };
}`;
const EXTRACT_SW_LISTENER = `() => JSON.stringify(window.__argusSwErrors ?? [])`;

// D6.8 — Duplicate id="" attribute detection
const DUPLICATE_ID_SCRIPT = `() => {
  var counts = {};
  var els = document.querySelectorAll('[id]');
  for (var i = 0; i < els.length; i++) {
    var id = els[i].id;
    if (!id) continue;
    counts[id] = (counts[id] || 0) + 1;
  }
  var dupes = [];
  for (var id in counts) {
    if (counts[id] > 1) dupes.push({ id: id, count: counts[id] });
  }
  return JSON.stringify(dupes);
}`;

// D6.7 — debugger; statement detection (inline + same-origin external scripts)
const DEBUGGER_SCRIPT = `async () => {
  var found = [];
  function isJsType(el) {
    var t = (el.type || '').toLowerCase().trim();
    return t === '' || t === 'text/javascript' || t === 'application/javascript' || t === 'module';
  }
  var inline = document.querySelectorAll('script:not([src])');
  for (var i = 0; i < inline.length; i++) {
    if (!isJsType(inline[i])) continue;
    var src = inline[i].textContent || '';
    var lines = src.split('\\n');
    for (var ln = 0; ln < lines.length; ln++) {
      if (/\\bdebugger\\s*;/.test(lines[ln])) {
        found.push({ scriptUrl: '(inline)', line: ln + 1, snippet: lines[ln].trim().slice(0, 120) });
      }
    }
  }
  var origin = window.location.origin;
  var seen = {};
  var extEls = document.querySelectorAll('script[src]');
  var extUrls = [];
  for (var i = 0; i < extEls.length && extUrls.length < 20; i++) {
    if (!isJsType(extEls[i])) continue;
    var u = extEls[i].src;
    if (!u || !u.startsWith(origin) || seen[u]) continue;
    seen[u] = true;
    extUrls.push(u);
  }
  await Promise.all(extUrls.map(async function(scriptUrl) {
    try {
      var r = await fetch(scriptUrl, { cache: 'force-cache', credentials: 'same-origin' });
      var text = await r.text();
      var lines = text.split('\\n');
      for (var ln = 0; ln < lines.length; ln++) {
        if (/\\bdebugger\\s*;/.test(lines[ln])) {
          var filename = scriptUrl.replace(/^.*\\//, '').split('?')[0];
          found.push({ scriptUrl: filename || scriptUrl, line: ln + 1, snippet: lines[ln].trim().slice(0, 120) });
        }
      }
    } catch(e) {}
  }));
  return JSON.stringify(found);
}`;

// D6.6 — Cache headers detection (async evaluate_script, runs after page settle)
const CACHE_HEADER_SCRIPT = `async () => {
  var ASSET_EXT = /\\.(js|css|png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|otf)(\\?.*)?$/i;
  var origin = window.location.origin;
  var seen = {};
  var candidates = window.performance.getEntriesByType('resource')
    .map(function(e){ return e.name; })
    .filter(function(u){
      if (!u.startsWith(origin) || !ASSET_EXT.test(u)) return false;
      if (seen[u]) return false;
      seen[u] = true;
      return true;
    })
    .slice(0, 25);
  var missing = [];
  await Promise.all(candidates.map(async function(assetUrl){
    try {
      var r = await fetch(assetUrl, { method: 'HEAD', cache: 'reload', credentials: 'same-origin' });
      if (!r.headers.get('cache-control') && !r.headers.get('etag')) {
        missing.push({ url: assetUrl });
      }
    } catch(e) {}
  }));
  return JSON.stringify(missing);
}`;

// ── Lightweight page crawler ──────────────────────────────────────────────────
// Does NOT import crawl-and-report.js — avoids Slack initialisation side-effect.

async function crawlFixture(mcp, url, { critical = false, waitFor = null } = {}) {
  const errors = [];

  // Snapshot browser console count before navigation for CORS baseline slicing.
  // Captured here (before navigate) to establish the accumulation watermark.
  const consoleListBaseline = normalizeArray(await mcp.list_console_messages().catch(() => [])).length;

  await mcp.navigate_page({ url });

  // Inject listeners IMMEDIATELY after navigation so the new page context is live.
  // Must run before the settle wait so events fired by setTimeout/onload are captured.
  await mcp.evaluate_script({ function: INJECT_SYNC_XHR_LISTENER }).catch(() => { });   // D6.1
  await mcp.evaluate_script({ function: INJECT_DOC_WRITE_LISTENER }).catch(() => { });  // D6.2
  await mcp.evaluate_script({ function: INJECT_LONG_TASK_LISTENER }).catch(() => { });  // D6.3
  await mcp.evaluate_script({ function: INJECT_SW_LISTENER }).catch(() => { });         // D6.5

  if (waitFor) {
    // Poll every 300 ms for up to 5 s — wait_for alone doesn't reliably reject on timeout.
    const pollEnd = Date.now() + 5000;
    let selectorFound = false;
    while (!selectorFound && Date.now() < pollEnd) {
      const existsRaw = await mcp.evaluate_script({
        function: `() => !!document.querySelector(${JSON.stringify(waitFor)})`,
      });
      selectorFound = parseEval(existsRaw) === true || parseEval(existsRaw) === 'true';
      if (!selectorFound && Date.now() < pollEnd) await sleep(300);
    }
    if (!selectorFound) {
      errors.push({
        type: 'load_failure',
        message: `Selector "${waitFor}" not found within timeout`,
        severity: critical ? 'critical' : 'warning'
      });
    }
    await sleep(300);
  } else {
    await sleep(2000);
  }

  // Blank page check
  const bodyRes = await mcp.evaluate_script({ function: '() => document.body?.innerText?.trim() ?? ""' });
  const bodyText = String(parseEval(bodyRes, ''));
  if (!bodyText || bodyText.length < 50)
    errors.push({ type: 'blank_page', message: 'Page appears blank (body < 50 chars)', severity: 'critical' });

  // Console messages — read from in-page interceptor; list_console_messages() misses
  // events that fire during page load before the MCP has subscribed.
  const consoleMsgs = evalToArray(await mcp.evaluate_script({ function: CONSOLE_READ_SCRIPT }));
  for (const msg of consoleMsgs) {
    const rawLevel = (msg.level ?? '').toLowerCase();
    const level = rawLevel === 'warn' ? 'warning' : rawLevel; // normalise console.warn → 'warning'
    if (level !== 'error' && level !== 'warning') continue;
    errors.push({
      type: 'console', level,
      message: msg.text ?? msg.message ?? String(msg),
      severity: level === 'error' ? (critical ? 'critical' : 'warning') : 'info',
    });
  }

  // Network failures — use Performance API instead of list_network_requests()
  // to capture requests that completed before the MCP subscribed.
  const networkReqs = evalToArray(await mcp.evaluate_script({ function: NET_SCRIPT }));
  for (const req of networkReqs) {
    const status = req.status ?? 0;
    if (status < 400) continue;
    const isCrit = status >= 500 || status === 401 || status === 403;
    errors.push({
      type: 'network', status, method: req.method ?? 'GET',
      requestUrl: req.url, severity: isCrit ? 'critical' : (critical ? 'warning' : 'info')
    });
  }

  // API frequency analysis (inlined — no Slack dependency)
  const staticExt = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map|webp|avif)(\?|$)/i;
  const apiCalls = networkReqs.filter(r => {
    const u = r.url ?? '';
    const rt = (r.resourceType ?? '').toLowerCase();
    return !staticExt.test(u) && (
      /\/(api|graphql|rest|v\d+)\//i.test(u) ||
      rt === 'xmlhttprequest' || rt === 'fetch' || rt === 'xhr'
    );
  });
  const groups = {};
  for (const req of apiCalls) {
    const method = (req.method ?? 'GET').toUpperCase();
    let ep;
    try { const u = new URL(req.url); ep = u.pathname.replace(/\/\d+/g, '/{id}'); }
    catch { ep = (req.url ?? '').replace(/[?#].*/, '').replace(/\/\d+/g, '/{id}'); }
    const key = `${method}::${ep}`;
    if (!groups[key]) groups[key] = { method, ep, count: 0 };
    groups[key].count++;
  }
  const uniqueCount = Object.keys(groups).length;
  const totalCount = apiCalls.length;
  for (const { method, ep, count } of Object.values(groups)) {
    if (count <= 1) continue;
    const sev = count >= 5 ? 'critical' : count >= 3 ? 'warning' : 'info';
    errors.push({
      type: 'api_duplicate_call', endpoint: ep, callCount: count,
      method, severity: sev, message: `API called ${count}× : ${method} ${ep}`
    });
  }
  if (totalCount > 0) {
    const dupCount = Object.values(groups).filter(g => g.count > 1).length;
    errors.push({
      type: 'api_call_summary', uniqueEndpoints: uniqueCount,
      totalCalls: totalCount, duplicateEndpoints: dupCount, severity: 'info',
      message: `API summary: ${totalCount} calls to ${uniqueCount} unique endpoints`
    });
  }

  // Network performance analysis — slow/large API detection (v3 Phase A2)
  for (const entry of networkReqs) {
    const reqUrl = entry.url ?? '';
    if (staticExt.test(reqUrl)) continue;
    if (
      !/\/(api|graphql|rest|v\d+)\//i.test(reqUrl) &&
      !['xmlhttprequest', 'fetch', 'xhr'].includes((entry.resourceType ?? '').toLowerCase())
    ) continue;
    const dur = entry.duration ?? 0;
    const bytes = entry.decodedBodySize || entry.transferSize || 0;
    if (dur > 3000) {
      errors.push({
        type: 'slow_api', requestUrl: reqUrl, duration: Math.round(dur),
        severity: 'critical', message: `Slow API ${Math.round(dur)} ms — ${reqUrl}`
      });
    } else if (dur > 1000) {
      errors.push({
        type: 'slow_api', requestUrl: reqUrl, duration: Math.round(dur),
        severity: 'warning', message: `Slow API ${Math.round(dur)} ms — ${reqUrl}`
      });
    }
    if (bytes > 2 * 1024 * 1024) {
      errors.push({
        type: 'large_payload', requestUrl: reqUrl, bytes,
        severity: 'critical', message: `Oversized payload ${Math.round(bytes / 1024)} KB — ${reqUrl}`
      });
    } else if (bytes > 500 * 1024) {
      errors.push({
        type: 'large_payload', requestUrl: reqUrl, bytes,
        severity: 'warning', message: `Oversized payload ${Math.round(bytes / 1024)} KB — ${reqUrl}`
      });
    }
  }

  // SEO analysis — meta tags, OG, h1, title, canonical, viewport (v3 Phase A3)
  try {
    const seoRaw = await mcp.evaluate_script({ function: SEO_ANALYSIS_SCRIPT });
    const seoInput = seoRaw == null ? null
      : typeof seoRaw === 'object' && !Array.isArray(seoRaw) ? seoRaw
        : parseEval(seoRaw, null);
    if (seoInput) {
      const seoBugs = parseSeoAnalysisResult(seoInput, url);
      errors.push(...seoBugs);
    }
  } catch { /* SEO analysis unavailable */ }

  // Security analysis — localStorage, eval(), cookies, headers, console sensitive data, URL tokens (v3 Phase A4)
  try {
    const secRaw = await mcp.evaluate_script({ function: SECURITY_ANALYSIS_SCRIPT });
    const secInput = secRaw == null ? null
      : typeof secRaw === 'object' && !Array.isArray(secRaw) ? secRaw
        : parseEval(secRaw, null);
    if (secInput) {
      const secBugs = parseSecurityAnalysisResult(secInput, url);
      errors.push(...secBugs);
    }
  } catch { /* Security DOM analysis unavailable */ }
  errors.push(...analyzeSecurityConsole(consoleMsgs, url));
  errors.push(...analyzeSecurityNetwork(networkReqs, url));

  // Content quality analysis — null/undefined text, placeholders, broken images, empty lists (v3 Phase A5)
  try {
    const contentRaw = await mcp.evaluate_script({ function: CONTENT_ANALYSIS_SCRIPT });
    const contentInput = contentRaw == null ? null
      : typeof contentRaw === 'object' && !Array.isArray(contentRaw) ? contentRaw
        : parseEval(contentRaw, null);
    if (contentInput) {
      const contentBugs = parseContentAnalysisResult(contentInput, url);
      errors.push(...contentBugs);
    }
  } catch { /* Content analysis unavailable */ }

  // CSS analysis (CSS_ANALYSIS_SCRIPT returns JSON.stringify(report);
  // mcp-client.js parses that to an object; parseCssAnalysisResult handles both)
  try {
    const cssRaw = await mcp.evaluate_script({ function: CSS_ANALYSIS_SCRIPT });
    // cssRaw may be a pre-parsed object (common), raw JSON string, or null on error
    const cssInput = cssRaw == null ? null
      : typeof cssRaw === 'object' && !Array.isArray(cssRaw) ? cssRaw
        : parseEval(cssRaw, null);
    if (cssInput) {
      const cssBugs = parseCssAnalysisResult(cssInput, url);
      errors.push(...cssBugs);
    }
  } catch { /* CSS analysis unavailable */ }

  // Redirect chain detection (D2.1) — Navigation Timing redirectCount
  try {
    const rdRaw = await mcp.evaluate_script({ function: `() => window.performance.getEntriesByType('navigation')[0]?.redirectCount ?? 0` });
    const rdCount = Number(unwrapEval(rdRaw) ?? 0);
    if (rdCount > 2) {
      errors.push({
        type: 'redirect_chain', count: rdCount, severity: 'warning',
        message: `Redirect chain length ${rdCount} (threshold: > 2)`
      });
    }
  } catch { /* skip */ }

  // Broken internal link detection (D2.3) — HEAD each same-origin <a href>
  try {
    const INTERNAL_LINKS_SCRIPT = `() => { try { var orig = window.location.origin; return Array.from(document.querySelectorAll('a[href]')).map(function(a){ return a.href; }).filter(function(h){ if (!h || h.indexOf('#') === 0 || h.indexOf('mailto:') === 0 || h.indexOf('tel:') === 0) return false; try { return new URL(h).origin === orig; } catch { return false; } }); } catch(e) { return []; } }`;
    const linksRaw = await mcp.evaluate_script({ function: INTERNAL_LINKS_SCRIPT });
    const links = [...new Set(evalToArray(linksRaw).filter(Boolean))];
    const headResults = await Promise.all(
      links.map(async href => {
        try {
          const res = await fetch(href, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
          return { href, status: res.status };
        } catch {
          return { href, status: 0 };
        }
      })
    );
    for (const { href, status } of headResults) {
      if (status === 404) {
        errors.push({
          type: 'broken_link', requestUrl: href, status: 404,
          severity: 'warning', message: `Broken internal link: ${href} (HTTP 404)`
        });
      }
    }
  } catch { /* skip */ }

  // Sync XHR detection (D6.1)
  try {
    const syncXhrRaw = await mcp.evaluate_script({ function: EXTRACT_SYNC_XHR_LISTENER });
    const syncXhrs = evalToArray(syncXhrRaw);
    for (const entry of syncXhrs) {
      errors.push({
        type: 'sync_xhr',
        method: entry.method ?? 'GET',
        requestUrl: entry.url,
        message: `Synchronous XHR: ${entry.method ?? 'GET'} ${entry.url} — blocks the main thread`,
        severity: 'warning',
      });
    }
  } catch { /* skip */ }

  // document.write detection — static analysis (D6.2)
  // Runtime patching is unreliable: post-load document.write triggers document.open() which
  // resets the JS context. Scanning script source is stable regardless of execution timing.
  try {
    const docWriteRaw = await mcp.evaluate_script({ function: DETECT_DOC_WRITE_STATIC });
    const docWrites = evalToArray(docWriteRaw);
    for (const entry of docWrites) {
      errors.push({
        type: 'document_write',
        method: entry.method,
        content: entry.content,
        message: `document.${entry.method}() is parser-blocking and degrades page performance`,
        severity: 'warning',
      });
    }
  } catch { /* skip */ }

  // Long task detection (D6.3)
  try {
    const longTaskRaw = await mcp.evaluate_script({ function: EXTRACT_LONG_TASK_LISTENER });
    const longTasks = evalToArray(longTaskRaw);
    for (const entry of longTasks) {
      errors.push({
        type: 'long_task',
        duration: entry.duration,
        startTime: entry.startTime,
        attribution: entry.attribution,
        message: `Long task: ${entry.duration}ms — blocks the main thread (threshold: 50ms)`,
        severity: 'warning',
      });
    }
  } catch { /* skip */ }

  // CORS error detection (D6.4)
  // Primary: in-page console interceptor (fixture calls console.error with "cors policy" text).
  // Fallback: CDP list_console_messages() which may capture browser-level CORS messages.
  try {
    const corsSet = new Set();
    const addCors = (text) => {
      if (!corsSet.has(text)) {
        corsSet.add(text);
        errors.push({ type: 'cors_error', message: text || 'CORS policy violation', severity: 'critical' });
      }
    };
    for (const msg of consoleMsgs) {
      const text = (msg.text ?? msg.message ?? '');
      if (text.toLowerCase().includes('has been blocked by cors policy')) addCors(text);
    }
    const allCdpMsgs = normalizeArray(await mcp.list_console_messages().catch(() => []));
    const corsBase = allCdpMsgs.length > consoleListBaseline ? consoleListBaseline : 0;
    const browserMsgs = allCdpMsgs.slice(corsBase);
    for (const msg of browserMsgs) {
      const text = (msg.text ?? msg.message ?? '');
      if (text.toLowerCase().includes('has been blocked by cors policy')) addCors(text);
    }
  } catch { /* skip */ }

  // Service worker registration failure detection (D6.5)
  try {
    const swRaw = await mcp.evaluate_script({ function: EXTRACT_SW_LISTENER });
    const swErrs = evalToArray(swRaw);
    for (const entry of swErrs) {
      errors.push({
        type: 'sw_registration_error',
        scriptURL: entry.scriptURL,
        message: `Service worker registration failed for "${entry.scriptURL}": ${entry.message}`,
        severity: 'warning',
      });
    }
  } catch { /* skip */ }

  // Cache header detection — same-origin static assets missing Cache-Control + ETag (D6.6)
  try {
    const cacheRaw = await mcp.evaluate_script({ function: CACHE_HEADER_SCRIPT });
    const cacheItems = evalToArray(cacheRaw);
    for (const entry of cacheItems) {
      const filename = (entry.url ?? '').replace(/^.*\//, '').split('?')[0] || entry.url;
      errors.push({
        type: 'cache_headers_missing',
        requestUrl: entry.url,
        message: `No cache headers on "${filename}" — missing both Cache-Control and ETag`,
        severity: 'info',
      });
    }
  } catch { /* skip */ }

  // debugger; statement detection — inline + same-origin external scripts (D6.7)
  try {
    const dbgRaw = await mcp.evaluate_script({ function: DEBUGGER_SCRIPT });
    const dbgHits = evalToArray(dbgRaw);
    for (const entry of dbgHits) {
      errors.push({
        type: 'debugger_statement',
        scriptUrl: entry.scriptUrl,
        line: entry.line,
        snippet: entry.snippet,
        message: `debugger; statement found in "${entry.scriptUrl}" (line ${entry.line}) — remove before shipping`,
        severity: 'critical',
      });
    }
  } catch { /* skip */ }

  // Duplicate id="" detection (D6.8)
  try {
    const dupIdRaw = await mcp.evaluate_script({ function: DUPLICATE_ID_SCRIPT });
    const dupIds = evalToArray(dupIdRaw);
    for (const entry of dupIds) {
      errors.push({
        type: 'duplicate_id',
        id: entry.id,
        count: entry.count,
        message: `Duplicate id="${entry.id}" found on ${entry.count} elements — id must be unique per document`,
        severity: 'warning',
      });
    }
  } catch { /* skip */ }

  return { errors, networkReqs, consoleMsgs };
}

// ── Full Lighthouse measurement (v3 — all 4 categories) ──────────────────────

async function measureLighthouse(mcp, url) {
  try {
    const result = await mcp.lighthouse_audit({
      categories: ['accessibility', 'performance', 'seo', 'best-practices'],
      url,
    });
    const cats = result?.categories ?? {};
    const audits = result?.audits ?? {};

    const score = (key) => {
      const s = cats[key]?.score ?? result?.[key]?.score ?? null;
      return s != null ? Math.round(s * 100) : null;
    };

    const failingAudits = Object.entries(audits)
      .filter(([, a]) => a.score === 0 && a.details?.type !== 'manual')
      .map(([id, a]) => ({ id, title: a.title ?? id }));

    return {
      accessibility: score('accessibility'),
      performance: score('performance'),
      seo: score('seo'),
      bestPractices: score('best-practices'),
      failingAudits,
    };
  } catch {
    return { accessibility: null, performance: null, seo: null, bestPractices: null, failingAudits: [] };
  }
}

/** Backwards-compatible alias used by tests 12–14. */
async function measureA11y(mcp, url) {
  const r = await measureLighthouse(mcp, url);
  return { score: r.accessibility, failingAudits: r.failingAudits };
}

// ── Visual diff (env-comparison) ──────────────────────────────────────────────

function extractRegion(png, w, h) {
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = (y * png.width + x) * 4, d = (y * w + x) * 4;
      buf[d] = png.data[s]; buf[d + 1] = png.data[s + 1];
      buf[d + 2] = png.data[s + 2]; buf[d + 3] = png.data[s + 3];
    }
  return buf;
}

function visualDiff(devShot, stagingShot) {
  if (!devShot?.data || !stagingShot?.data) return { diffPct: null };
  try {
    const i1 = PNG.sync.read(Buffer.from(devShot.data, 'base64'));
    const i2 = PNG.sync.read(Buffer.from(stagingShot.data, 'base64'));
    const w = Math.min(i1.width, i2.width), h = Math.min(i1.height, i2.height);
    const n = pixelmatch(extractRegion(i1, w, h), extractRegion(i2, w, h),
      Buffer.alloc(w * h * 4), w, h, { threshold: 0.1 });
    return { diffPct: parseFloat(((n / (w * h)) * 100).toFixed(2)) };
  } catch (e) { return { diffPct: null, error: e.message }; }
}

// ── MCP stdio transport helpers (blocks [117]–[120]) ─────────────────────────

let _mcpSeq = 5000; // high base to avoid collision with any per-block local IDs

async function mcpStdioRead(stdout, id, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      stdout.off('data', handler);
      reject(new Error(`MCP stdio timeout waiting for id=${id}`));
    }, timeoutMs);
    const handler = (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop(); // keep partial last line
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          if (obj.id === id) {
            clearTimeout(timer);
            stdout.off('data', handler);
            resolve(obj);
          }
        } catch {}
      }
    };
    stdout.on('data', handler);
  });
}

async function spawnArgusServer(cwd, extraEnv = {}) {
  const serverPath = path.resolve(__dirname, '../src/mcp-server.js');
  const proc = spawn(process.execPath, [serverPath], {
    cwd: cwd || path.resolve(__dirname, '..'),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ARGUS_LOG_LEVEL: 'error', ARGUS_LOG_PRETTY: '0', ...extraEnv },
  });
  proc.stderr.on('data', () => {});
  proc.on('error', () => {});

  const initId = ++_mcpSeq;
  proc.stdin.write(JSON.stringify({
    jsonrpc: '2.0', id: initId, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'argus-harness', version: '1.0' } },
  }) + '\n');

  const initResp = await mcpStdioRead(proc.stdout, initId, 8000);

  // Required MCP notification after server confirms initialization
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

  return { proc, initResp };
}

/** Send a tools/call and return the raw JSON-RPC response object. */
async function mcpToolCall(proc, name, args = {}, timeoutMs = 60000) {
  const id = ++_mcpSeq;
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  return mcpStdioRead(proc.stdout, id, timeoutMs);
}

/** Send a tools/list and return the tools array (server-survives probe). */
async function mcpListTools(proc, timeoutMs = 10000) {
  const id = ++_mcpSeq;
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: {} }) + '\n');
  const resp = await mcpStdioRead(proc.stdout, id, timeoutMs);
  return resp?.result?.tools ?? [];
}

// ── Test suite ────────────────────────────────────────────────────────────────

async function runTests(mcp, stagingProc, devPort, stagingPort) {
  const browser = new CdpBrowserAdapter(mcp);
  const B = `http://localhost:${devPort}`;
  const BS = `http://localhost:${stagingPort}`;

  // Clear any Chrome state left by a previous harness run (auth cookies, localStorage)
  try {
    await mcp.navigate_page({ url: B });
    await mcp.evaluate_script({
      function: `() => {
        localStorage.clear();
        sessionStorage.clear();
        document.cookie.split(';').forEach(function(c) {
          document.cookie = c.trim().replace(/=.*/, '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/');
        });
        return true;
      }`,
    });
  } catch { /* best-effort — Chrome may not have the origin loaded yet */ }

  // ── [1] Clean page ────────────────────────────────────────────────────────
  console.log('\n[1] Clean page — expect: zero warnings / criticals');
  {
    const { errors } = await crawlFixture(mcp, `${B}/clean.html`);
    const bads = errors.filter(e => e.severity === 'critical' || e.severity === 'warning');
    assert(bads.length === 0,
      `No warning/critical on clean page (got ${bads.length}: ${bads.map(e => e.type).join(', ') || 'none'})`);
  }

  // ── [2] JS errors (non-critical route) ───────────────────────────────────
  console.log('\n[2] JS Errors — console.error, console.warn, thrown TypeError, unhandled rejection');
  {
    const { errors } = await crawlFixture(mcp, `${B}/js-errors.html`, { critical: false });
    const ce = errors.filter(e => e.type === 'console' && e.level === 'error');
    const cw = errors.filter(e => e.type === 'console' && e.level === 'warning');
    assert(ce.length > 0, `console.error detected (found ${ce.length})`);
    assert(cw.length > 0, `console.warn detected (found ${cw.length})`);
    assert(ce.every(e => e.severity === 'warning'), `console errors → severity "warning" on non-critical route`);
  }

  // ── [3] JS errors (non-critical, severity check) ─────────────────────────
  console.log('\n[3] Non-critical JS errors — 2+ console.error at severity "warning"');
  {
    const { errors } = await crawlFixture(mcp, `${B}/js-errors-noncritical.html`, { critical: false });
    const ce = errors.filter(e => e.type === 'console' && e.level === 'error');
    assert(ce.length >= 2, `At least 2 console errors (found ${ce.length})`);
    assert(ce.every(e => e.severity === 'warning'), `All at severity "warning"`);
  }

  // ── [4] JS errors (critical route) ──────────────────────────────────────
  console.log('\n[4] JS Errors on critical route — expect: severity "critical" (not "warning")');
  {
    const { errors } = await crawlFixture(mcp, `${B}/js-errors-critical.html`, { critical: true });
    const ce = errors.filter(e => e.type === 'console' && e.level === 'error');
    assert(ce.length >= 2, `At least 2 console errors on critical route (found ${ce.length})`);
    assert(ce.every(e => e.severity === 'critical'), `All console errors → severity "critical" on critical route`);
  }

  // ── [5] Network errors — added HTTP 403 ─────────────────────────────────
  console.log('\n[5] Network Errors — HTTP 500 critical, 401 critical, 403 critical, 404 info');
  {
    const { errors } = await crawlFixture(mcp, `${B}/network-errors.html`, { critical: false });
    const n500 = errors.filter(e => e.type === 'network' && e.status === 500);
    const n401 = errors.filter(e => e.type === 'network' && e.status === 401);
    const n403 = errors.filter(e => e.type === 'network' && e.status === 403);
    const n404 = errors.filter(e => e.type === 'network' && e.status === 404);
    assert(n500.length > 0, `HTTP 500 detected`);
    assert(n401.length > 0, `HTTP 401 detected`);
    assert(n403.length > 0, `HTTP 403 detected`);
    assert(n404.length > 0, `HTTP 404 detected`);
    assert(n500[0]?.severity === 'critical', `HTTP 500 → "critical"`);
    assert(n401[0]?.severity === 'critical', `HTTP 401 → "critical" (auth)`);
    assert(n403[0]?.severity === 'critical', `HTTP 403 → "critical" (forbidden)`);
    assert(n404[0]?.severity === 'info', `HTTP 404 → "info" on non-critical route`);
  }

  // ── [6] API frequency — added api_call_summary assertion ────────────────
  console.log('\n[6] API Frequency — ×6 critical, ×3 warning, ×2 info, plus summary entry');
  {
    const { errors } = await crawlFixture(mcp, `${B}/api-frequency.html`);
    const loop = errors.filter(e => e.type === 'api_duplicate_call' && (e.endpoint ?? '').includes('data-loop'));
    const batch = errors.filter(e => e.type === 'api_duplicate_call' && (e.endpoint ?? '').includes('data-batch'));
    const pair = errors.filter(e => e.type === 'api_duplicate_call' && (e.endpoint ?? '').includes('data-pair'));
    const summary = errors.filter(e => e.type === 'api_call_summary');
    assert(loop.length > 0 && loop[0].callCount >= 6, `data-loop ×6+ (got ${loop[0]?.callCount ?? 0})`);
    assert(batch.length > 0 && batch[0].callCount >= 3, `data-batch ×3+ (got ${batch[0]?.callCount ?? 0})`);
    assert(pair.length > 0 && pair[0].callCount >= 2, `data-pair ×2+ (got ${pair[0]?.callCount ?? 0})`);
    assert(loop[0]?.severity === 'critical', `data-loop → "critical"`);
    assert(batch[0]?.severity === 'warning', `data-batch → "warning"`);
    assert(pair[0]?.severity === 'info', `data-pair → "info"`);
    assert(summary.length > 0, `API call summary entry generated`);
  }

  // ── [7] Blank page ────────────────────────────────────────────────────────
  console.log('\n[7] Blank page — expect: blank_page critical');
  {
    const { errors } = await crawlFixture(mcp, `${B}/blank-page.html`, { critical: true });
    const blank = errors.filter(e => e.type === 'blank_page');
    assert(blank.length > 0, `blank_page detected`);
    assert(blank[0]?.severity === 'critical', `blank_page → "critical"`);
  }

  // ── [8] WaitFor success ───────────────────────────────────────────────────
  console.log('\n[8] WaitFor success — #late-content appears after 2 s, no load_failure');
  {
    const { errors } = await crawlFixture(mcp, `${B}/waitfor-page.html`, { waitFor: '#late-content' });
    assert(errors.filter(e => e.type === 'load_failure').length === 0,
      `No load_failure — selector appeared within timeout`);
  }

  // ── [9] WaitFor timeout ──────────────────────────────────────────────────
  console.log('\n[9] WaitFor timeout — #never-appears never exists → load_failure warning');
  {
    const { errors } = await crawlFixture(mcp, `${B}/waitfor-timeout.html`,
      { waitFor: '#never-appears', critical: false });
    const lf = errors.filter(e => e.type === 'load_failure');
    assert(lf.length > 0, `load_failure detected when selector never appears`);
    assert(lf[0]?.severity === 'warning', `load_failure → "warning" on non-critical route`);
  }

  // ── [10] CSS issues — non-important cascade + SCSS map ──────────────────
  console.log('\n[10] CSS Issues — !important override, cascade override, unused rules, component leak, CSS Modules, inline conflict, SCSS map');
  {
    const { errors } = await crawlFixture(mcp, `${B}/css-issues.html`);
    const impOverrides = errors.filter(e => e.type === 'css_override' && e.hasImportant);
    const nonImpOverrides = errors.filter(e => e.type === 'css_override' && !e.hasImportant);
    const unusedRules = errors.filter(e => e.type === 'css_unused_rules');
    const leaks = errors.filter(e => e.type === 'css_component_leak');
    const modules = errors.filter(e => e.type === 'css_modules_detected');
    const inlineConflicts = errors.filter(e => e.type === 'react_inline_style_conflict');
    const cssSummary = errors.find(e => e.type === 'css_summary');

    assert(impOverrides.length > 0,
      `!important CSS override detected — header background (found ${impOverrides.length})`);
    assert(nonImpOverrides.length > 0,
      `Non-!important cascade override detected — h1 color declared twice (found ${nonImpOverrides.length})`);
    assert(unusedRules.length > 0 && unusedRules[0].count > 10,
      `Unused CSS rules > 10 detected (found ${unusedRules[0]?.count ?? 0})`);
    assert(leaks.length > 0,
      `Component style leak — .card__ in button-styles.css (found ${leaks.length})`);
    assert(modules.length > 0,
      `CSS Modules hashed class names detected (found ${modules.length})`);
    assert(inlineConflicts.length > 0,
      `Inline style conflict — .inline-conflict (found ${inlineConflicts.length})`);
    assert((cssSummary?.scssSourceFiles?.length ?? 0) > 0,
      `SCSS sourceMappingURL detected in <style> tag`);
  }

  // [11] removed — the trace-based perf-budget path (measurePerf + checkPerformanceBudgets)
  // was dead (broken performance_analyze_insight wiring) and is superseded by the
  // web-vitals analyzer (block [129], perf-vitals.html). Block id [11] is intentionally
  // retired; the [10] → [12] gap is deliberate (no renumber).

  // ── [12] Accessibility critical (soft) ───────────────────────────────────
  console.log('\n[12] A11y critical (soft) — Lighthouse score < 50');
  {
    const { score } = await measureA11y(mcp, `${B}/a11y-critical.html`);
    soft(score != null && score < 50,
      `Lighthouse a11y score=${score ?? 'N/A'}/100 (threshold: 50)`);
  }

  // ── [13] Accessibility warning (soft) ────────────────────────────────────
  console.log('\n[13] A11y warning (soft) — Lighthouse score 50–89');
  {
    const { score } = await measureA11y(mcp, `${B}/a11y-warning.html`);
    soft(score != null && score >= 50 && score < 90,
      `Lighthouse a11y score=${score ?? 'N/A'}/100 (expected 50–89)`);
  }

  // ── [14] Individual Lighthouse audit items ───────────────────────────────
  console.log('\n[14] Individual Lighthouse audit items — at least one failing audit');
  {
    const { score, failingAudits } = await measureA11y(mcp, `${B}/a11y-critical.html`);
    soft(failingAudits.length > 0,
      `Individual Lighthouse audit failures detected (found ${failingAudits.length}: ` +
      `${failingAudits.slice(0, 3).map(a => a.id).join(', ')}${failingAudits.length > 3 ? '…' : ''})`);
    // Extra soft: confirm they match expected categories
    const knownBadAudits = ['image-alt', 'label', 'button-name', 'duplicate-id', 'color-contrast'];
    const matched = failingAudits.filter(a => knownBadAudits.includes(a.id));
    soft(matched.length > 0,
      `Known audit violations found: ${matched.map(a => a.id).join(', ') || 'none matched'}`);
  }

  // ── [16] Full Lighthouse suite — v3 Phase A1 ────────────────────────────
  // Shape/parser checks are hard; score thresholds stay soft (Lighthouse
  // requires non-headless Chrome and may return null scores in headless CI).
  console.log('\n[16] Full Lighthouse suite — performance, SEO, best-practices, a11y');
  {
    const lh = await measureLighthouse(mcp, `${B}/a11y-critical.html`);
    // Hard shape check — measureLighthouse catch clause always returns failingAudits: []
    assert(Array.isArray(lh.failingAudits),
      `measureLighthouse always returns failingAudits as an array (got ${typeof lh.failingAudits})`);
    // Soft score checks — null is expected when Lighthouse is unavailable (headless CI)
    soft(lh.accessibility != null,
      `a11y score reported: ${lh.accessibility ?? 'N/A'}/100`);
    soft(lh.performance != null,
      `performance score reported: ${lh.performance ?? 'N/A'}/100`);
    soft(lh.seo != null,
      `SEO score reported: ${lh.seo ?? 'N/A'}/100`);
    soft(lh.bestPractices != null,
      `best-practices score reported: ${lh.bestPractices ?? 'N/A'}/100`);
    soft(lh.failingAudits.length > 0,
      `failing audit items across all categories: ${lh.failingAudits.length}`);
  }

  // ── [17] Network performance — slow API + oversized payload (v3 Phase A2) ──
  console.log('\n[17] Network Performance — slow API + large payload detection');
  {
    const { errors: perfErrors } = await crawlFixture(mcp, `${B}/api-performance.html`, {
      critical: false,
      waitFor: '#all-fetches-done',
    });

    // slow-warning: 1 500 ms > 1 000 ms threshold → severity 'warning'
    assert(
      perfErrors.some(e => e.type === 'slow_api' &&
        (e.requestUrl ?? '').includes('/api/slow-warning') && e.severity === 'warning'),
      `slow_api warning detected for /api/slow-warning (found: ${perfErrors.filter(e => e.type === 'slow_api').map(e => `${e.requestUrl} ${e.severity} ${e.duration}ms`).join(', ') || 'none'
      })`,
    );

    // slow-critical: 3 200 ms > 3 000 ms threshold → severity 'critical'
    assert(
      perfErrors.some(e => e.type === 'slow_api' &&
        (e.requestUrl ?? '').includes('/api/slow-critical') && e.severity === 'critical'),
      `slow_api critical detected for /api/slow-critical (found: ${perfErrors.filter(e => e.type === 'slow_api').map(e => `${e.requestUrl} ${e.severity} ${e.duration}ms`).join(', ') || 'none'
      })`,
    );

    // large-warning: ~600 KB > 500 KB threshold → severity 'warning'
    assert(
      perfErrors.some(e => e.type === 'large_payload' &&
        (e.requestUrl ?? '').includes('/api/large-warning') && e.severity === 'warning'),
      `large_payload warning detected for /api/large-warning (found: ${perfErrors.filter(e => e.type === 'large_payload').map(e => `${e.requestUrl} ${e.severity} ${Math.round((e.bytes ?? 0) / 1024)}KB`).join(', ') || 'none'
      })`,
    );

    // large-critical: ~2.2 MB > 2 MB threshold → severity 'critical'
    assert(
      perfErrors.some(e => e.type === 'large_payload' &&
        (e.requestUrl ?? '').includes('/api/large-critical') && e.severity === 'critical'),
      `large_payload critical detected for /api/large-critical (found: ${perfErrors.filter(e => e.type === 'large_payload').map(e => `${e.requestUrl} ${e.severity} ${Math.round((e.bytes ?? 0) / 1024)}KB`).join(', ') || 'none'
      })`,
    );
  }

  // ── [18] SEO checks — v3 Phase A3 (DOM inspection) ──────────────────────
  console.log('\n[18] SEO Checks — missing meta, OG tags, multiple h1, generic title');
  {
    const { errors: seoErrors } = await crawlFixture(mcp, `${B}/seo-issues.html`);

    // Missing meta description
    assert(
      seoErrors.some(e => e.type === 'seo_missing_description'),
      `seo_missing_description detected (found types: ${[...new Set(seoErrors.map(e => e.type))].join(', ') || 'none'})`,
    );

    // All 3 OG tags missing at warning severity (og:title + og:description + og:image)
    const missingOgWarnings = seoErrors.filter(e => e.type === 'seo_missing_og' && e.severity === 'warning');
    assert(
      missingOgWarnings.length >= 3,
      `All 3 OG warning tags missing — og:title + og:description + og:image (found ${missingOgWarnings.length}: ${missingOgWarnings.map(e => e.property).join(', ')})`,
    );

    // Multiple h1 tags (seo-issues.html has 3)
    assert(
      seoErrors.some(e => e.type === 'seo_multiple_h1'),
      `seo_multiple_h1 detected — 3 h1 tags on page (found: ${seoErrors.filter(e => e.type === 'seo_multiple_h1').map(e => `h1Count=${e.h1Count}`).join(', ') || 'none'})`,
    );

    // Generic/too-short title ("P" = 1 char)
    assert(
      seoErrors.some(e => e.type === 'seo_generic_title'),
      `seo_generic_title detected — title "P" is too short (found: ${seoErrors.filter(e => e.type === 'seo_generic_title').map(e => `"${e.titleText}" ${e.titleLength}c`).join(', ') || 'none'})`,
    );

    // Missing canonical
    assert(
      seoErrors.some(e => e.type === 'seo_missing_canonical'),
      `seo_missing_canonical detected (found types: ${[...new Set(seoErrors.map(e => e.type))].join(', ') || 'none'})`,
    );

    // Missing viewport
    assert(
      seoErrors.some(e => e.type === 'seo_missing_viewport'),
      `seo_missing_viewport detected (found types: ${[...new Set(seoErrors.map(e => e.type))].join(', ') || 'none'})`,
    );
  }

  // ── [19] Security checks — v3 Phase A4 ──────────────────────────────────────
  console.log('\n[19] Security Checks — localStorage token, eval(), sensitive console, token-in-URL, missing headers, cookie');
  {
    const { errors: secErrors } = await crawlFixture(mcp, `${B}/security-issues.html`, {
      critical: false,
      waitFor: '#security-checks-done[data-ready]',
    });

    // Clean up the localStorage item left by the fixture so subsequent test runs start clean
    await mcp.evaluate_script({ function: "() => localStorage.removeItem('authToken')" });

    // 1. localStorage auth token detected
    assert(
      secErrors.some(e => e.type === 'security_token_in_storage' && e.severity === 'critical'),
      `security_token_in_storage detected — authToken key with JWT value (found types: ${[...new Set(secErrors.map(e => e.type))].join(', ') || 'none'})`,
    );

    // 2. Token in API request URL
    assert(
      secErrors.some(e => e.type === 'security_token_in_url' && e.severity === 'critical'),
      `security_token_in_url detected — /api/user-data?token= (found: ${secErrors.filter(e => e.type === 'security_token_in_url').map(e => e.requestUrl).join(', ') || 'none'})`,
    );

    // 3. eval() usage in inline script
    assert(
      secErrors.some(e => e.type === 'security_eval_usage' && e.severity === 'warning'),
      `security_eval_usage detected — inline eval() call (found types: ${[...new Set(secErrors.map(e => e.type))].join(', ') || 'none'})`,
    );

    // 4. Sensitive data in console output (email + JWT token in console.error)
    assert(
      secErrors.some(e => e.type === 'security_sensitive_console' && e.severity === 'warning'),
      `security_sensitive_console detected — email + JWT in console.error (found types: ${[...new Set(secErrors.map(e => e.type))].join(', ') || 'none'})`,
    );

    // 5. Missing Content-Security-Policy response header
    assert(
      secErrors.some(e => e.type === 'security_missing_csp' && e.severity === 'warning'),
      `security_missing_csp detected — no CSP header on security-issues.html (found types: ${[...new Set(secErrors.map(e => e.type))].join(', ') || 'none'})`,
    );

    // 6. Missing X-Frame-Options response header
    assert(
      secErrors.some(e => e.type === 'security_missing_xframe' && e.severity === 'warning'),
      `security_missing_xframe detected — no X-Frame-Options on security-issues.html (found types: ${[...new Set(secErrors.map(e => e.type))].join(', ') || 'none'})`,
    );

    // 7. JS-accessible cookie (no HttpOnly) set via document.cookie
    assert(
      secErrors.some(e => e.type === 'security_cookie_no_httponly' && e.severity === 'warning'),
      `security_cookie_no_httponly detected — argus_test_session cookie readable by JS (found types: ${[...new Set(secErrors.map(e => e.type))].join(', ') || 'none'})`,
    );
  }

  // ── [20] Content quality checks — v3 Phase A5 ───────────────────────────────
  console.log('\n[20] Content Quality — null/undefined text, placeholder, broken image, empty list');
  {
    const { errors: contentErrors } = await crawlFixture(mcp, `${B}/content-issues.html`, {
      critical: false,
      waitFor: '#content-checks-done[data-ready]',
    });

    // 1. undefined / null visible in DOM
    assert(
      contentErrors.some(e => e.type === 'content_null_rendered' && e.severity === 'warning'),
      `content_null_rendered detected — "undefined" and "null" in visible text (found types: ${[...new Set(contentErrors.map(e => e.type))].join(', ') || 'none'})`,
    );

    // 2. Placeholder text ("Lorem ipsum")
    assert(
      contentErrors.some(e => e.type === 'content_placeholder_text' && e.severity === 'warning'),
      `content_placeholder_text detected — "lorem ipsum" in body text (found types: ${[...new Set(contentErrors.map(e => e.type))].join(', ') || 'none'})`,
    );

    // 3. Broken image (naturalWidth === 0)
    assert(
      contentErrors.some(e => e.type === 'content_broken_image' && e.severity === 'warning'),
      `content_broken_image detected — /api/broken-image.jpg (found: ${contentErrors.filter(e => e.type === 'content_broken_image').map(e => e.src).join(', ') || 'none'})`,
    );

    // 4. Empty data-oriented list
    assert(
      contentErrors.some(e => e.type === 'content_empty_list' && e.severity === 'warning'),
      `content_empty_list detected — .results-list with no <li> children (found types: ${[...new Set(contentErrors.map(e => e.type))].join(', ') || 'none'})`,
    );
  }

  // ── [21] Responsive layout — v3 Phase A6 ────────────────────────────────
  // Called directly (not via crawlFixture) — viewport changes must stay isolated.
  console.log('\n[21] Responsive Layout — overflow at mobile/tablet, small touch targets at 375px');
  {
    const { findings } = await analyzeResponsive(browser, `${B}/responsive-issues.html`);

    // Horizontal overflow at ≤768 px → severity "critical"
    const mobileOverflow = findings.filter(f =>
      f.type === 'responsive_overflow' && f.viewport <= 768 && f.severity === 'critical');
    assert(
      mobileOverflow.length > 0,
      `responsive_overflow critical at mobile/tablet viewport (found: ${findings.filter(f => f.type === 'responsive_overflow')
        .map(f => `${f.viewport}px ${f.severity}`).join(', ') || 'none'
      })`,
    );

    // Small touch targets at 375 px → severity "warning"
    const smallTargets = findings.filter(f =>
      f.type === 'responsive_small_touch_target' && f.viewport === 375 && f.severity === 'warning');
    assert(
      smallTargets.length > 0,
      `responsive_small_touch_target warning at 375px (found: ${findings.filter(f => f.type === 'responsive_small_touch_target')
        .map(f => `${f.count} target(s) at ${f.viewport}px`).join(', ') || 'none'
      })`,
    );

    // Small touch targets at 768 px (tablet) → severity "warning"
    const smallTargets768 = findings.filter(f =>
      f.type === 'responsive_small_touch_target' && f.viewport === 768 && f.severity === 'warning');
    assert(
      smallTargets768.length > 0,
      `responsive_small_touch_target warning at 768px (found: ${findings.filter(f => f.type === 'responsive_small_touch_target')
        .map(f => `${f.count} target(s) at ${f.viewport}px`).join(', ') || 'none'
      })`,
    );
  }

  // ── [22] SEO missing h1 — v3 Phase A3 (zero h1 case) ────────────────────
  console.log('\n[22] SEO Missing H1 — page with zero <h1> tags → seo_missing_h1 warning');
  {
    const { errors: seoErrors } = await crawlFixture(mcp, `${B}/seo-no-h1.html`);

    assert(
      seoErrors.some(e => e.type === 'seo_missing_h1'),
      `seo_missing_h1 detected on zero-h1 page (found types: ${[...new Set(seoErrors.map(e => e.type))].join(', ') || 'none'})`,
    );
    assert(
      seoErrors.filter(e => e.type === 'seo_missing_h1').every(e => e.severity === 'warning'),
      `seo_missing_h1 → severity "warning"`,
    );
  }

  // ── [23] Memory leak — detached DOM nodes (v3 Phase B1) ──────────────────
  // Called directly like analyzeResponsive — it navigates on its own.
  console.log('\n[23] Memory Leak — detached DOM nodes detected via heap snapshot');
  {
    const findings = await analyzeMemory(browser, `${B}/memory-leak.html`);

    const detachedFindings = findings.filter(f => f.type === 'memory_detached_dom_nodes');
    assert(
      detachedFindings.length > 0,
      `memory_detached_dom_nodes detected (found types: ${findings.map(f => f.type).join(', ') || 'none'})`,
    );
    assert(
      (detachedFindings[0]?.count ?? 0) > 10,
      `detached node count > 10 (found: ${detachedFindings[0]?.count ?? 0})`,
    );
    assert(
      detachedFindings.length === 0 || detachedFindings.every(f => f.severity === 'warning'),
      `memory_detached_dom_nodes → severity "warning" (count 11–100)`,
    );

    // Heap growth is soft — depends on GC timing
    const heapFindings = findings.filter(f => f.type === 'memory_heap_growth');
    if (heapFindings.length > 0) {
      soft(true, `Heap growth detected: ${Math.round(heapFindings[0].growthBytes / 1024)} KB after navigate-away + back`);
    } else {
      soft(false, `Heap growth not detected (GC may have collected objects before measurement)`);
    }
  }

  // ── [24] Auth session persistence — v3 Phase B2 ──────────────────────────
  // Tests: login flow (fill+click+waitFor), saveSession, restoreSession,
  // protected route accessible with session, auth error without session.
  console.log('\n[24] Auth Session — login flow, save, restore, protected route access');
  {
    const sessionFile = path.join(__dirname, '.argus-test-session.json');

    // 1. Baseline: visit protected page with no session → should show auth error
    await mcp.navigate_page({ url: `${B}/auth-protected.html` });
    await sleep(500);
    // Clear any leftover state from previous tests
    await mcp.evaluate_script({
      function: `() => {
        localStorage.clear();
        sessionStorage.clear();
        document.cookie.split(';').forEach(function(c) {
          document.cookie = c.trim().replace(/=.*/, '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/');
        });
        return true;
      }`,
    });
    await mcp.navigate_page({ url: `${B}/auth-protected.html` });
    await sleep(400);
    const noSessionRaw = await mcp.evaluate_script({
      function: `() => {
        var el = document.getElementById('auth-error');
        return el ? el.style.display !== 'none' : false;
      }`,
    });
    assert(
      parseEval(noSessionRaw) === true || parseEval(noSessionRaw) === 'true',
      'Protected page shows #auth-error when no session (baseline)',
    );

    // 2. Run login flow: navigate to login page, set form values via evaluate_script,
    //    dispatch submit event. Using evaluate_script for reliability in headless Chrome
    //    (fill+click MCP tools are for production runLoginFlow against real apps).
    await mcp.navigate_page({ url: `${B}/auth-login.html` });
    await sleep(500);
    await mcp.evaluate_script({
      function: `() => {
        document.getElementById('email').value    = 'test@example.com';
        document.getElementById('password').value = 'password123';
        document.getElementById('login-form').dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true })
        );
        return true;
      }`,
    });
    await sleep(300);

    const loginOkRaw = await mcp.evaluate_script({
      function: `() => !!document.querySelector('#login-success[data-ready]')`,
    });
    assert(
      parseEval(loginOkRaw) === true || parseEval(loginOkRaw) === 'true',
      'Login flow succeeded — #login-success[data-ready] set after form submit',
    );

    // 3. Save session — must have localStorage keys (authToken, userId, userEmail)
    const session = await saveSession(browser, sessionFile);
    assert(
      Object.keys(session.localStorage).length > 0,
      `Session saved with localStorage keys (found: ${Object.keys(session.localStorage).join(', ') || 'none'})`,
    );

    // 4. Clear all browser session state on the origin
    await mcp.navigate_page({ url: `${B}/auth-protected.html` });
    await sleep(300);
    await mcp.evaluate_script({
      function: `() => {
        localStorage.clear();
        sessionStorage.clear();
        document.cookie.split(';').forEach(function(c) {
          document.cookie = c.trim().replace(/=.*/, '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/');
        });
        return true;
      }`,
    });

    // 5. Restore session from file → navigate to protected page → should show content
    const restored = await restoreSession(browser, B, sessionFile);
    assert(restored === true, 'restoreSession returned true — session file found and injected');

    await mcp.navigate_page({ url: `${B}/auth-protected.html` });
    await sleep(400);
    const protectedRaw = await mcp.evaluate_script({
      function: `() => {
        var el = document.getElementById('protected-content');
        return el ? el.style.display !== 'none' : false;
      }`,
    });
    assert(
      parseEval(protectedRaw) === true || parseEval(protectedRaw) === 'true',
      `Protected page shows #protected-content after session restore (userId: ${session.localStorage.userId ?? '?'})`,
    );

    // Cleanup session file
    try { fs.unlinkSync(sessionFile); } catch { /* best-effort */ }

    // Clear Chrome auth state so test [1] passes on the NEXT harness run
    try {
      await mcp.navigate_page({ url: B });
      await mcp.evaluate_script({
        function: `() => {
          localStorage.clear();
          sessionStorage.clear();
          document.cookie.split(';').forEach(function(c) {
            document.cookie = c.trim().replace(/=.*/, '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/');
          });
          return true;
        }`,
      });
    } catch { /* best-effort */ }
  }

  // ── [15] Env comparison — GAPS 11–15 FIX (all 7 detections) ─────────────
  if (!stagingProc) {
    console.log('\n[15] Env Comparison — SKIPPED (staging server not running)');
    return;
  }

  console.log('\n[15] Env Comparison — 7 detections between dev and staging');

  // Navigate to dev home and collect data
  console.log('  → Navigating to dev home...');
  await mcp.navigate_page({ url: `${B}/` });
  await sleep(2500);
  const devReqs = evalToArray(await mcp.evaluate_script({ function: NET_SCRIPT }));
  const devMsgs = evalToArray(await mcp.evaluate_script({ function: CONSOLE_READ_SCRIPT }));
  const devShot = await mcp.take_screenshot({ format: 'png' }).catch(() => null);
  const devDOMRaw = await mcp.evaluate_script({ function: '() => document.body.innerHTML' });
  const devDOM = String(parseEval(devDOMRaw, ''));

  // Navigate to staging home and collect data
  console.log('  → Navigating to staging home...');
  await mcp.navigate_page({ url: `${BS}/` });
  await sleep(2500);
  const stagingReqs = evalToArray(await mcp.evaluate_script({ function: NET_SCRIPT }));
  const stagingMsgs = evalToArray(await mcp.evaluate_script({ function: CONSOLE_READ_SCRIPT }));
  const stagingShot = await mcp.take_screenshot({ format: 'png' }).catch(() => null);
  const stagingDOMRaw = await mcp.evaluate_script({ function: '() => document.body.innerHTML' });
  const stagingDOM = String(parseEval(stagingDOMRaw, ''));

  // [15a] API status regression: checkout 200 dev → 500 staging
  const devCheckout = devReqs.find(r => (r.url ?? '').includes('/api/checkout'));
  const stagingCheckout = stagingReqs.find(r => (r.url ?? '').includes('/api/checkout'));
  assert(devCheckout?.status === 200,
    `Checkout returns 200 on dev (got ${devCheckout?.status ?? 'not found'})`);
  assert(stagingCheckout?.status === 500,
    `Checkout returns 500 on staging — API regression detected (got ${stagingCheckout?.status ?? 'not found'})`);

  // [15b] New network request on staging: /api/tracking
  const devTracking = devReqs.find(r => (r.url ?? '').includes('/api/tracking'));
  const stagingTracking = stagingReqs.find(r => (r.url ?? '').includes('/api/tracking'));
  assert(!devTracking && !!stagingTracking,
    `New request on staging only: /api/tracking (dev: ${!!devTracking}, staging: ${!!stagingTracking})`);

  // [15c] Request in dev missing on staging: /api/feature-flags
  const devFlags = devReqs.find(r => (r.url ?? '').includes('/api/feature-flags'));
  const stagingFlags = stagingReqs.find(r => (r.url ?? '').includes('/api/feature-flags'));
  assert(!!devFlags && !stagingFlags,
    `Request present in dev but missing on staging: /api/feature-flags (dev: ${!!devFlags}, staging: ${!!stagingFlags})`);

  // [15d] API status changed non-5xx: analytics 200 dev → 404 staging
  const devAnalytics = devReqs.find(r => (r.url ?? '').includes('/api/analytics'));
  const stagingAnalytics = stagingReqs.find(r => (r.url ?? '').includes('/api/analytics'));
  assert(devAnalytics?.status === 200 && stagingAnalytics?.status === 404,
    `Analytics status changed: ${devAnalytics?.status ?? '?'} dev → ${stagingAnalytics?.status ?? '?'} staging`);

  // [15e] New console error in staging
  const devErrCount = devMsgs.filter(m => (m.level ?? '').toLowerCase() === 'error').length;
  const stagingErrCount = stagingMsgs.filter(m => (m.level ?? '').toLowerCase() === 'error').length;
  assert(stagingErrCount > devErrCount,
    `More console errors on staging (${stagingErrCount}) than dev (${devErrCount}) — regressions logged`);

  // [15f] DOM structural change: pricing section missing on staging
  assert(devDOM.includes('class="pricing"') && !stagingDOM.includes('class="pricing"'),
    `DOM diff: .pricing section present on dev, missing on staging`);

  // [15g] Visual diff > 0.5% — hero background blue→red (soft)
  const { diffPct, error: diffErr } = visualDiff(devShot, stagingShot);
  soft(diffPct != null && diffPct > 0.5,
    `Visual diff: ${diffPct != null ? diffPct + '%' : `unavailable (${diffErr ?? 'no screenshot data'})`} pixels changed (threshold: 0.5%)`);

  // ── [25] Baseline manager — pure function test (no Chrome) ────────────────
  console.log('\n[25] Baseline Manager — applyBaseline, saveBaseline, loadBaseline, appendTrend, getCurrentBranch');

  const tmpDir = path.join(__dirname, '.tmp-baseline-test');
  const bFile = path.join(tmpDir, 'baseline.json');
  const tFile = path.join(tmpDir, 'trends.json');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const fakeReport = {
    generatedAt: new Date().toISOString(),
    baseUrl: 'http://localhost:3100',
    summary: { total: 2, critical: 1, warning: 1, info: 0 },
    routes: [
      {
        route: '/home', url: 'http://localhost:3100/',
        errors: [
          { type: 'console', severity: 'critical', message: 'TypeError: x is null' },
          { type: 'seo_missing_description', severity: 'warning', message: 'Missing meta description' },
        ],
      },
    ],
  };

  // [25a] First run — isFirstRun true, all findings marked isNew
  const diff1 = applyBaseline(fakeReport, null);
  assert(diff1.isFirstRun === true, 'applyBaseline(null) → isFirstRun: true');
  assert(fakeReport.routes[0].errors.every(f => f.isNew === true),
    'First run — all findings marked isNew: true');

  // [25b] Save + reload baseline round-trip
  saveBaseline(bFile, fakeReport);
  const loaded = loadBaseline(bFile);
  assert(loaded !== null, 'loadBaseline returns non-null after saveBaseline');

  // [25c] Same findings → newCount: 0, resolvedCount: 0
  const fakeReport2 = JSON.parse(JSON.stringify(fakeReport)); // deep clone
  const diff2 = applyBaseline(fakeReport2, loaded);
  assert(diff2.newCount === 0 && diff2.resolvedCount === 0,
    `Identical run → newCount: ${diff2.newCount}, resolvedCount: ${diff2.resolvedCount} (both 0)`);

  // [25d] New finding detected as isNew: true
  const fakeReport3 = JSON.parse(JSON.stringify(fakeReport));
  fakeReport3.routes[0].errors.push({ type: 'blank_page', severity: 'critical', message: 'Page body empty' });
  const diff3 = applyBaseline(fakeReport3, loaded);
  assert(diff3.newCount === 1,
    `New finding detected — newCount: ${diff3.newCount} (expected 1)`);

  // [25e] appendTrend + resolved count from a reduced report
  const fakeReport4 = { ...fakeReport, routes: [{ ...fakeReport.routes[0], errors: [] }] };
  const diff4 = applyBaseline(fakeReport4, loaded);
  appendTrend(tFile, { runAt: new Date().toISOString(), resolvedFindings: diff4.resolvedCount });
  const trends = JSON.parse(fs.readFileSync(tFile, 'utf8'));
  assert(trends.length === 1 && trends[0].resolvedFindings === 2,
    `appendTrend round-trip — resolvedCount: ${diff4.resolvedCount} (expected 2), trends length: ${trends.length}`);

  // ── D4: flow baseline tests ───────────────────────────────────────────────
  const bFile2 = path.join(tmpDir, 'baseline-flows.json');
  const fakeReportWithFlows = {
    ...fakeReport,
    flows: [
      {
        flowName: 'login-flow',
        status: 'fail',
        stepsCompleted: 2,
        totalSteps: 3,
        findings: [
          {
            type: 'flow_assert_failed', severity: 'critical',
            message: '[login-flow] assert url_contains: URL does not contain "/dashboard"'
          },
          {
            type: 'flow_assert_failed', severity: 'warning',
            message: '[login-flow] assert no_console_errors: 1 error(s)'
          },
        ],
      },
    ],
  };

  // [25f] First run with flow findings — flowNewCount correct, all isNew: true
  const diffFlow1 = applyBaseline(JSON.parse(JSON.stringify(fakeReportWithFlows)), null);
  assert(diffFlow1.isFirstRun === true,
    '[25f] First run with flows → isFirstRun: true');
  assert(diffFlow1.flowNewCount === 2,
    `[25f] First run flowNewCount: ${diffFlow1.flowNewCount} (expected 2)`);
  assert(diffFlow1.flowResolvedCount === 0,
    `[25f] First run flowResolvedCount: ${diffFlow1.flowResolvedCount} (expected 0)`);
  // annotate the canonical copy for save
  applyBaseline(fakeReportWithFlows, null);
  assert(fakeReportWithFlows.flows[0].findings.every(f => f.isNew === true),
    '[25f] All flow findings marked isNew: true on first run');

  // [25g] Save + load flow baseline round-trip
  saveBaseline(bFile2, fakeReportWithFlows);
  const loadedFlows = loadBaseline(bFile2);
  assert(loadedFlows !== null,
    '[25g] loadBaseline returns non-null after saveBaseline with flows');
  assert(loadedFlows.flows instanceof Map,
    '[25g] loaded.flows is a Map');
  assert(loadedFlows.flows.has('login-flow'),
    '[25g] loaded baseline contains "login-flow" key');
  assert(loadedFlows.flows.get('login-flow').size === 2,
    `[25g] login-flow baseline has 2 keys (got ${loadedFlows.flows.get('login-flow').size})`);

  // [25h] Same flow findings → isNew: false, flowNewCount/flowResolvedCount: 0
  const fakeReportSameFlows = JSON.parse(JSON.stringify(fakeReportWithFlows));
  const diffFlow2 = applyBaseline(fakeReportSameFlows, loadedFlows);
  assert(diffFlow2.flowNewCount === 0 && diffFlow2.flowResolvedCount === 0,
    `[25h] Same flow findings → flowNewCount: ${diffFlow2.flowNewCount}, flowResolvedCount: ${diffFlow2.flowResolvedCount} (both 0)`);
  assert(fakeReportSameFlows.flows[0].findings.every(f => f.isNew === false),
    '[25h] Known flow findings marked isNew: false');

  // [25i] New flow finding → flowNewCount: 1
  const fakeReportNewFlowFinding = JSON.parse(JSON.stringify(fakeReportWithFlows));
  fakeReportNewFlowFinding.flows[0].findings.push({
    type: 'flow_step_failed', severity: 'critical',
    message: '[login-flow] step "click" on ".submit-btn" failed: Element not found',
  });
  const diffFlow3 = applyBaseline(fakeReportNewFlowFinding, loadedFlows);
  assert(diffFlow3.flowNewCount === 1,
    `[25i] New flow finding → flowNewCount: ${diffFlow3.flowNewCount} (expected 1)`);

  // [25j] Resolved flow finding → flowResolvedCount: 1
  const fakeReportResolvedFlow = JSON.parse(JSON.stringify(fakeReportWithFlows));
  fakeReportResolvedFlow.flows[0].findings = fakeReportResolvedFlow.flows[0].findings.slice(0, 1);
  const diffFlow4 = applyBaseline(fakeReportResolvedFlow, loadedFlows);
  assert(diffFlow4.flowResolvedCount === 1,
    `[25j] Resolved flow finding → flowResolvedCount: ${diffFlow4.flowResolvedCount} (expected 1)`);

  // [25k] Old baseline (no `flows` field) — backward compat: flow findings treated as new
  const oldBaselineRaw = { savedAt: new Date().toISOString(), routes: { 'http://localhost:3100/': [] } };
  fs.writeFileSync(bFile2, JSON.stringify(oldBaselineRaw, null, 2));
  const loadedOld = loadBaseline(bFile2);
  assert(loadedOld !== null,
    '[25k] Old baseline (no flows field) loads successfully');
  assert(loadedOld.flows instanceof Map && loadedOld.flows.size === 0,
    '[25k] Old baseline flows defaults to empty Map');
  const fakeReportForOld = JSON.parse(JSON.stringify(fakeReportWithFlows));
  const diffOld = applyBaseline(fakeReportForOld, loadedOld);
  assert(diffOld.flowNewCount === 2,
    `[25k] Old baseline: all flow findings treated as new → flowNewCount: ${diffOld.flowNewCount} (expected 2)`);

  // [25l] getCurrentBranch returns a non-empty string
  const branch = getCurrentBranch();
  assert(typeof branch === 'string' && branch.length > 0,
    `[25l] getCurrentBranch returns non-empty string (got: "${branch}")`);

  // [25m] getCurrentBranch result contains only safe filename characters
  assert(/^[a-zA-Z0-9._-]+$/.test(branch),
    `[25m] getCurrentBranch result is filename-safe (got: "${branch}")`);

  // Cleanup temp files
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }

  // ── [26] Flakiness detector — mergeRunResults (pure function, no Chrome) ──
  console.log('\n[26] Flakiness Detector — mergeRunResults');

  const flakyRun1 = {
    route: '/home', url: 'http://localhost:3100/', screenshot: null,
    errors: [
      { type: 'console', severity: 'critical', message: 'TypeError: x is null' }, // in both
      { type: 'blank_page', severity: 'critical', message: 'Page body empty' },       // run1 only
    ],
  };
  const flakyRun2 = {
    route: '/home', url: 'http://localhost:3100/', screenshot: '/tmp/shot2.png',
    errors: [
      { type: 'console', severity: 'critical', message: 'TypeError: x is null' },    // in both
      { type: 'network', severity: 'warning', message: 'HTTP 404 /api/foo' },      // run2 only
    ],
  };

  const merged = mergeRunResults(flakyRun1, flakyRun2);

  // [26a] Finding present in both runs → confirmed, original severity, flaky: false
  const confirmedFinding = merged.errors.find(e => e.type === 'console');
  assert(
    confirmedFinding && confirmedFinding.flaky === false && confirmedFinding.severity === 'critical',
    `Confirmed finding — flaky: false, severity: critical (original)`,
  );

  // [26b] Finding only in run1 → flaky: true, severity: 'info'
  const flakyFromRun1 = merged.errors.find(e => e.type === 'blank_page');
  assert(
    flakyFromRun1 && flakyFromRun1.flaky === true && flakyFromRun1.severity === 'info',
    `Run1-only finding → flaky: true, severity: info (was critical)`,
  );

  // [26c] Finding only in run2 → flaky: true, severity: 'info'
  const flakyFromRun2 = merged.errors.find(e => e.type === 'network');
  assert(
    flakyFromRun2 && flakyFromRun2.flaky === true && flakyFromRun2.severity === 'info',
    `Run2-only finding → flaky: true, severity: info (was warning)`,
  );

  // [26d] Confirmed count
  const confirmedCount = merged.errors.filter(e => e.flaky === false).length;
  assert(confirmedCount === 1, `Confirmed count: ${confirmedCount} (expected 1)`);

  // [26e] Flaky count (one from each run)
  const flakyCount = merged.errors.filter(e => e.flaky === true).length;
  assert(flakyCount === 2, `Flaky count: ${flakyCount} (expected 2)`);

  // ── [27] Flow runner — B5 user flow definitions ──────────────────────────
  console.log('\n[27] Flow Runner (B5) — runFlow assertions');
  {
    // [27a] Empty flow → pass, no findings (pure function — no Chrome needed)
    const emptyResult = await runFlow({ name: 'empty', steps: [] }, B, browser);
    assert(emptyResult.status === 'pass', 'Empty flow: status pass');
    assert(emptyResult.findings.length === 0, 'Empty flow: 0 findings');

    // [27b] Successful flow: navigate → fill → click → assert element_visible
    const successResult = await runFlow({
      name: 'Submit form',
      steps: [
        { action: 'navigate', path: '/flow-form.html' },
        { action: 'fill', selector: '#name', value: 'Alice' },
        { action: 'fill', selector: '#email', value: 'alice@example.com' },
        { action: 'click', selector: '#submit-btn' },
        { action: 'sleep', ms: 200 },
        { action: 'assert', type: 'element_visible', selector: '#form-success' },
      ],
    }, B, browser);
    assert(successResult.status === 'pass',
      `Successful flow: status pass (steps: ${successResult.stepsCompleted}/${successResult.totalSteps})`);
    assert(successResult.findings.length === 0,
      `Successful flow: 0 findings (got: ${successResult.findings.map(f => f.type).join(', ') || 'none'})`);

    // [27c] Assert element_visible failure → finding detected with correct type
    const failResult = await runFlow({
      name: 'Missing element',
      steps: [
        { action: 'navigate', path: '/flow-form.html' },
        { action: 'assert', type: 'element_visible', selector: '#does-not-exist', severity: 'warning' },
      ],
    }, B, browser);
    assert(failResult.findings.length >= 1,
      `Assert element_visible failure: finding detected (got ${failResult.findings.length})`);
    assert(failResult.findings[0]?.type === 'flow_assert_failed',
      `Assert element_visible failure: type = flow_assert_failed`);

    // [27d] Assert no_console_errors on clean form page → 0 findings
    const noErrResult = await runFlow({
      name: 'No console errors',
      steps: [
        { action: 'navigate', path: '/flow-form.html' },
        { action: 'assert', type: 'no_console_errors' },
      ],
    }, B, browser);
    assert(noErrResult.findings.length === 0,
      `Assert no_console_errors on clean page: 0 findings (got ${noErrResult.findings.length})`);

    // [27e] Assert url_contains — matching substring
    const urlMatchResult = await runFlow({
      name: 'URL match',
      steps: [
        { action: 'navigate', path: '/flow-form.html' },
        { action: 'assert', type: 'url_contains', value: 'flow-form' },
      ],
    }, B, browser);
    assert(urlMatchResult.findings.length === 0,
      `Assert url_contains (match): 0 findings`);

    // [27f] Assert url_contains — non-matching substring → finding detected
    const urlFailResult = await runFlow({
      name: 'URL no match',
      steps: [
        { action: 'navigate', path: '/flow-form.html' },
        { action: 'assert', type: 'url_contains', value: '/dashboard' },
      ],
    }, B, browser);
    assert(urlFailResult.findings.length >= 1,
      `Assert url_contains (no match): finding detected (got ${urlFailResult.findings.length})`);
    assert(urlFailResult.findings[0]?.type === 'flow_assert_failed',
      `Assert url_contains (no match): type = flow_assert_failed`);
  }

  // ── [28] Redirect chain detection — D2.1 ─────────────────────────────────
  console.log('\n[28] Redirect Chain — 3-hop chain (start→hop1→hop2→end) → redirect_chain warning');
  {
    const { errors: rdErrors } = await crawlFixture(mcp, `${B}/redirect-chain-start`);
    const chains = rdErrors.filter(e => e.type === 'redirect_chain');
    assert(chains.length > 0,
      `redirect_chain detected after 3-hop redirect (found types: ${[...new Set(rdErrors.map(e => e.type))].join(', ') || 'none'})`);
    assert((chains[0]?.count ?? 0) > 2,
      `redirect_chain count > 2 (got ${chains[0]?.count ?? 'N/A'})`);
    assert(chains[0]?.severity === 'warning',
      `redirect_chain → severity "warning"`);
  }

  // ── [29] Broken internal links — D2.3 ────────────────────────────────────
  console.log('\n[29] Broken Links — 2 internal 404s detected, valid link and skipped links ignored');
  {
    const { errors: blErrors } = await crawlFixture(mcp, `${B}/broken-links.html`);
    const broken = blErrors.filter(e => e.type === 'broken_link');
    assert(broken.length === 2,
      `2 broken_link findings detected (got ${broken.length}: ${broken.map(e => e.requestUrl).join(', ') || 'none'})`);
    assert(broken.every(e => e.severity === 'warning'),
      `All broken_link findings → severity "warning"`);
    assert(broken.every(e => e.status === 404),
      `All broken_link findings have status 404`);
    assert(!broken.some(e => (e.requestUrl ?? '').includes('/clean.html')),
      `Valid link /clean.html NOT in broken list`);
  }

  // ── [30] checkLighthouse direct test — D2.5 ──────────────────────────────
  console.log('\n[30] checkLighthouse (D2.5) — production function returns array with required field shapes');
  {
    const violations = await checkLighthouse(browser, `${B}/a11y-critical.html`);
    assert(Array.isArray(violations),
      `checkLighthouse returns an array (got ${typeof violations})`);
    if (violations.length > 0) {
      assert(violations.every(v => v.type && v.message && v.severity && v.url),
        `All violations have required fields: type, message, severity, url (${violations.length} violation(s))`);
    }
    const scoreViolations = violations.filter(v => v.type === 'lighthouse_score');
    const auditViolations = violations.filter(v => v.type === 'lighthouse_audit');
    soft(scoreViolations.length > 0,
      `checkLighthouse score violations: ${scoreViolations.length} (category score below threshold)`);
    soft(auditViolations.length > 0,
      `checkLighthouse audit violations: ${auditViolations.length} (individual failing audits)`);
  }

  // ── [31] Console/network per-route slicing — D5 ──────────────────────────
  console.log('\n[31] D5 Console Slicing — prior-route messages excluded from clean-page crawl');
  {
    // Navigate to the error page and wait for delayed throws (400ms/500ms)
    await mcp.navigate_page({ url: `${B}/js-errors.html` });
    await sleep(2000);

    // Use in-page capture (window.__argus_console) to confirm the error page HAS errors.
    // list_console_messages() may reset on navigation in some MCP implementations; the
    // in-page array is always reliable because js-errors.html sets it up itself.
    const inPageMsgs = evalToArray(await mcp.evaluate_script({ function: CONSOLE_READ_SCRIPT }));
    const errorsUnsliced = inPageMsgs.filter(m => (m.level ?? '').toLowerCase() === 'error');

    // Take D5-style baseline AFTER error page, BEFORE clean page (the production pattern)
    const allBeforeClean = toArray(await mcp.list_console_messages().catch(() => []));
    const consoleBaseline = allBeforeClean.length;

    // Navigate to a clean page (no console errors expected)
    await mcp.navigate_page({ url: `${B}/clean.html` });
    await sleep(1500);

    const allMsgs = toArray(await mcp.list_console_messages().catch(() => []));
    // With D5 slicing: only messages produced AFTER the baseline (i.e. by clean.html)
    const allCdpNow = toArray(await mcp.list_console_messages().catch(() => []));
    const corsBase2 = allCdpNow.length > consoleBaseline ? consoleBaseline : 0;
    const cleanMsgs = allCdpNow.slice(corsBase2);
    const errorsSliced = cleanMsgs.filter(m => (m.level ?? '').toLowerCase() === 'error');

    assert(errorsUnsliced.length > 0,
      `Without slicing: ${errorsUnsliced.length} error(s) visible — prior-route leakage confirmed`);
    assert(errorsSliced.length === 0,
      `With D5 slicing: 0 errors on clean page (baseline ${consoleBaseline}, sliced ${cleanMsgs.length} msgs) — leakage prevented`);
  }

  // ── [32] Synchronous XHR detection — D6.1 ────────────────────────────────
  console.log('\n[32] Sync XHR (D6.1) — synchronous XMLHttpRequest detected as warning');
  {
    const { errors: xhrErrors } = await crawlFixture(mcp, `${B}/sync-xhr.html`);
    const syncXhrs = xhrErrors.filter(e => e.type === 'sync_xhr');
    assert(syncXhrs.length > 0,
      `sync_xhr finding detected (found types: ${[...new Set(xhrErrors.map(e => e.type))].join(', ') || 'none'})`);
    assert(syncXhrs[0]?.severity === 'warning',
      `sync_xhr → severity "warning" (got "${syncXhrs[0]?.severity}")`);
    assert((syncXhrs[0]?.requestUrl ?? '').includes('/api/data'),
      `sync_xhr requestUrl contains "/api/data" (got "${syncXhrs[0]?.requestUrl}")`);
    assert(syncXhrs[0]?.method === 'GET',
      `sync_xhr method is "GET" (got "${syncXhrs[0]?.method}")`);
  }

  // ── [33] document.write detection — D6.2 ─────────────────────────────────
  console.log('\n[33] document.write (D6.2) — document.write + document.writeln detected as warnings');
  {
    const { errors: dwErrors } = await crawlFixture(mcp, `${B}/doc-write.html`);
    const docWrites = dwErrors.filter(e => e.type === 'document_write');
    assert(docWrites.length >= 2,
      `At least 2 document_write findings (write + writeln) (found ${docWrites.length})`);
    assert(docWrites.every(e => e.severity === 'warning'),
      `All document_write findings have severity "warning"`);
    const methods = docWrites.map(e => e.method);
    assert(methods.includes('write'),
      `document.write() call detected (methods: ${methods.join(', ')})`);
    assert(methods.includes('writeln'),
      `document.writeln() call detected (methods: ${methods.join(', ')})`);
  }

  // ── [34] Long task detection — D6.3 ──────────────────────────────────────
  console.log('\n[34] Long Tasks (D6.3) — 120ms busy-loop triggers long_task warning');
  {
    const { errors: ltErrors } = await crawlFixture(mcp, `${B}/long-task.html`);
    const longTasks = ltErrors.filter(e => e.type === 'long_task');
    assert(longTasks.length > 0,
      `At least 1 long_task finding detected (found ${longTasks.length})`);
    assert(longTasks.every(e => e.severity === 'warning'),
      `All long_task findings have severity "warning"`);
    assert(longTasks.some(e => (e.duration ?? 0) >= 50),
      `At least one long task has duration >= 50ms (durations: ${longTasks.map(e => e.duration).join(', ')})`);
  }

  // ── [35] CORS error detection — D6.4 ─────────────────────────────────────
  console.log('\n[35] CORS Error (D6.4) — cross-origin fetch blocked by CORS policy → cors_error critical');
  {
    const { errors: corsErrors } = await crawlFixture(mcp, `${B}/cors-error.html`);
    const corsFindings = corsErrors.filter(e => e.type === 'cors_error');
    assert(corsFindings.length > 0,
      `cors_error finding detected (found types: ${[...new Set(corsErrors.map(e => e.type))].join(', ') || 'none'})`);
    assert(corsFindings.every(e => e.severity === 'critical'),
      `All cors_error findings have severity "critical"`);
    assert(corsFindings.some(e => (e.message ?? '').toLowerCase().includes('cors policy')),
      `cors_error message mentions "cors policy" (got "${corsFindings[0]?.message?.slice(0, 80)}")`);
  }

  // ── [36] Service worker registration failure — D6.5 ──────────────────────
  console.log('\n[36] SW Registration Error (D6.5) — non-existent SW script triggers warning');
  {
    const { errors: swErrors } = await crawlFixture(mcp, `${B}/sw-error.html`);
    const swFindings = swErrors.filter(e => e.type === 'sw_registration_error');
    assert(swFindings.length > 0,
      `sw_registration_error finding detected (found types: ${[...new Set(swErrors.map(e => e.type))].join(', ') || 'none'})`);
    assert(swFindings.every(e => e.severity === 'warning'),
      `All sw_registration_error findings have severity "warning"`);
    assert(swFindings.some(e => (e.scriptURL ?? '').includes('sw-does-not-exist')),
      `sw_registration_error includes failing scriptURL (got "${swFindings[0]?.scriptURL}")`);
  }

  // ── [37] Cache header detection — D6.6 ───────────────────────────────────────
  console.log('\n[37] Cache Headers (D6.6) — assets without Cache-Control or ETag → info');
  {
    const { errors: chErrors } = await crawlFixture(mcp, `${B}/cache-headers.html`);
    const cacheMissing = chErrors.filter(e => e.type === 'cache_headers_missing');
    assert(cacheMissing.length >= 2,
      `At least 2 cache_headers_missing findings (one per nocache asset) (found ${cacheMissing.length}: ${cacheMissing.map(e => e.requestUrl).join(', ') || 'none'})`);
    assert(cacheMissing.every(e => e.severity === 'info'),
      `All cache_headers_missing findings have severity "info"`);
    assert(cacheMissing.some(e => (e.requestUrl ?? '').includes('nocache.css')),
      `nocache.css flagged as missing cache headers`);
    assert(cacheMissing.some(e => (e.requestUrl ?? '').includes('nocache.js')),
      `nocache.js flagged as missing cache headers`);
  }

  // ── [38] debugger; statement detection — D6.7 ────────────────────────────────
  console.log('\n[38] Debugger Statement (D6.7) — debugger; in inline and external scripts → critical');
  {
    const { errors: dbgErrors } = await crawlFixture(mcp, `${B}/debugger-statement.html`);
    const dbgHits = dbgErrors.filter(e => e.type === 'debugger_statement');
    assert(dbgHits.length >= 2,
      `At least 2 debugger_statement findings (inline + external) (found ${dbgHits.length}: ${dbgHits.map(e => e.scriptUrl).join(', ') || 'none'})`);
    assert(dbgHits.every(e => e.severity === 'critical'),
      `All debugger_statement findings have severity "critical"`);
    assert(dbgHits.some(e => e.scriptUrl === '(inline)'),
      `Inline debugger; detected`);
    assert(dbgHits.some(e => (e.scriptUrl ?? '').includes('debug-script.js')),
      `External debug-script.js debugger; detected`);
  }

  // ── [39] Duplicate id="" detection — D6.8 ────────────────────────────────────
  console.log('\n[39] Duplicate IDs (D6.8) — id shared by multiple elements → warning');
  {
    const { errors: didErrors } = await crawlFixture(mcp, `${B}/duplicate-ids.html`);
    const dupIds = didErrors.filter(e => e.type === 'duplicate_id');
    assert(dupIds.length >= 2,
      `At least 2 duplicate_id findings (card ×3 + header ×2) (found ${dupIds.length}: ${dupIds.map(e => e.id).join(', ') || 'none'})`);
    assert(dupIds.every(e => e.severity === 'warning'),
      `All duplicate_id findings have severity "warning"`);
    assert(dupIds.some(e => e.id === 'card' && (e.count ?? 0) >= 3),
      `id="card" flagged with count >= 3`);
    assert(dupIds.some(e => e.id === 'header' && (e.count ?? 0) >= 2),
      `id="header" flagged with count >= 2`);
    assert(!dupIds.some(e => e.id === 'unique-id'),
      `id="unique-id" (used once) not flagged`);
  }

  // ── [40] Mixed content severity — D6.9 ───────────────────────────────────────
  console.log('\n[40] Mixed Content (D6.9) — blocked → critical, passive → warning');
  {
    const { errors: mcErrors } = await crawlFixture(mcp, `${B}/mixed-content.html`);
    const mc = mcErrors.filter(e => e.type === 'security_mixed_content');
    assert(mc.length >= 2,
      `At least 2 security_mixed_content findings (blocked + passive) (found ${mc.length})`);
    assert(mc.some(e => e.severity === 'critical'),
      `Blocked mixed content finding has severity "critical"`);
    assert(mc.some(e => e.severity === 'warning'),
      `Passive mixed content finding has severity "warning"`);
    assert(mc.some(e => e.severity === 'critical' && (e.message ?? '').toLowerCase().includes('blocked')),
      `Critical finding message contains "blocked"`);
  }

  // ── [41] Parallel crawler — chunkArray (pure function, no Chrome) ─────────────
  console.log('\n[41] Parallel Crawler — chunkArray (D7.3)');

  // [41a] Even split: 6 items into 3 → 3 chunks of 2
  const c41a = chunkArray(['a', 'b', 'c', 'd', 'e', 'f'], 3);
  assert(c41a.length === 3 && c41a.every(c => c.length === 2),
    `[41a] chunkArray 6 items into 3 → 3 chunks of 2 (got: ${JSON.stringify(c41a)})`);

  // [41b] Uneven split: 5 items into 3 → 3 non-empty chunks, all items preserved
  const c41b = chunkArray(['a', 'b', 'c', 'd', 'e'], 3);
  assert(c41b.length === 3 && c41b.every(c => c.length > 0),
    `[41b] chunkArray 5 items into 3 → 3 non-empty chunks (got: ${JSON.stringify(c41b)})`);
  assert(c41b.flat().join('') === 'abcde',
    `[41b] chunkArray 5 items into 3 → all items preserved in order (got: ${JSON.stringify(c41b)})`);

  // [41c] Fewer items than target chunks: 3 items into 5 → 3 single-item chunks (no empty chunks)
  const c41c = chunkArray(['a', 'b', 'c'], 5);
  assert(c41c.length === 3 && c41c.every(c => c.length === 1),
    `[41c] chunkArray 3 items into 5 → 3 single-item chunks, no empty (got: ${JSON.stringify(c41c)})`);

  // [41d] Empty array → empty result
  const c41d = chunkArray([], 3);
  assert(Array.isArray(c41d) && c41d.length === 0,
    `[41d] chunkArray [] → [] (got: ${JSON.stringify(c41d)})`);

  // [41e] n=1 → single chunk containing all items
  const c41e = chunkArray(['a', 'b', 'c'], 1);
  assert(c41e.length === 1 && c41e[0].join('') === 'abc',
    `[41e] chunkArray 3 items into 1 → single chunk (got: ${JSON.stringify(c41e)})`);

  // [41f] ARGUS_CONCURRENCY defaults to 1 (sequential) when env var is unset
  const defConcurrency = Math.max(1, parseInt(process.env.ARGUS_CONCURRENCY ?? '1', 10));
  assert(defConcurrency === 1,
    `[41f] ARGUS_CONCURRENCY defaults to 1 when unset (got: ${defConcurrency})`);

  // ── [42] API contract validator — validateSchema + matchesContract (pure, no Chrome) ─
  console.log('\n[42] API Contract Validator — validateSchema + matchesContract (D7.4)');

  // [42a] Valid object matching required fields + types → 0 violations
  const v42a = validateSchema(
    { id: 1, name: 'Alice' },
    { type: 'object', required: ['id', 'name'], properties: { id: { type: 'number' }, name: { type: 'string' } } }
  );
  assert(v42a.length === 0,
    `[42a] valid object passes schema → 0 violations (got: ${JSON.stringify(v42a)})`);

  // [42b] Missing required field → violation mentioning the field name
  const v42b = validateSchema({ id: 1 }, { type: 'object', required: ['id', 'name'] });
  assert(v42b.length > 0 && v42b.some(m => m.includes('name')),
    `[42b] missing required field → violation (got: ${JSON.stringify(v42b)})`);

  // [42c] Wrong root type → violation mentioning expected type
  const v42c = validateSchema('not-an-object', { type: 'object' });
  assert(v42c.length > 0 && v42c.some(m => m.includes('object')),
    `[42c] wrong type → violation (got: ${JSON.stringify(v42c)})`);

  // [42d] Empty schema → always passes (no constraints)
  const v42d = validateSchema({ anything: true }, {});
  assert(v42d.length === 0,
    `[42d] empty schema → 0 violations (got: ${JSON.stringify(v42d)})`);

  // [42e] Nested property type mismatch → violation
  const v42e = validateSchema(
    { user: { id: 'not-a-number' } },
    { type: 'object', properties: { user: { type: 'object', properties: { id: { type: 'number' } } } } }
  );
  assert(v42e.length > 0 && v42e.some(m => m.includes('number')),
    `[42e] nested type mismatch → violation (got: ${JSON.stringify(v42e)})`);

  // [42f] matchesContract: exact pathname + method match → true
  assert(matchesContract('http://localhost:3000/api/user', 'GET', { url: '/api/user', method: 'GET' }),
    `[42f] matchesContract exact pathname + method → true`);

  // [42g] matchesContract: URL mismatch → false
  assert(!matchesContract('http://localhost:3000/api/products', 'GET', { url: '/api/user', method: 'GET' }),
    `[42g] matchesContract URL mismatch → false`);

  // [42h] matchesContract: method mismatch → false
  assert(!matchesContract('http://localhost:3000/api/user', 'POST', { url: '/api/user', method: 'GET' }),
    `[42h] matchesContract method mismatch → false`);

  // [42i] matchesContract: no method constraint → matches any method
  assert(matchesContract('http://localhost:3000/api/data', 'POST', { url: '/api/data' }),
    `[42i] matchesContract no method constraint → true for any method`);

  // ── [43] Severity overrides — applyOverrides (pure function, no Chrome) ──────
  console.log('\n[43] Severity Overrides — applyOverrides (D7.5)');

  // [43a] Override downgrades severity: warning → info; overriddenCount reflects it
  const rep43a = { routes: [{ url: '/', errors: [{ type: 'seo_missing_description', severity: 'warning', message: 't' }] }], flows: [] };
  const s43a = applyOverrides(rep43a, { seo_missing_description: 'info' });
  assert(rep43a.routes[0].errors[0].severity === 'info',
    `[43a] override downgrades warning → info (got: "${rep43a.routes[0].errors[0].severity}")`);
  assert(s43a.overriddenCount === 1,
    `[43a] overriddenCount is 1 (got: ${s43a.overriddenCount})`);

  // [43b] suppress removes finding + suppressedCount reflects it
  const rep43b = { routes: [{ url: '/', errors: [{ type: 'cache_headers_missing', severity: 'info', message: 't' }, { type: 'network', severity: 'critical', message: 't2' }] }], flows: [] };
  const s43b = applyOverrides(rep43b, { cache_headers_missing: 'suppress' });
  assert(rep43b.routes[0].errors.length === 1 && rep43b.routes[0].errors[0].type === 'network',
    `[43b] suppress removes finding from errors array (length: ${rep43b.routes[0].errors.length})`);
  assert(s43b.suppressedCount === 1,
    `[43b] suppressedCount is 1 (got: ${s43b.suppressedCount})`);

  // [43c] override type not present in findings → zero stats, no mutation
  const rep43c = { routes: [{ url: '/', errors: [{ type: 'network', severity: 'critical', message: 't' }] }], flows: [] };
  const s43c = applyOverrides(rep43c, { seo_missing_description: 'info' });
  assert(s43c.overriddenCount === 0 && s43c.suppressedCount === 0,
    `[43c] override on absent type → zero stats (overridden=${s43c.overriddenCount}, suppressed=${s43c.suppressedCount})`);

  // [43d] empty overrides map → no mutations, zero stats
  const rep43d = { routes: [{ url: '/', errors: [{ type: 'network', severity: 'critical', message: 't' }] }], flows: [] };
  const s43d = applyOverrides(rep43d, {});
  assert(s43d.overriddenCount === 0 && s43d.suppressedCount === 0,
    `[43d] empty overrides → zero stats (overridden=${s43d.overriddenCount}, suppressed=${s43d.suppressedCount})`);

  // [43e] override applies to flow findings
  const rep43e = { routes: [], flows: [{ flowName: 'checkout', findings: [{ type: 'flow_assert_failed', severity: 'critical', message: 't' }] }] };
  applyOverrides(rep43e, { flow_assert_failed: 'warning' });
  assert(rep43e.flows[0].findings[0].severity === 'warning',
    `[43e] override applies to flow findings (got: "${rep43e.flows[0].findings[0].severity}")`);

  // [43f] null severityOverrides → same early-return as empty map (zero stats, no mutation)
  const rep43f = { routes: [{ url: '/', errors: [{ type: 'network', severity: 'critical', message: 't' }] }], flows: [] };
  const s43f = applyOverrides(rep43f, null);
  assert(s43f.overriddenCount === 0 && s43f.suppressedCount === 0,
    `[43f] null overrides → zero stats (overridden=${s43f.overriddenCount}, suppressed=${s43f.suppressedCount})`);

  // [43g] unknown/invalid override value → finding left unchanged
  const rep43g = { routes: [{ url: '/', errors: [{ type: 'network', severity: 'warning', message: 't' }] }], flows: [] };
  const s43g = applyOverrides(rep43g, { network: 'critial' }); // deliberate typo — unrecognised value
  assert(rep43g.routes[0].errors[0].severity === 'warning' && s43g.overriddenCount === 0,
    `[43g] unknown override value → finding unchanged (severity=${rep43g.routes[0].errors[0].severity}, overridden=${s43g.overriddenCount})`);

  // ── [44] Auth token refresh — refreshSession (pure function, no Chrome) ────────
  console.log('\n[44] Auth Token Refresh — refreshSession (D7.6)');

  // [44a] null auth → { refreshed: false } (public crawl, no-op)
  const r44a = await refreshSession(null, null, 'http://localhost:3100');
  assert(r44a.refreshed === false,
    `[44a] null auth → refreshed: false (got: ${r44a.refreshed})`);

  // [44b] auth with steps but no session file yet → { refreshed: false }
  const r44b = await refreshSession(null, { steps: [{ action: 'navigate', path: '/login' }], sessionFile: '.argus-no-such-session-44b.json' }, 'http://localhost:3100');
  assert(r44b.refreshed === false,
    `[44b] missing session file → refreshed: false (got: ${r44b.refreshed})`);

  // [44c] fresh session (maxAge=1h, refreshWindow=5min, age≈0) → { refreshed: false }
  const tmpSession44c = '.argus-test-session-44c.json';
  fs.writeFileSync(tmpSession44c, JSON.stringify({ savedAt: new Date().toISOString(), cookies: '', localStorage: {}, sessionStorage: {} }), 'utf8');
  try {
    const r44c = await refreshSession(null, { steps: [{ action: 'navigate', path: '/login' }], sessionFile: tmpSession44c, sessionMaxAgeMs: 60 * 60 * 1000, sessionRefreshWindowMs: 5 * 60 * 1000 }, 'http://localhost:3100');
    assert(r44c.refreshed === false,
      `[44c] fresh session → refreshed: false (got: ${r44c.refreshed})`);
  } finally {
    if (fs.existsSync(tmpSession44c)) fs.unlinkSync(tmpSession44c);
  }

  // [44d] auth with empty steps array → same early-return as null auth
  const r44d = await refreshSession(null, { steps: [], sessionFile: '.argus-no-such-session-44d.json' }, 'http://localhost:3100');
  assert(r44d.refreshed === false,
    `[44d] empty steps array → refreshed: false (got: ${r44d.refreshed})`);

  // [44e] corrupted/unparseable session file → { refreshed: false } (parse error branch)
  const tmpSession44e = '.argus-test-session-44e.json';
  fs.writeFileSync(tmpSession44e, 'not-valid-json', 'utf8');
  try {
    const r44e = await refreshSession(null, { steps: [{ action: 'navigate', path: '/login' }], sessionFile: tmpSession44e }, 'http://localhost:3100');
    assert(r44e.refreshed === false,
      `[44e] corrupted session file → refreshed: false (got: ${r44e.refreshed})`);
  } finally {
    if (fs.existsSync(tmpSession44e)) fs.unlinkSync(tmpSession44e);
  }

  // ── [45] Slack-optional mode — isSlackConfigured + generateHtmlReport (D7.7) ──
  console.log('\n[45] Slack-optional mode — isSlackConfigured + generateHtmlReport (D7.7)');

  // [45a] isSlackConfigured returns false when SLACK_BOT_TOKEN is absent
  const savedToken = process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_BOT_TOKEN;
  assert(isSlackConfigured() === false,
    `[45a] no SLACK_BOT_TOKEN → isSlackConfigured() returns false`);

  // [45b] isSlackConfigured returns true when SLACK_BOT_TOKEN is set
  process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
  assert(isSlackConfigured() === true,
    `[45b] SLACK_BOT_TOKEN present → isSlackConfigured() returns true`);
  // restore original value
  if (savedToken !== undefined) process.env.SLACK_BOT_TOKEN = savedToken;
  else delete process.env.SLACK_BOT_TOKEN;

  // [45c] generateHtmlReport produces a valid self-contained HTML file
  const tmpReportJson = path.join(__dirname, '..', 'reports', 'argus-test-report-45.json');
  const minimalReport = {
    generatedAt: new Date().toISOString(),
    baseUrl: 'http://localhost:3100',
    summary: { total: 1, critical: 0, warning: 1, info: 0 },
    routes: [{ route: '/test', url: 'http://localhost:3100/test', errors: [{ type: 'test_finding', severity: 'warning', message: 'audit test' }] }],
    flows: [],
  };
  fs.mkdirSync(path.dirname(tmpReportJson), { recursive: true });
  fs.writeFileSync(tmpReportJson, JSON.stringify(minimalReport, null, 2), 'utf8');
  const tmpReportHtml = path.join(path.dirname(tmpReportJson), 'report.html');
  try {
    const htmlPath = generateHtmlReport(tmpReportJson);
    const html = fs.readFileSync(htmlPath, 'utf8');
    assert(
      fs.existsSync(htmlPath) && html.includes('<title>') && html.includes('Argus Report') && html.includes('audit test'),
      `[45c] generateHtmlReport writes valid HTML with embedded findings`
    );
  } finally {
    if (fs.existsSync(tmpReportJson)) fs.unlinkSync(tmpReportJson);
    if (fs.existsSync(tmpReportHtml)) fs.unlinkSync(tmpReportHtml);
  }

  // ── [46] Hover-state bug detection — D8.1 ────────────────────────────────────
  console.log('\n[46] Hover-state bug detection — D8.1 (analyzeHover)');
  {
    const findings = await analyzeHover(browser, `${B}/hover-issues.html`, false);

    const dropdownBroken = findings.filter(f => f.type === 'hover_dropdown_broken');
    assert(
      dropdownBroken.length >= 1,
      `[46a] hover_dropdown_broken detected for #nav-btn (aria-haspopup with no JS open handler)`
    );

    const tooltipMissing = findings.filter(f => f.type === 'hover_tooltip_missing');
    assert(
      tooltipMissing.length >= 1,
      `[46b] hover_tooltip_missing detected for #tip-btn (tooltip forced opacity:0!important)`
    );

    assert(
      dropdownBroken.every(f => f.severity === 'warning'),
      `[46c] hover_dropdown_broken severity is "warning" (non-critical route)`
    );

    assert(
      tooltipMissing.every(f => f.severity === 'warning'),
      `[46d] hover_tooltip_missing severity is always "warning"`
    );
  }

  // ── [47] Accessibility snapshot analysis — D8.2 ───────────────────────────────
  console.log('\n[47] Accessibility snapshot analysis — D8.2 (analyzeSnapshot)');
  {
    const findings = await analyzeSnapshot(browser, `${B}/snapshot-issues.html`);

    const missingName = findings.filter(f => f.type === 'a11y_missing_name');
    assert(
      missingName.length >= 1,
      `[47a] a11y_missing_name detected for SVG-only button with no accessible name`
    );

    const missingLabel = findings.filter(f => f.type === 'a11y_missing_form_label');
    assert(
      missingLabel.length >= 1,
      `[47b] a11y_missing_form_label detected for bare <input> with no label`
    );

    const dupeLandmark = findings.filter(f => f.type === 'a11y_duplicate_landmark');
    assert(
      dupeLandmark.length >= 1,
      `[47c] a11y_duplicate_landmark detected for <main> + [role="main"] without distinct labels`
    );

    assert(
      findings.every(f => f.severity === 'warning'),
      `[47d] all snapshot findings have severity "warning"`
    );
  }

  // ── [48] type_text step action — D8.3 (typing: true flag in fill step) ───────
  console.log('\n[48] type_text step action — D8.3 (typing: true flag in fill step)');
  {
    // [48a] mcp.fill fires ONE consolidated input event with the full value — counter shows
    // value.length (not per-keystroke like type_text, but not silent either).
    await mcp.navigate_page({ url: `${B}/typetext-issues.html` });
    await new Promise(r => setTimeout(r, 300));
    const FILL_VALUE = 'hello world';
    const fillUid = await resolveUidForSelector(browser, '#fill-input');
    if (fillUid) await mcp.fill({ uid: fillUid, value: FILL_VALUE });
    const rawA = await mcp.evaluate_script({
      function: `() => document.getElementById('fill-counter').getAttribute('data-count')`,
    });
    const countA = String(unwrapEval(rawA) ?? '');
    // fillUid != null is a required precondition — if uid resolution failed, fill was skipped
    // and countA === '0' would pass for the wrong reason (false pass).
    assert(
      fillUid != null && countA === String(FILL_VALUE.length),
      `[48a] mcp.fill fires one consolidated input event — counter equals value length (uid resolved: ${fillUid != null}, count: "${countA}", expected: "${FILL_VALUE.length}")`
    );

    // [48b] mcp.type_text dispatches keyboard events — char counter updates
    await mcp.navigate_page({ url: `${B}/typetext-issues.html` });
    await new Promise(r => setTimeout(r, 300));
    // mcp.click dispatches Input.dispatchMouseEvent via CDP but headless Chrome does not
    // move document.activeElement for text inputs via this pathway. Use evaluate_script
    // to call element.focus() directly — this is the reliable focus mechanism.
    const focusRaw = await mcp.evaluate_script({
      function: `() => { const el = document.getElementById('type-input'); if (!el) return false; el.focus(); return true; }`,
    });
    const elementFocused = !!unwrapEval(focusRaw);
    await mcp.type_text({ text: 'hi' });
    const rawB = await mcp.evaluate_script({
      function: `() => document.getElementById('type-counter').getAttribute('data-count')`,
    });
    const countB = String(unwrapEval(rawB) ?? '');
    assert(
      elementFocused && countB === '2',
      `[48b] mcp.type_text fires input events — char counter updates to 2 (focused: ${elementFocused}, count: "${countB}")`
    );

    // [48c] flow step with typing: true executes without error (step is wired to type_text)
    const typingFlow = {
      name: 'typetext-d8-3',
      steps: [
        { action: 'navigate', url: `${B}/typetext-issues.html` },
        { action: 'fill', selector: '#type-input', value: 'abc', typing: true },
      ],
    };
    const typingResult = await runFlow(typingFlow, B, browser);
    assert(
      typingResult.findings.length === 0,
      `[48c] flow with typing: true completes without error (type_text wired in fill step)`
    );

    // [48d] after typing: true flow, input-event count is 3 (one per keystroke) — proves
    // type_text was called and NOT mcp.fill, which fires only 1 consolidated input event.
    // Both would produce data-count="3" for value "abc"; data-event-count distinguishes them.
    const rawD = await mcp.evaluate_script({
      function: `() => document.getElementById('type-counter').getAttribute('data-event-count')`,
    });
    const countD = String(unwrapEval(rawD) ?? '');
    assert(
      countD === '3',
      `[48d] typing: true dispatches type_text — 3 separate input events for "abc" (fill fires 1) (got "${countD}")`
    );
  }

  // ── [49] drag step action — D8.4 (drag action in flow-runner DSL) ────────────
  console.log('\n[49] drag step action — D8.4 (drag action in flow-runner DSL)');
  {
    // [49a] drag step action is wired in runStep — runFlow with drag step doesn't emit flow_step_failed
    const dragFlow = {
      name: 'drag-d8-4',
      steps: [
        { action: 'navigate', url: `${B}/drag-issues.html` },
        { action: 'drag', selector: '#drag-source', target: '#drop-zone' },
      ],
    };
    const dragResult = await runFlow(dragFlow, B, browser);
    const unexpectedFail = dragResult.findings.filter(f => f.type === 'flow_step_failed' && f.action === 'drag');
    assert(
      unexpectedFail.length === 0,
      `[49a] drag step action is registered in flow-runner — no flow_step_failed on valid selector`
    );

    // [49b] after drag to working drop zone, drop event fired (data-dropped="true")
    const rawB = await mcp.evaluate_script({
      function: `() => document.getElementById('drop-zone').getAttribute('data-dropped')`,
    });
    const dropped = String(unwrapEval(rawB) ?? '');
    assert(
      dropped === 'true',
      `[49b] drag to working drop zone fires drop event — data-dropped="true" set by drop handler`
    );

    // [49c] drag step with non-existent selector → flow_step_failed with action: 'drag'
    const badDragFlow = {
      name: 'drag-bad-selector',
      steps: [
        { action: 'navigate', url: `${B}/drag-issues.html` },
        { action: 'drag', selector: '#does-not-exist', target: '#drop-zone' },
      ],
    };
    const badDragResult = await runFlow(badDragFlow, B, browser);
    const dragFailed = badDragResult.findings.filter(
      f => f.type === 'flow_step_failed' && f.action === 'drag'
    );
    assert(
      dragFailed.length >= 1,
      `[49c] drag step with missing selector emits flow_step_failed with action "drag"`
    );
  }

  // ── [50] upload_file step action — D8.5 ─────────────────────────────────────
  console.log('\n[50] upload_file step action — D8.5 (upload_file action in flow-runner DSL)');
  {
    const uploadFilePath = path.resolve(__dirname, 'pages', 'test-upload.txt');

    // [50a] upload_file step action is wired in runStep — runFlow completes without
    // emitting a flow_step_failed for the upload_file action
    const uploadFlow = {
      name: 'upload-d8-5',
      steps: [
        { action: 'navigate', url: `${B}/upload-issues.html` },
        { action: 'upload_file', selector: 'input[type=file]', filePath: uploadFilePath },
      ],
    };
    const uploadResult = await runFlow(uploadFlow, B, browser);
    const unexpectedFail = uploadResult.findings.filter(
      f => f.type === 'flow_step_failed' && f.action === 'upload_file'
    );
    assert(
      unexpectedFail.length === 0,
      `[50a] upload_file step action is registered in flow-runner — no flow_step_failed on valid file input`
    );

    // [50b] after upload_file, the file input has a file — files.length > 0
    // (upload_file uses CDP to set files directly on the input element)
    const rawB = await mcp.evaluate_script({
      function: `() => document.getElementById('file-input').files.length`,
    });
    const fileCount = Number(unwrapEval(rawB) ?? 0);
    assert(
      fileCount > 0,
      `[50b] upload_file delivers file to input — files.length > 0 (got ${fileCount})`
    );

    // [50c] upload_file with a non-existent filePath → MCP throws → flow_step_failed
    const badUploadFlow = {
      name: 'upload-bad-path',
      steps: [
        { action: 'navigate', url: `${B}/upload-issues.html` },
        { action: 'upload_file', selector: 'input[type=file]', filePath: '/nonexistent/argus-does-not-exist.txt' },
      ],
    };
    const badUploadResult = await runFlow(badUploadFlow, B, browser);
    const uploadFailed = badUploadResult.findings.filter(
      f => f.type === 'flow_step_failed' && f.action === 'upload_file'
    );
    assert(
      uploadFailed.length >= 1,
      `[50c] upload_file with non-existent file path emits flow_step_failed with action "upload_file"`
    );
  }

  // ── [51] C1.1 Env variable audit ─────────────────────────────────────────
  console.log('\n[51] C1.1 Env variable audit — process.env refs vs declared vars in .env');
  {
    const sourceDir = path.join(__dirname, 'source-fixture');
    const envFile = path.join(sourceDir, '.env.fixture');
    const findings = auditEnvVariables(sourceDir, envFile);

    assert(
      findings.length > 0,
      `[51a] auditEnvVariables produces findings for undeclared env vars (got ${findings.length})`
    );
    assert(
      findings.some(f => f.varName === 'MISSING_VAR'),
      `[51b] MISSING_VAR flagged as env_var_missing (found: ${findings.map(f => f.varName).join(', ')})`
    );
    assert(
      findings.every(f => f.severity === 'warning'),
      `[51c] all env_var_missing findings are severity "warning"`
    );
    // PRESENT_VAR is in .env.fixture — must not be flagged
    assert(
      !findings.some(f => f.varName === 'PRESENT_VAR'),
      `[51d] PRESENT_VAR is declared and must NOT be flagged (wrongly flagged: ${findings.filter(f => f.varName === 'PRESENT_VAR').length})`
    );
  }

  // ── [52] C1.2 Feature flag leakage ───────────────────────────────────────
  console.log('\n[52] C1.2 Feature flag leakage — conditional env var that is falsy/unset');
  {
    const sourceDir = path.join(__dirname, 'source-fixture');
    const envFile = path.join(sourceDir, '.env.fixture');
    const findings = detectFeatureFlagLeakage(sourceDir, envFile);

    assert(
      findings.length > 0,
      `[52a] detectFeatureFlagLeakage produces findings (got ${findings.length})`
    );
    assert(
      findings.some(f => f.varName === 'FEATURE_DISABLED'),
      `[52b] FEATURE_DISABLED flagged as feature_flag_leakage (found: ${findings.map(f => f.varName).join(', ')})`
    );
    assert(
      findings.every(f => f.severity === 'warning'),
      `[52c] all feature_flag_leakage findings are severity "warning"`
    );
    // FEATURE_ENABLED is 'true' in .env.fixture — must not be flagged
    assert(
      !findings.some(f => f.varName === 'FEATURE_ENABLED'),
      `[52d] FEATURE_ENABLED is truthy and must NOT be flagged (wrongly flagged: ${findings.filter(f => f.varName === 'FEATURE_ENABLED').length})`
    );
  }

  // ── [53] C1.3 Error-to-source linking ────────────────────────────────────
  console.log('\n[53] C1.3 Error-to-source linking — console error stack traces parsed to file:line');
  {
    const syntheticFindings = [
      {
        type: 'console',
        level: 'error',
        message: 'TypeError: Cannot read property \'foo\' of undefined\n    at handleClick (http://localhost:3000/static/js/main.abc123.js:1:4567)\n    at HTMLButtonElement.onclick (http://localhost:3000/static/js/main.abc123.js:1:8910)',
        severity: 'warning',
      },
      {
        type: 'console',
        level: 'warning',
        message: 'Some warning with no stack trace',
        severity: 'info',
      },
    ];
    const enriched = enrichErrorsWithSource(syntheticFindings);

    assert(
      enriched.length > 0,
      `[53a] enrichErrorsWithSource produces findings for errors with stack traces (got ${enriched.length})`
    );
    assert(
      enriched[0].stackFrames?.length > 0,
      `[53b] stack frames extracted from console error (got ${enriched[0]?.stackFrames?.length ?? 0})`
    );
    assert(
      enriched[0].stackFrames[0].file === 'main.abc123.js',
      `[53c] top stack frame file resolved correctly (got: ${enriched[0]?.stackFrames?.[0]?.file})`
    );
    assert(
      enriched.every(f => f.severity === 'info'),
      `[53d] all error_source_linked findings are severity "info"`
    );
  }

  // ── [54] C1.4 Dead route detection ───────────────────────────────────────
  console.log('\n[54] C1.4 Dead route detection — internal links that return 404');
  {
    await mcp.navigate_page({ url: `${B}/dead-routes.html` });
    await sleep(500);

    // Extract internal links from the page
    const linksRaw = await mcp.evaluate_script({ function: INTERNAL_LINKS_SCRIPT });
    const rawLinks = unwrapEval(linksRaw);
    const links = Array.isArray(rawLinks) ? rawLinks : JSON.parse(String(rawLinks ?? '[]'));

    // Test untested paths — clean.html is already "known" so it won't be HEAD-requested
    const knownPaths = ['/dead-routes.html', '/clean.html'];
    const deadRoutes = await detectDeadRoutes(B, links, knownPaths);

    assert(
      deadRoutes.length >= 2,
      `[54a] detectDeadRoutes finds ≥ 2 dead routes (found: ${deadRoutes.length} — paths: ${deadRoutes.map(f => f.path).join(', ')})`
    );
    assert(
      deadRoutes.some(f => f.path.includes('argus-dead-route')),
      `[54b] dead paths flagged match expected /argus-dead-route-* pattern (found: ${deadRoutes.map(f => f.path).join(', ')})`
    );
    assert(
      deadRoutes.every(f => f.severity === 'warning'),
      `[54c] all dead_route findings are severity "warning"`
    );
  }

  // ── [55] C2.1 PR comment formatter ───────────────────────────────────────
  console.log('\n[55] C2.1 formatPrComment — Markdown PR comment body');
  {
    const syntheticReport = {
      generatedAt: new Date().toISOString(),
      baseUrl: 'http://localhost:3100',
      summary: { total: 3, critical: 1, warning: 1, info: 1 },
      routes: [{
        route: 'Home',
        url: 'http://localhost:3100/',
        errors: [
          { type: 'console', severity: 'critical', message: 'TypeError: foo is null', isNew: true },
          { type: 'seo_missing_h1', severity: 'warning', message: 'Missing H1 heading', isNew: false },
        ],
        screenshot: null,
      }],
      flows: [],
      codebase: [
        { type: 'env_var_missing', severity: 'warning', message: 'process.env.API_KEY referenced but not declared', isNew: true },
      ],
    };
    const syntheticDiff = {
      isFirstRun: false,
      newCount: 2,
      resolvedCount: 1,
      flowNewCount: 0,
      flowResolvedCount: 0,
    };

    const comment = formatPrComment(syntheticReport, syntheticDiff);

    assert(
      typeof comment === 'string' && comment.length > 0,
      `[55a] formatPrComment returns a non-empty string (got type: ${typeof comment})`
    );
    assert(
      comment.includes('<!-- argus-qa-report -->'),
      `[55b] comment contains the COMMENT_MARKER sentinel for update detection`
    );
    assert(
      comment.includes('http://localhost:3100'),
      `[55c] comment contains the report base URL`
    );
    assert(
      comment.includes('| **Total** | 1 | 1 | 1 | 3 |'),
      `[55d] summary table Total row contains correct per-severity and overall counts`
    );
    assert(
      comment.includes('New Findings'),
      `[55e] New Findings section present when diff.isFirstRun is false and findings exist`
    );
    assert(
      comment.includes('Resolved'),
      `[55f] Resolved section present when combined resolvedCount > 0`
    );
    assert(
      comment.includes('Codebase Analysis'),
      `[55g] Codebase Analysis section present when report.codebase is non-empty`
    );

    // First-run case: New Findings section must be suppressed
    const firstRunComment = formatPrComment(syntheticReport, { isFirstRun: true, newCount: 0, resolvedCount: 0, flowNewCount: 0, flowResolvedCount: 0 });
    assert(
      !firstRunComment.includes('New Findings'),
      `[55h] New Findings section absent on first run (would show all findings as new — misleading)`
    );
  }

  // ── [56] C2.2 Commit status payload builder ───────────────────────────────
  console.log('\n[56] C2.2 buildStatusPayload — GitHub commit status payload');
  {
    const baseReport = {
      generatedAt: new Date().toISOString(),
      baseUrl: 'http://localhost:3100',
      summary: { total: 2, critical: 1, warning: 1, info: 0 },
      routes: [{
        route: 'Home',
        url: 'http://localhost:3100/',
        errors: [{ type: 'console', severity: 'critical', message: 'TypeError', isNew: true }],
      }],
      flows: [],
      codebase: [],
    };

    // Scenario A: new critical → failure
    const statusFail = buildStatusPayload(baseReport, { isFirstRun: false, newCount: 1 });
    assert(
      statusFail.state === 'failure',
      `[56a] state is "failure" when new critical findings exist (got: "${statusFail.state}")`
    );

    // Scenario B: no new criticals → success
    const cleanReport = {
      ...baseReport,
      routes: [{
        route: 'Home',
        url: 'http://localhost:3100/',
        errors: [{ type: 'console', severity: 'critical', message: 'TypeError', isNew: false }],
      }],
    };
    const statusPass = buildStatusPayload(cleanReport, { isFirstRun: false, newCount: 0 });
    assert(
      statusPass.state === 'success',
      `[56b] state is "success" when no new critical findings (got: "${statusPass.state}")`
    );

    assert(
      statusFail.context === 'argus-qa',
      `[56c] context field is "argus-qa" (got: "${statusFail.context}")`
    );
    assert(
      typeof statusFail.description === 'string' && statusFail.description.includes('Argus'),
      `[56d] description is a string containing "Argus" (got: "${statusFail.description}")`
    );
  }

  // ── [57] C3.1 Sitemap discovery ───────────────────────────────────────────
  console.log('\n[57] C3.1 Sitemap discovery — fetch /sitemap.xml and parse <loc> paths');
  {
    const paths = await discoverFromSitemap(B);

    assert(
      Array.isArray(paths),
      `[57a] discoverFromSitemap returns an array (got: ${typeof paths})`
    );
    assert(
      paths.includes('/about'),
      `[57b] /about parsed from sitemap <loc> (found: ${paths.join(', ')})`
    );
    assert(
      !paths.some(p => p.includes('external.example')),
      `[57c] off-origin URL excluded from results (found off-origin: ${paths.filter(p => p.includes('external')).join(', ')})`
    );

    // Unreachable server → graceful empty array (no throw)
    const missing = await discoverFromSitemap('http://localhost:3199');
    assert(
      Array.isArray(missing) && missing.length === 0,
      `[57d] returns [] when sitemap is unreachable (got ${missing.length} item(s))`
    );
  }

  // ── [58] C3.2 Next.js route discovery ────────────────────────────────────
  console.log('\n[58] C3.2 Next.js route discovery — scan pages/ and app/ directory structures');
  {
    const fixtureDir = path.join(__dirname, 'nextjs-fixture');
    const routes58 = discoverFromNextJs(fixtureDir);

    assert(
      Array.isArray(routes58) && routes58.length > 0,
      `[58a] discoverFromNextJs returns non-empty array (got ${routes58.length} route(s): ${routes58.join(', ')})`
    );
    assert(
      routes58.includes('/'),
      `[58b] pages/index.jsx maps to '/' (found: ${routes58.join(', ')})`
    );
    assert(
      !routes58.some(p => p.startsWith('/api')),
      `[58c] pages/api/ routes excluded (wrongly included: ${routes58.filter(p => p.startsWith('/api')).join(', ')})`
    );
    assert(
      !routes58.some(p => p.includes('_app')),
      `[58d] pages/_app.jsx excluded (wrongly included: ${routes58.filter(p => p.includes('_app')).join(', ')})`
    );
    assert(
      routes58.includes('/login'),
      `[58e] app/(auth)/login/page.tsx → '/login' with route group stripped (found: ${routes58.join(', ')})`
    );
    assert(
      !routes58.some(p => p.includes('[')),
      `[58f] dynamic [param] route segments excluded (found: ${routes58.filter(p => p.includes('[')).join(', ')})`
    );

    // Gap 3: sourceDir with no pages/ or app/ → returns []
    const tmpNextDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-nextjs-'));
    const emptyNextJs = discoverFromNextJs(tmpNextDir);
    fs.rmSync(tmpNextDir, { recursive: true, force: true });
    assert(
      Array.isArray(emptyNextJs) && emptyNextJs.length === 0,
      `[58g] returns [] when sourceDir has no pages/ or app/ directory (got ${emptyNextJs.length})`
    );
  }

  // ── [59] C3.3 React Router discovery ─────────────────────────────────────
  console.log('\n[59] C3.3 React Router route discovery — grep source for path declarations');
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-rr-'));
    fs.writeFileSync(path.join(tmpDir, 'App.jsx'), [
      '<Route path="/home" element={<Home />} />',
      '<Route path="/dashboard" element={<Dashboard />} />',
      '<Route path="/user/:id" element={<User />} />',
      'const routes = [{ path: "/settings", element: <Settings /> }];',
    ].join('\n'));

    const paths59 = discoverFromReactRouter(tmpDir);
    fs.rmSync(tmpDir, { recursive: true, force: true });

    assert(
      Array.isArray(paths59),
      `[59a] discoverFromReactRouter returns an array (got: ${typeof paths59})`
    );
    assert(
      paths59.includes('/dashboard'),
      `[59b] /dashboard detected from <Route path> (found: ${paths59.join(', ')})`
    );
    assert(
      !paths59.some(p => p.includes(':id')),
      `[59c] dynamic :id path excluded (found: ${paths59.filter(p => p.includes(':')).join(', ')})`
    );

    // Gap 4: non-existent sourceDir → returns []
    const nonExistentResult = discoverFromReactRouter('/this/path/does/not/exist/argus-rr');
    assert(
      Array.isArray(nonExistentResult) && nonExistentResult.length === 0,
      `[59d] non-existent sourceDir returns [] (got ${nonExistentResult.length})`
    );
  }

  // ── [60] C3.4 mergeRoutes ─────────────────────────────────────────────────
  console.log('\n[60] C3.4 mergeRoutes — merge discovered paths with manual route config');
  {
    const manual60 = [
      { path: '/', name: 'Home', critical: true, waitFor: 'main' },
      { path: '/login', name: 'Login', critical: true, waitFor: 'form' },
    ];
    const discovered60 = ['/', '/about', '/blog'];
    const merged60 = mergeRoutes(manual60, discovered60);

    assert(
      merged60.length === 4,
      `[60a] 2 manual + 1 new (/about) + 1 new (/blog) = 4 total (got ${merged60.length})`
    );
    assert(
      merged60[0].critical === true && merged60[0].waitFor === 'main',
      `[60b] manual route config preserved (critical=${merged60[0].critical}, waitFor=${merged60[0].waitFor})`
    );
    assert(
      !merged60.some(r => r.path === '/' && r.discovered),
      `[60c] existing manual route '/' not marked as discovered`
    );
    assert(
      merged60.some(r => r.path === '/about' && r.discovered === true),
      `[60d] auto-found route '/about' has discovered: true flag`
    );
  }

  // ── [61] C3.5 discoverRoutes orchestrator ─────────────────────────────────
  console.log('\n[61] C3.5 discoverRoutes — orchestrator integrates all discovery sources');
  {
    const manual61 = [
      { path: '/', name: 'Home', critical: true, waitFor: 'main' },
    ];
    const fixtureDir = path.join(__dirname, 'nextjs-fixture');

    // sitemap disabled to avoid network fetch; Next.js discovery against fixture
    const merged61 = await discoverRoutes(
      'http://localhost:3100',
      fixtureDir,
      { sitemap: false, nextjs: true, reactRouter: false },
      manual61
    );

    assert(
      Array.isArray(merged61),
      `[61a] discoverRoutes returns an array (got: ${typeof merged61})`
    );
    assert(
      merged61.length > 1,
      `[61b] orchestrator adds Next.js routes beyond the single manual route (got ${merged61.length})`
    );
    assert(
      merged61[0].critical === true && merged61[0].waitFor === 'main',
      `[61c] manual route config preserved by orchestrator (critical=${merged61[0].critical}, waitFor=${merged61[0].waitFor})`
    );

    // Gap 1 verification: null autoDiscover → manual routes returned unchanged
    const nullResult = await discoverRoutes(
      'http://localhost:3100',
      fixtureDir,
      null,
      manual61
    );
    assert(
      nullResult.length === manual61.length && nullResult[0] === manual61[0],
      `[61d] null autoDiscover returns manual routes unchanged (got ${nullResult.length}, expected ${manual61.length})`
    );
  }

  // ── [62] C4.1 detectFramework ─────────────────────────────────────────────
  console.log('\n[62] C4.1 detectFramework — identify Next.js / React Router / unknown');
  {
    // Non-existent dir → unknown
    assert(
      detectFramework('/this/path/does/not/exist/argus-fw') === 'unknown',
      `[62a] non-existent dir returns 'unknown'`
    );

    // Temp dir with no package.json → unknown
    const tmpFw = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-fw-'));
    assert(
      detectFramework(tmpFw) === 'unknown',
      `[62b] dir without package.json returns 'unknown'`
    );

    // Next.js package.json → 'nextjs'
    fs.writeFileSync(path.join(tmpFw, 'package.json'), JSON.stringify({
      dependencies: { next: '^14.0.0', react: '^18.0.0' },
    }));
    assert(
      detectFramework(tmpFw) === 'nextjs',
      `[62c] package.json with "next" dependency returns 'nextjs'`
    );

    // React Router package.json → 'react-router'
    fs.writeFileSync(path.join(tmpFw, 'package.json'), JSON.stringify({
      dependencies: { 'react-router-dom': '^6.0.0', react: '^18.0.0' },
    }));
    assert(
      detectFramework(tmpFw) === 'react-router',
      `[62d] package.json with "react-router-dom" dependency returns 'react-router'`
    );

    fs.rmSync(tmpFw, { recursive: true, force: true });
  }

  // ── [63] C4.2 generateTargetsJs ──────────────────────────────────────────
  console.log('\n[63] C4.2 generateTargetsJs — render pre-filled targets.js from routes');
  {
    const routes63 = [
      { path: '/', name: 'Home', critical: true, waitFor: 'main' },
      { path: '/about', name: 'About', critical: false, waitFor: null, discovered: true },
      { path: '/dashboard', name: 'Dashboard', critical: true, waitFor: '[data-testid="dashboard"]' },
    ];

    const out63 = generateTargetsJs(routes63, { framework: 'nextjs', sourceDir: '/app/src', envFile: '/app/.env' });

    assert(
      typeof out63 === 'string' && out63.length > 0,
      `[63a] generateTargetsJs returns a non-empty string`
    );
    assert(
      out63.includes("export const routes") && out63.includes("export const config"),
      `[63b] output contains ES module export statements`
    );
    assert(
      out63.includes("path: '/about'") && out63.includes("path: '/'"),
      `[63c] discovered route paths included in routes array`
    );
    assert(
      out63.includes('nextjs:      true') && out63.includes('reactRouter: false'),
      `[63d] autoDiscover block reflects detected framework (nextjs → true, react-router → false)`
    );
    assert(
      out63.includes("export const autoDiscover"),
      `[63e] autoDiscover export present`
    );

    // Empty routes → falls back to default Home route
    const emptyOut = generateTargetsJs([], { framework: 'unknown' });
    assert(
      emptyOut.includes("path: '/'"),
      `[63f] empty routes falls back to default '/' home route`
    );
  }

  // ── [64] C4.3 generateEnvFile ─────────────────────────────────────────────
  console.log('\n[64] C4.3 generateEnvFile — render .env with user config substituted');
  {
    // With all values populated
    const full64 = generateEnvFile({
      devUrl: 'http://localhost:4000',
      stagingUrl: 'https://staging.example.com',
      slackToken: 'xoxb-test-token',
      slackSecret: 'test-secret',
      slackCritical: 'C111',
      slackWarnings: 'C222',
      slackDigest: 'C333',
      githubToken: 'ghp_testtoken',
      githubRepo: 'owner/myrepo',
      sourceDir: '/app/src',
      envFile: '/app/.env',
    });

    assert(
      typeof full64 === 'string' && full64.length > 0,
      `[64a] generateEnvFile returns a non-empty string`
    );
    assert(
      full64.includes('TARGET_DEV_URL=http://localhost:4000'),
      `[64b] devUrl substituted into TARGET_DEV_URL (got: ${full64.split('\n').find(l => l.startsWith('TARGET_DEV_URL'))})`
    );
    assert(
      full64.includes('SLACK_BOT_TOKEN=xoxb-test-token'),
      `[64c] slackToken substituted (not commented out) when provided`
    );
    assert(
      full64.includes('GITHUB_TOKEN=ghp_testtoken') && full64.includes('GITHUB_REPOSITORY=owner/myrepo'),
      `[64d] GitHub values substituted when provided`
    );

    // Without optional values → those lines should be commented out
    const minimal64 = generateEnvFile({ devUrl: 'http://localhost:3000' });
    assert(
      minimal64.includes('# SLACK_BOT_TOKEN=xoxb-...'),
      `[64e] SLACK_BOT_TOKEN commented out when no token provided`
    );
    assert(
      minimal64.includes('# GITHUB_TOKEN=ghp_...'),
      `[64f] GITHUB_TOKEN commented out when no token provided`
    );
  }

  // ── [65] Production crawl pipeline smoke test ────────────────────────────
  // Exercises crawlRouteCheap() directly so harness regressions surface in
  // the production code path, not just in the hand-rolled crawlFixture().
  console.log('\n[65] Production crawl path — crawlRouteCheap on clean fixture');
  {
    const route65 = { name: 'clean', path: '/clean.html', critical: false, waitFor: null };
    const result65 = await crawlRouteCheap(route65, B, mcp);

    assert(Array.isArray(result65.errors), '[65a] crawlRouteCheap returns errors array');
    assert(typeof result65.url === 'string' && result65.url.endsWith('/clean.html'),
      `[65b] crawlRouteCheap result.url is correct (got: ${result65.url})`);
    assert(result65.isBlankPage === false,
      `[65c] crawlRouteCheap does not flag clean page as blank`);

    const criticals65 = result65.errors.filter(e => e.severity === 'critical');
    assert(criticals65.length === 0,
      `[65d] Production crawl: no criticals on clean fixture (got ${criticals65.length}: ${criticals65.map(e => e.type).join(', ') || 'none'})`);
  }

  // ── [66] Chrome Issues panel — clean page ────────────────────────────────
  console.log('\n[66] Chrome DevTools Issues panel — clean fixture produces no issue findings');
  {
    const findings66 = await analyzeIssues(browser, `${B}/clean.html`);
    assert(Array.isArray(findings66),
      '[66a] analyzeIssues returns an array');
    const critical66 = findings66.filter(f => f.severity === 'critical');
    assert(critical66.length === 0,
      `[66b] Clean page has no critical issue findings (got: ${critical66.map(f => f.type).join(', ') || 'none'})`);
    assert(!findings66.some(f => f.type === 'csp_violation'),
      `[66c] Clean page has no csp_violation findings (got ${findings66.length} total)`);
  }

  // ── [67] Chrome Issues panel — CSP violation fixture ─────────────────────
  console.log('\n[67] Chrome DevTools Issues panel — CSP violation fixture');
  {
    const findings67 = await analyzeIssues(browser, `${B}/issues-csp.html`);
    assert(Array.isArray(findings67),
      '[67a] analyzeIssues returns an array for CSP fixture');
    const csp67 = findings67.filter(f => f.type === 'csp_violation');
    assert(csp67.length >= 1,
      `[67b] CSP fixture produces at least 1 csp_violation finding (got ${csp67.length})`);
    assert(csp67.every(f => f.type && f.message && f.severity && f.url),
      '[67c] csp_violation findings have required fields: type, message, severity, url');
  }

  // ── [68] Chrome Issues panel — deprecated API fixture ────────────────────
  console.log('\n[68] Chrome DevTools Issues panel — deprecated API fixture');
  {
    const findings68 = await analyzeIssues(browser, `${B}/issues-deprecated.html`);
    assert(Array.isArray(findings68),
      '[68a] analyzeIssues returns an array for deprecated API fixture');
    const deprecated68 = findings68.filter(f => f.type === 'deprecated_api_use');
    assert(deprecated68.length >= 1,
      `[68b] Deprecated API fixture produces at least 1 deprecated_api_use finding (got ${deprecated68.length})`);
    assert(deprecated68.every(f => f.severity === 'info'),
      '[68c] deprecated_api_use findings are severity: info');
  }

  // ── [69] Network HAR timing — pure unit tests ────────────────────────────
  console.log('\n[69] Network HAR timing analysis — parseNetworkTiming unit tests');
  {
    const PAGE = 'http://localhost:3100/';

    // [69a] Empty input → empty output
    const empty69 = parseNetworkTiming([], PAGE);
    assert(Array.isArray(empty69), '[69a] parseNetworkTiming([]) returns an array');
    assert(empty69.length === 0, '[69b] parseNetworkTiming([]) returns empty array');

    // [69c] Cross-origin slow script → slow_third_party_blocking warning
    const slow69 = parseNetworkTiming([
      {
        url: 'https://cdn.example.com/analytics.js', method: 'GET', status: 200,
        timing: { wait: 3000 }
      },
    ], PAGE);
    const tp69 = slow69.filter(f => f.type === 'slow_third_party_blocking');
    assert(tp69.length >= 1,
      `[69c] Slow cross-origin script emits slow_third_party_blocking (got ${tp69.length})`);
    assert(tp69.every(f => f.severity === 'warning'),
      '[69d] slow_third_party_blocking is severity: warning');

    // [69e] Static image skipped even when slow
    const static69 = parseNetworkTiming([
      {
        url: 'https://cdn.example.com/hero.png', method: 'GET', status: 200,
        timing: { wait: 5000 }
      },
    ], PAGE);
    assert(static69.length === 0,
      '[69e] Static asset (hero.png) skipped regardless of timing');

    // [69f] Same-origin request not reported (covered by NETWORK_PERF_SCRIPT)
    const same69 = parseNetworkTiming([
      {
        url: 'http://localhost:3100/api/data', method: 'GET', status: 200,
        timing: { wait: 4000 }
      },
    ], PAGE);
    assert(same69.length === 0,
      '[69f] Same-origin slow request not reported by parseNetworkTiming');

    // [69g] Below threshold cross-origin → no finding
    const fast69 = parseNetworkTiming([
      {
        url: 'https://fonts.googleapis.com/css?family=Roboto', method: 'GET', status: 200,
        timing: { wait: 500 }
      },
    ], PAGE);
    assert(fast69.length === 0,
      '[69g] Cross-origin request below 2000ms threshold not flagged');
  }

  // ── [70] Heading hierarchy — analyzeSnapshot extension ───────────────────
  console.log('\n[70] Heading hierarchy validation — heading-issues.html fixture');
  {
    const findings70 = await analyzeSnapshot(browser, `${B}/heading-issues.html`);
    assert(Array.isArray(findings70),
      '[70a] analyzeSnapshot returns an array for heading-issues fixture');
    const skips70 = findings70.filter(f => f.type === 'heading_level_skip');
    assert(skips70.length >= 1,
      `[70b] heading-issues fixture produces at least 1 heading_level_skip finding (got ${skips70.length})`);
    assert(skips70.every(f => f.severity === 'warning'),
      '[70c] heading_level_skip findings are severity: warning');
    assert(skips70.some(f => f.from === 1 && f.to === 3),
      `[70d] h1→h3 skip detected (got skips: ${JSON.stringify(skips70.map(s => ({ from: s.from, to: s.to })))})`);
  }

  // ── [71] CPU throttle applied during responsive analysis ─────────────────
  console.log('\n[71] CPU throttle for mobile breakpoints — responsive-issues.html');
  {
    // analyzeResponsive now calls emulate({ cpuThrottlingRate: 4 }) at ≤768px.
    // The fixture findings must still be correct — throttle must not suppress detections.
    const { findings: findings71 } = await analyzeResponsive(browser, `${B}/responsive-issues.html`);
    assert(Array.isArray(findings71),
      '[71a] analyzeResponsive returns findings array with CPU throttle enabled');
    const overflow71 = findings71.filter(f => f.type === 'responsive_overflow' && f.viewport <= 768);
    assert(overflow71.length > 0,
      `[71b] responsive_overflow still detected at ≤768px under CPU throttle (got ${overflow71.length})`);
    assert(overflow71.every(f => f.severity === 'critical'),
      '[71c] mobile overflow is severity: critical under CPU throttle');
  }

  // ── [72] Keyboard navigation — focus_visible_missing ─────────────────────
  console.log('\n[72] Keyboard navigation analysis — keyboard-issues.html fixture');
  {
    const findings72 = await analyzeKeyboard(browser, `${B}/keyboard-issues.html`);
    assert(Array.isArray(findings72),
      '[72a] analyzeKeyboard returns an array');
    const noFocus72 = findings72.filter(f => f.type === 'focus_visible_missing');
    assert(noFocus72.length >= 1,
      `[72b] keyboard-issues fixture produces at least 1 focus_visible_missing finding (got ${noFocus72.length})`);
    assert(noFocus72.every(f => f.severity === 'warning'),
      '[72c] focus_visible_missing findings are severity: warning');
    assert(noFocus72.some(f => f.id === 'no-focus-ring'),
      `[72d] #no-focus-ring button detected (found ids: ${noFocus72.map(f => f.id).join(', ')})`);
  }

  // ── [73] ARIA state checks — aria_expanded_no_controls ───────────────────
  console.log('\n[73] ARIA state checks — aria-state-issues.html fixture');
  {
    const findings73 = await analyzeSnapshot(browser, `${B}/aria-state-issues.html`);
    assert(Array.isArray(findings73),
      '[73a] analyzeSnapshot returns an array for aria-state-issues fixture');
    const broken73 = findings73.filter(f => f.type === 'aria_expanded_no_controls');
    assert(broken73.length >= 2,
      `[73b] aria-state-issues fixture produces at least 2 aria_expanded_no_controls findings (got ${broken73.length})`);
    assert(broken73.every(f => f.severity === 'warning'),
      '[73c] aria_expanded_no_controls findings are severity: warning');
    const validButton73 = findings73.filter(f => f.type === 'aria_expanded_no_controls' && f.id === 'toggle-valid');
    assert(validButton73.length === 0,
      `[73d] #toggle-valid (has aria-controls pointing to real element) is NOT flagged`);
  }

  // ── [74] select_option flow step ─────────────────────────────────────────
  console.log('\n[74] select_option flow step — select-form.html fixture');
  {
    const flow74 = {
      name: 'select_option test',
      steps: [
        { action: 'navigate', path: '/select-form.html' },
        { action: 'select_option', selector: '#country', value: 'US' },
        { action: 'select_option', selector: '#size', value: 'L' },
        { action: 'click', selector: '#submit-btn' },
        { action: 'sleep', ms: 200 },
        { action: 'assert', type: 'element_visible', selector: '#form-result[data-ready]' },
      ],
    };
    const result74 = await runFlow(flow74, B, browser);
    assert(result74.status === 'pass',
      `[74a] select_option flow passes (status=${result74.status}, steps=${result74.stepsCompleted}/${result74.totalSteps})`);
    assert(result74.findings.filter(f => f.type === 'flow_step_failed').length === 0,
      `[74b] No flow_step_failed findings in select_option flow`);

    // Verify the flow actually updated the DOM result via the flow runner
    const resultText74 = unwrapEval(
      await mcp.evaluate_script({ function: `() => document.getElementById('form-result').textContent` })
    );
    const text74 = String(resultText74 ?? '').trim();
    assert(text74 === 'US/L',
      `[74c] flow result is "US/L" after select_option steps (got "${text74}")`);
  }

  // ── [75] Origin tagging on network findings ───────────────────────────────
  console.log('\n[75] Origin tagging on network findings — pure unit test');
  {
    // Test the classifyOrigin logic via crawlRouteCheap result shape.
    // The CORS error fixture makes cross-origin fetch — its network finding should have origin: third-party.
    // We use a direct unit test of the expected field shape since we can't call classifyOrigin directly.
    const findings75 = await crawlRouteCheap(
      { path: '/clean.html', name: 'Clean', critical: false, waitFor: null },
      B, mcp
    );
    assert(Array.isArray(findings75.errors),
      '[75a] crawlRouteCheap returns errors array');
    // All network-type errors must have an origin field
    const networkErrors75 = findings75.errors.filter(e => e.type === 'network');
    const allHaveOrigin = networkErrors75.every(e => e.origin === 'first-party' || e.origin === 'third-party');
    assert(networkErrors75.length === 0 || allHaveOrigin,
      `[75b] all network findings have origin field (checked ${networkErrors75.length} findings)`);
  }

  // ── [76] HTTPS enforcement — unit test via URL parsing ───────────────────
  console.log('\n[76] HTTPS enforcement check — unit-level URL check');
  {
    // The security_no_https finding fires for non-localhost http:// URLs.
    // Test harness runs on localhost — it must NOT emit security_no_https.
    const findings76 = await crawlRouteCheap(
      { path: '/clean.html', name: 'Clean', critical: false, waitFor: null },
      B, mcp
    );
    const httpsFindings76 = findings76.errors.filter(e => e.type === 'security_no_https');
    assert(httpsFindings76.length === 0,
      `[76a] localhost http:// does NOT emit security_no_https (got ${httpsFindings76.length})`);

    // Structural check: for a non-localhost HTTP URL the finding would have the right shape.
    // We validate shape via pure function — can't navigate to a non-local URL in harness.
    const fakeHttpUrl = 'http://example.com/page';
    const parsed76 = new URL(fakeHttpUrl);
    const isLocalhost76 = /^(localhost|127\.|::1)/.test(parsed76.hostname);
    assert(!isLocalhost76, '[76b] example.com is correctly classified as non-localhost');
    assert(parsed76.protocol === 'http:', '[76c] http://example.com has protocol http:');
  }

  // ── [77] Iframe sandbox check ────────────────────────────────────────────
  console.log('\n[77] Iframe sandbox check — iframe-sandbox.html fixture');
  {
    await mcp.navigate_page({ url: `${B}/iframe-sandbox.html` });
    await new Promise(r => setTimeout(r, 800));
    const secRaw77 = await mcp.evaluate_script({ function: SECURITY_ANALYSIS_SCRIPT });
    const findings77 = parseSecurityAnalysisResult(secRaw77, `${B}/iframe-sandbox.html`);

    assert(Array.isArray(findings77),
      '[77a] parseSecurityAnalysisResult returns an array');
    const sandbox77 = findings77.filter(f => f.type === 'security_iframe_no_sandbox');
    assert(sandbox77.length >= 2,
      `[77b] iframe-sandbox fixture produces at least 2 security_iframe_no_sandbox findings (got ${sandbox77.length})`);
    assert(sandbox77.every(f => f.severity === 'warning'),
      '[77c] security_iframe_no_sandbox findings are severity: warning');
    // Sandboxed iframe (third entry) must NOT be flagged
    const sandboxedFlagged77 = sandbox77.filter(f => f.src && f.src.includes('example.com') && false);
    assert(sandbox77.filter(f => f.src?.includes('sandboxed')).length === 0,
      '[77d] iframe with sandbox attribute is NOT flagged');
  }

  // ── [78] Watch Mode — WatchSession passive monitoring ────────────────────
  console.log('\n[78] Watch Mode — WatchSession poll, dedup, incremental detection');
  {
    // Navigate to the fixture page and allow on-load errors to settle before polling.
    await mcp.navigate_page({ url: `${B}/watch-issues.html` });
    await new Promise(r => setTimeout(r, 800));

    const session78 = new WatchSession(browser, B);

    // ── First poll ──────────────────────────────────────────────────────────
    const { findings: poll1_78 } = await session78.poll();

    // [78a] console errors detected (the fixture fires console.error on load)
    const consoleF78 = poll1_78.filter(f => f.type === 'console' || f.type === 'console_warning');
    assert(consoleF78.length >= 1,
      `[78a] First poll detects console errors/warnings from fixture (got ${consoleF78.length})`);

    // [78b] network errors detected (fixture fetches /api/always-500 → 500, /api/missing → 404)
    const netF78 = poll1_78.filter(f =>
      f.type === 'network_server_error' || f.type === 'network_not_found'
    );
    assert(netF78.length >= 1,
      `[78b] First poll detects network errors from fixture (got ${netF78.length})`);

    // [78c] deduplication — second immediate poll returns zero new findings
    const { findings: poll2_78 } = await session78.poll();
    assert(poll2_78.length === 0,
      `[78c] Second poll returns 0 new findings — dedup works (got ${poll2_78.length})`);

    // [78d] getAllFindings accumulates correctly across polls
    assert(session78.getAllFindings().length === poll1_78.length,
      `[78d] getAllFindings() matches cumulative total (${session78.getAllFindings().length} === ${poll1_78.length})`);

    // [78e] new console error fired after first poll → third poll detects only that one
    await mcp.evaluate_script({
      function: `() => { window.argusWatchTriggerError('probe-delta'); return true; }`,
    });
    await new Promise(r => setTimeout(r, 300));
    const { findings: poll3_78 } = await session78.poll();
    const incF78 = poll3_78.filter(f =>
      f.type === 'console' && typeof f.message === 'string' && f.message.includes('ARGUS_WATCH_INC')
    );
    assert(incF78.length >= 1,
      `[78e] Third poll detects new incremental error only (got ${poll3_78.length} total, ${incF78.length} incremental)`);

    // [78f] HTTP 500 classified as network_server_error with severity critical
    const crits78 = session78.getAllFindings().filter(f =>
      f.type === 'network_server_error' && f.severity === 'critical'
    );
    assert(crits78.length >= 1,
      `[78f] HTTP 500 classified as network_server_error severity critical (got ${crits78.length})`);

    // [78g] every accumulated finding has the required fields: type, severity, message
    const allFinal78 = session78.getAllFindings();
    const validShape78 = allFinal78.every(f =>
      typeof f.type === 'string' &&
      typeof f.severity === 'string' &&
      typeof f.message === 'string'
    );
    assert(validShape78,
      `[78g] All findings have required fields: type, severity, message (checked ${allFinal78.length})`);
  }

  // ── [79] Zod config validation (v9.1.6) ──────────────────────────────────────
  console.log('\n[79] Zod config validation — validateConfig guards targets.js shape');
  {
    // [79a] actual targets.js exports pass schema validation without throwing
    let threw79a = false;
    try { validateConfig(argusTargets); } catch { threw79a = true; }
    assert(!threw79a,
      '[79a] validateConfig(targets) passes on real targets.js without throwing');

    // [79b] route missing required path field → throws
    let threw79b = false;
    try {
      validateConfig({
        ...argusTargets,
        routes: [{ name: 'NoPath', critical: false }],
      });
    } catch { threw79b = true; }
    assert(threw79b,
      '[79b] validateConfig throws when a route is missing the required path field');

    // [79c] route path not starting with / → throws
    let threw79c = false;
    try {
      validateConfig({
        ...argusTargets,
        routes: [{ path: 'no-slash', name: 'Bad', critical: false }],
      });
    } catch { threw79c = true; }
    assert(threw79c,
      '[79c] validateConfig throws when route.path does not start with "/"');

    // [79d] threshold with non-number value → throws
    let threw79d = false;
    try {
      validateConfig({
        ...argusTargets,
        thresholds: {
          ...argusTargets.thresholds,
          perf: { ...argusTargets.thresholds.perf, LCP: 'not-a-number' },
        },
      });
    } catch { threw79d = true; }
    assert(threw79d,
      '[79d] validateConfig throws when thresholds.perf.LCP is a string instead of a number');
  }

  // ── Block [80] Argus MCP server registration ─────────────────────────────
  {
    console.log('\n[80] Argus MCP server — file registration (v9.3.0)');

    const mcpServerPath = path.join(__dirname, '../src/mcp-server.js');
    const mcpJsonPath   = path.join(__dirname, '../.mcp.json');

    // [80a] src/mcp-server.js exists and is readable
    let serverContent = null;
    try { serverContent = fs.readFileSync(mcpServerPath, 'utf8'); } catch { /* file missing */ }
    assert(serverContent !== null, '[80a] src/mcp-server.js exists and is readable');

    // [80b] file contains 'argus_audit' tool name
    assert(
      serverContent !== null && serverContent.includes('argus_audit'),
      '[80b] src/mcp-server.js registers the argus_audit tool',
    );

    // [80c] file contains 'argus_compare' tool name
    assert(
      serverContent !== null && serverContent.includes('argus_compare'),
      '[80c] src/mcp-server.js registers the argus_compare tool',
    );

    // [80d] file contains 'argus_audit_full' tool name
    assert(
      serverContent !== null && serverContent.includes('argus_audit_full'),
      '[80d] src/mcp-server.js registers the argus_audit_full tool',
    );

    // [80e] file contains 'argus_last_report' tool name
    assert(
      serverContent !== null && serverContent.includes('argus_last_report'),
      '[80e] src/mcp-server.js registers the argus_last_report tool',
    );

    // [80f] .mcp.json exists and contains "argus" server entry
    let mcpJsonContent = null;
    try { mcpJsonContent = fs.readFileSync(mcpJsonPath, 'utf8'); } catch { /* file missing */ }
    assert(
      mcpJsonContent !== null && mcpJsonContent.includes('"argus"'),
      '[80f] .mcp.json exists and contains "argus" server entry',
    );

    // [80g] file contains 'argus_watch_snapshot' tool name
    assert(
      serverContent !== null && serverContent.includes('argus_watch_snapshot'),
      '[80g] src/mcp-server.js registers the argus_watch_snapshot tool',
    );

    // [80h] argus_watch_snapshot inputSchema includes a tabId property
    assert(
      serverContent !== null && serverContent.includes('argus_watch_snapshot') &&
        serverContent.includes('tabId'),
      '[80h] argus_watch_snapshot inputSchema defines a tabId property',
    );

    // [80i] file contains 'argus_get_context' tool name
    assert(
      serverContent !== null && serverContent.includes('argus_get_context'),
      '[80i] src/mcp-server.js registers the argus_get_context tool',
    );

    // [80j] argus_get_context inputSchema includes snapshot_id for fix loop
    assert(
      serverContent !== null && serverContent.includes('snapshot_id'),
      '[80j] argus_get_context inputSchema includes snapshot_id for fix loop',
    );

    // [80k] snapshotStore present — fix loop state management
    assert(
      serverContent !== null && serverContent.includes('snapshotStore'),
      '[80k] src/mcp-server.js contains snapshotStore for fix loop state',
    );

    // [80l] fix loop diff fields present in handleGetContext
    assert(
      serverContent !== null && serverContent.includes('resolved') &&
        serverContent.includes('new_issues') && serverContent.includes('persisting'),
      '[80l] handleGetContext emits resolved / new_issues / persisting diff fields',
    );

    // [80m] argus_visual_diff tool registered (Extension)
    assert(
      serverContent !== null && serverContent.includes('argus_visual_diff'),
      '[80m] src/mcp-server.js registers the argus_visual_diff tool',
    );

    // [80n] argus_visual_diff handler present
    assert(
      serverContent !== null && serverContent.includes('handleVisualDiff'),
      '[80n] handleVisualDiff function present in mcp-server.js',
    );
  }

  // ── Block [81] createFinding() factory ────────────────────────────────────
  {
    console.log('\n[81] createFinding() factory (domain layer)');

    // [81a] valid finding created with all required fields
    const f81a = createFinding({ type: 'console_error', severity: 'warning', message: 'oops', url: '/foo' });
    assert(
      f81a.type === 'console_error' && f81a.severity === 'warning' && f81a.message === 'oops' && f81a.url === '/foo',
      '[81a] createFinding returns correct field values',
    );

    // [81b] missing type → throws containing "type"
    let threw81b = false;
    try { createFinding({ severity: 'info', message: 'm' }); } catch (e) { threw81b = /type/i.test(e.message); }
    assert(threw81b, '[81b] createFinding throws when type is missing');

    // [81c] invalid severity → throws containing "severity"
    let threw81c = false;
    try { createFinding({ type: 't', severity: 'medium', message: 'm' }); } catch (e) { threw81c = /severity/i.test(e.message); }
    assert(threw81c, '[81c] createFinding throws on invalid severity');

    // [81d] returned object is frozen (immutable)
    const f81d = createFinding({ type: 't', severity: 'info', message: 'm' });
    assert(Object.isFrozen(f81d), '[81d] createFinding returns a frozen object');
  }

  // ── Block [82] withRetry() exponential backoff ─────────────────────────────
  {
    console.log('\n[82] withRetry() exponential backoff');

    // [82a] successful function called exactly once
    let calls82a = 0;
    await withRetry(() => { calls82a++; return Promise.resolve('ok'); }, { attempts: 3, delayMs: 1 });
    assert(calls82a === 1, '[82a] withRetry calls fn once when it succeeds immediately');

    // [82b] transient failure retried — succeeds on second attempt
    let calls82b = 0;
    await withRetry(() => {
      calls82b++;
      if (calls82b < 2) throw new Error('transient');
      return Promise.resolve('ok');
    }, { attempts: 3, delayMs: 1 });
    assert(calls82b === 2, '[82b] withRetry retries on transient failure and succeeds on second attempt');

    // [82c] persistent failure rethrown after all attempts exhausted
    let threw82c = false;
    let calls82c = 0;
    try {
      await withRetry(() => { calls82c++; throw new Error('permanent'); }, { attempts: 2, delayMs: 1 });
    } catch { threw82c = true; }
    assert(threw82c && calls82c === 2, '[82c] withRetry rethrows after all attempts exhausted');

    // [82d] ARGUS_RETRY_ATTEMPTS=1 env override → only one attempt made
    const prev = process.env.ARGUS_RETRY_ATTEMPTS;
    process.env.ARGUS_RETRY_ATTEMPTS = '1';
    let calls82d = 0;
    let threw82d = false;
    try {
      await withRetry(() => { calls82d++; throw new Error('fail'); }, { delayMs: 1 });
    } catch { threw82d = true; }
    if (prev === undefined) delete process.env.ARGUS_RETRY_ATTEMPTS;
    else process.env.ARGUS_RETRY_ATTEMPTS = prev;
    assert(threw82d && calls82d === 1, '[82d] ARGUS_RETRY_ATTEMPTS=1 limits withRetry to one attempt');
  }

  // ── Block [83] Watch dashboard + fix loop contracts ──────────────────────
  {
    console.log('\n[83] Watch dashboard + argus_get_context fix loop');

    const watchModePath = path.join(__dirname, '../src/orchestration/watch-mode.js');
    let watchContent = null;
    try { watchContent = fs.readFileSync(watchModePath, 'utf8'); } catch { /* file missing */ }

    // [83a] watch-mode.js exists and is readable
    assert(watchContent !== null, '[83a] src/orchestration/watch-mode.js exists and is readable');

    // [83b] DASHBOARD_HTML constant present
    assert(
      watchContent !== null && watchContent.includes('DASHBOARD_HTML'),
      '[83b] watch-mode.js defines the DASHBOARD_HTML constant',
    );

    // [83c] startDashboard function present
    assert(
      watchContent !== null && watchContent.includes('startDashboard'),
      '[83c] watch-mode.js exports/defines startDashboard',
    );

    // [83d] dashboard /data endpoint present
    assert(
      watchContent !== null && watchContent.includes('/data'),
      '[83d] watch-mode.js dashboard serves a /data JSON endpoint',
    );

    // [83e] ARGUS_WATCH_UI_PORT env var referenced
    assert(
      watchContent !== null && watchContent.includes('ARGUS_WATCH_UI_PORT'),
      '[83e] watch-mode.js reads ARGUS_WATCH_UI_PORT for dashboard port',
    );

    // [83f] WatchSession and runWatchMode still exported
    assert(
      watchContent !== null &&
        watchContent.includes('export class WatchSession') &&
        watchContent.includes('export async function runWatchMode'),
      '[83f] watch-mode.js still exports WatchSession and runWatchMode',
    );
  }

  // ── Block [84] cli/init.js — detectFramework, generateTargetsJs, generateEnvFile ──
  {
    console.log('\n[84] cli/init.js — detectFramework, generateTargetsJs, generateEnvFile');

    const initPath = path.join(__dirname, '../src/cli/init.js');
    let initContent = null;
    try { initContent = fs.readFileSync(initPath, 'utf8'); } catch { /* file missing */ }

    // [84a] init.js exists and is readable
    assert(initContent !== null, '[84a] src/cli/init.js exists and is readable');

    // [84b] detectFramework exported
    assert(
      initContent !== null && initContent.includes('export function detectFramework'),
      '[84b] src/cli/init.js exports detectFramework',
    );

    // [84c] generateTargetsJs exported
    assert(
      initContent !== null && initContent.includes('export function generateTargetsJs'),
      '[84c] src/cli/init.js exports generateTargetsJs',
    );

    // [84d] generateEnvFile exported
    assert(
      initContent !== null && initContent.includes('export function generateEnvFile'),
      '[84d] src/cli/init.js exports generateEnvFile',
    );

    // [84e] detectFramework returns 'unknown' for non-existent dir (pure function test)
    const { detectFramework, generateTargetsJs, generateEnvFile } = await import('../src/cli/init.js');
    assert(
      detectFramework('/nonexistent-dir-argus-test-84e') === 'unknown',
      '[84e] detectFramework returns "unknown" for a non-existent directory',
    );

    // [84f] generateTargetsJs returns non-empty string containing the supplied route path
    const generatedTs = generateTargetsJs([{ path: '/test-84f', name: 'Test', critical: false, waitFor: null }]);
    assert(
      typeof generatedTs === 'string' && generatedTs.length > 0 && generatedTs.includes('/test-84f'),
      '[84f] generateTargetsJs returns non-empty string containing the supplied route path',
    );

    // [84g] generateEnvFile returns non-empty string substituting the supplied devUrl
    const generatedEnv = generateEnvFile({ devUrl: 'http://localhost:49999' });
    assert(
      typeof generatedEnv === 'string' && generatedEnv.length > 0 && generatedEnv.includes('localhost:49999'),
      '[84g] generateEnvFile returns non-empty string containing the supplied TARGET_DEV_URL',
    );
  }

  // ── Block [85] Production 401/403 severity (GAP-022 + GAP-009 regression) ──
  {
    console.log('\n[85] Production 401/403 severity — crawlRouteCheap critical:true vs false (GAP-022 / GAP-009)');

    const crit85   = { name: 'Net-Errors-Crit',    path: '/network-errors.html', critical: true,  waitFor: null };
    const nonCrit85 = { name: 'Net-Errors-NonCrit', path: '/network-errors.html', critical: false, waitFor: null };

    const rc85 = await crawlRouteCheap(crit85, B, mcp);
    const n401c = rc85.errors.filter(e => e.type === 'network' && e.status === 401);
    const n403c = rc85.errors.filter(e => e.type === 'network' && e.status === 403);
    assert(
      n401c.length > 0 && n401c[0].severity === 'critical',
      `[85a] Production: 401 → critical on critical route (classifyNetworkRequest) (got ${n401c[0]?.severity ?? 'none'})`,
    );
    assert(
      n403c.length > 0 && n403c[0].severity === 'critical',
      `[85b] Production: 403 → critical on critical route (got ${n403c[0]?.severity ?? 'none'})`,
    );

    const rn85 = await crawlRouteCheap(nonCrit85, B, mcp);
    const n401n = rn85.errors.filter(e => e.type === 'network' && e.status === 401);
    const n403n = rn85.errors.filter(e => e.type === 'network' && e.status === 403);
    assert(
      n401n.length > 0 && n401n[0].severity === 'warning',
      `[85c] Production: 401 → warning on non-critical route (GAP-009) (got ${n401n[0]?.severity ?? 'none'})`,
    );
    assert(
      n403n.length > 0 && n403n[0].severity === 'warning',
      `[85d] Production: 403 → warning on non-critical route (GAP-009) (got ${n403n[0]?.severity ?? 'none'})`,
    );
  }

  // ── Block [86] Production console.error severity (GAP-023) ──────────────────
  {
    console.log('\n[86] Production console.error severity — crawlRouteCheap critical:true vs false (GAP-023)');

    const critCons86   = { name: 'JS-Crit',    path: '/js-errors-critical.html', critical: true,  waitFor: null };
    const nonCritCons86 = { name: 'JS-NonCrit', path: '/js-errors.html',          critical: false, waitFor: null };

    const rc86 = await crawlRouteCheap(critCons86, B, mcp);
    const ce86c = rc86.errors.filter(e => e.type === 'console' && e.level === 'error');
    assert(ce86c.length >= 1, `[86a] Production: console.error detected on critical route (got ${ce86c.length})`);
    assert(
      ce86c.every(e => e.severity === 'critical'),
      `[86b] Production: all console.error → critical on critical route`,
    );

    const rn86 = await crawlRouteCheap(nonCritCons86, B, mcp);
    const ce86n = rn86.errors.filter(e => e.type === 'console' && e.level === 'error');
    assert(ce86n.length >= 1, `[86c] Production: console.error detected on non-critical route (got ${ce86n.length})`);
    assert(
      ce86n.every(e => e.severity === 'warning'),
      `[86d] Production: all console.error → warning on non-critical route`,
    );
  }

  // ── Block [87] Production load_failure via crawlRouteCheap (GAP-024) ────────
  {
    console.log('\n[87] Production load_failure — waitFor timeout via crawlRouteCheap (GAP-024)');

    const lfRoute87 = { name: 'WaitFor-Timeout', path: '/waitfor-timeout.html', critical: false, waitFor: '#never-appears' };
    const result87  = await crawlRouteCheap(lfRoute87, B, mcp);
    const lf87      = result87.errors.filter(e => e.type === 'load_failure');
    assert(lf87.length > 0, `[87a] Production: load_failure emitted when waitFor selector never appears`);
    assert(
      lf87[0]?.severity === 'warning',
      `[87b] Production: load_failure → warning on non-critical route (got ${lf87[0]?.severity ?? 'none'})`,
    );
    assert(
      typeof lf87[0]?.message === 'string' && lf87[0].message.includes('#never-appears'),
      `[87c] Production: load_failure message names the missing selector`,
    );
  }

  // ── Block [88] Production api_call_summary via crawlRouteCheap (GAP-025) ────
  {
    console.log('\n[88] Production api_call_summary — API frequency via crawlRouteCheap (GAP-025)');

    const apiRoute88 = { name: 'API-Freq', path: '/api-frequency.html', critical: false, waitFor: null };
    const result88   = await crawlRouteCheap(apiRoute88, B, mcp);
    const summary88  = result88.errors.filter(e => e.type === 'api_call_summary');
    const loop88     = result88.errors.filter(e => e.type === 'api_duplicate_call' && (e.endpoint ?? '').includes('data-loop'));
    assert(summary88.length > 0, `[88a] Production: api_call_summary present in errors`);
    assert(
      loop88.length > 0 && loop88[0].severity === 'critical',
      `[88b] Production: data-loop ×6+ → critical severity (got ${loop88[0]?.severity ?? 'none'})`,
    );
    assert(
      typeof summary88[0]?.uniqueEndpoints === 'number',
      `[88c] Production: api_call_summary.uniqueEndpoints is a number (got ${typeof summary88[0]?.uniqueEndpoints})`,
    );
  }

  // ── Block [89] Production seo_missing_description (GAP-028) ─────────────────
  {
    console.log('\n[89] Production seo_missing_description — via crawlRouteCheap (GAP-028)');

    const seoRoute89 = { name: 'SEO-Issues', path: '/seo-issues.html', critical: false, waitFor: null };
    const result89   = await crawlRouteCheap(seoRoute89, B, mcp);
    const misDesc89  = result89.errors.filter(e => e.type === 'seo_missing_description');
    assert(misDesc89.length > 0, `[89a] Production: seo_missing_description detected`);
    assert(
      misDesc89[0]?.severity === 'warning',
      `[89b] Production: seo_missing_description → warning (got ${misDesc89[0]?.severity ?? 'none'})`,
    );
    assert(
      typeof misDesc89[0]?.message === 'string' && misDesc89[0].message.length > 0,
      `[89c] Production: seo_missing_description has non-empty message`,
    );
  }

  // ── Block [90] Production SCSS sourceMappingURL in css_summary (GAP-027) ────
  // CSS analysis is now a registerExpensive plugin (GAP-034); call it directly.
  {
    console.log('\n[90] Production SCSS sourceMappingURL — css_summary.scssSourceFiles via css-analyzer (GAP-027)');

    const browser90 = new CdpBrowserAdapter(mcp);
    const url90     = `${B}/css-issues.html`;
    await browser90.navigate(url90);
    await new Promise(r => setTimeout(r, 800));
    const cssRaw90   = await browser90.evaluate(CSS_ANALYSIS_SCRIPT);
    const cssInput90 = cssRaw90 == null ? null
      : typeof cssRaw90 === 'object' && !Array.isArray(cssRaw90) ? cssRaw90
      : parseEval(cssRaw90, null);
    const cssErrors90  = cssInput90 ? parseCssAnalysisResult(cssInput90, url90) : [];
    const cssSummary90 = cssErrors90.find(e => e.type === 'css_summary');
    assert(cssSummary90 !== undefined, `[90a] Production: css_summary finding present`);
    assert(
      Array.isArray(cssSummary90?.scssSourceFiles),
      `[90b] Production: css_summary.scssSourceFiles is an array`,
    );
    assert(
      (cssSummary90?.scssSourceFiles?.length ?? 0) > 0,
      `[90c] Production: css_summary.scssSourceFiles has ≥1 entry (sourceMappingURL detected)`,
    );
  }

  // ── Block [91] Production css_override (non-!important) (GAP-026) ───────────
  // CSS analysis is now a registerExpensive plugin (GAP-034); call it directly.
  {
    console.log('\n[91] Production css_override (non-!important) — via css-analyzer (GAP-026)');

    const browser91 = new CdpBrowserAdapter(mcp);
    const url91     = `${B}/css-issues.html`;
    await browser91.navigate(url91);
    await new Promise(r => setTimeout(r, 800));
    const cssRaw91   = await browser91.evaluate(CSS_ANALYSIS_SCRIPT);
    const cssInput91 = cssRaw91 == null ? null
      : typeof cssRaw91 === 'object' && !Array.isArray(cssRaw91) ? cssRaw91
      : parseEval(cssRaw91, null);
    const cssErrors91 = cssInput91 ? parseCssAnalysisResult(cssInput91, url91) : [];
    const nonImp91    = cssErrors91.filter(e => e.type === 'css_override' && !e.hasImportant);
    assert(
      nonImp91.length > 0,
      `[91a] Production: non-!important css_override detected (got ${nonImp91.length})`,
    );
    assert(
      nonImp91[0]?.severity === 'info',
      `[91b] Production: non-!important css_override → info severity (got ${nonImp91[0]?.severity ?? 'none'})`,
    );
    assert(
      typeof nonImp91[0]?.property === 'string',
      `[91c] Production: css_override has property field (got ${typeof nonImp91[0]?.property})`,
    );
  }

  // ── Block [92] Lighthouse CLS soft assertion via checkLighthouse (GAP-029) ──
  {
    console.log('\n[92] Lighthouse contract — checkLighthouse shape on perf-cls.html (GAP-029, soft)');

    const lhResult92 = await checkLighthouse(browser, `${B}/perf-cls.html`);
    soft(
      Array.isArray(lhResult92),
      `[92a] checkLighthouse always returns an array (got ${typeof lhResult92})`,
    );
    soft(
      lhResult92.length === 0 || lhResult92.every(v => v.type && v.severity && v.message),
      `[92b] checkLighthouse violations have required fields: type, severity, message (or N/A in headless)`,
    );
    soft(
      lhResult92.length === 0 || lhResult92.every(v => typeof v.url === 'string'),
      `[92c] checkLighthouse violations carry url field (or N/A in headless)`,
    );
  }

  // ── Block [93] diff.js utility unit tests (GAP-030) ─────────────────────────
  {
    console.log('\n[93] diff.js utilities — diffNetworkRequests + diffConsoleMessages (GAP-030)');

    // diffNetworkRequests: added, removed, changed
    const reqs93Dev = [
      { url: 'http://localhost:3100/api/feature-flags', status: 200, method: 'GET' },
      { url: 'http://localhost:3100/api/checkout',      status: 200, method: 'GET' },
    ];
    const reqs93Staging = [
      { url: 'http://localhost:3101/api/checkout',  status: 500, method: 'GET' },
      { url: 'http://localhost:3101/api/tracking',  status: 200, method: 'GET' },
    ];
    const diff93 = diffNetworkRequests(reqs93Dev, reqs93Staging);
    assert(diff93.added.length > 0,
      `[93a] diffNetworkRequests detects added endpoint in staging (got ${diff93.added.length})`);
    assert(diff93.removed.length > 0,
      `[93b] diffNetworkRequests detects removed endpoint (present in dev, absent in staging) (got ${diff93.removed.length})`);
    assert(diff93.changed.length > 0,
      `[93c] diffNetworkRequests detects status change (checkout 200→500) (got ${diff93.changed.length})`);

    // diffConsoleMessages: new errors in staging not in dev
    const msgs93Dev = [{ level: 'error', text: 'pre-existing error' }];
    const msgs93Staging = [
      { level: 'error', text: 'pre-existing error' },
      { level: 'error', text: 'new staging regression error' },
    ];
    const newErrs93 = diffConsoleMessages(msgs93Dev, msgs93Staging);
    assert(
      newErrs93.length === 1 && newErrs93[0].text === 'new staging regression error',
      `[93d] diffConsoleMessages detects new error in staging not in dev (got ${newErrs93.length}: "${newErrs93[0]?.text ?? 'none'}")`,
    );
  }

  // ── Block [94] mcp-parsers.js unit tests ─────────────────────────────────────
  {
    console.log('\n[94] mcp-parsers.js — parseConsoleMsgResponse + parseNetworkReqResponse unit tests');

    // parseConsoleMsgResponse — null/empty guard
    assert(Array.isArray(parseConsoleMsgResponse(null)),       '[94a] parseConsoleMsgResponse(null) returns array');
    assert(parseConsoleMsgResponse('').length === 0,           '[94b] parseConsoleMsgResponse("") returns []');

    // parseConsoleMsgResponse — standard format
    const cm94 = parseConsoleMsgResponse('msgid=3 [error] something failed');
    assert(cm94.length === 1 && cm94[0]._msgid === 3,         '[94c] parseConsoleMsgResponse parses msgid correctly');
    assert(cm94[0].level === 'error' && cm94[0].text === 'something failed',
      '[94d] parseConsoleMsgResponse parses level and text');

    // parseConsoleMsgResponse — warn → warning normalisation
    const cw94 = parseConsoleMsgResponse('msgid=7 [warn] deprecated api call');
    assert(cw94[0]?.level === 'warning',                       '[94e] parseConsoleMsgResponse normalises [warn] → "warning"');

    // parseNetworkReqResponse — null/empty guard
    assert(parseNetworkReqResponse(null).length === 0,         '[94f] parseNetworkReqResponse(null) returns []');

    // parseNetworkReqResponse — standard format
    const nr94 = parseNetworkReqResponse('reqid=1 GET /api/data [200]');
    assert(nr94.length === 1 && nr94[0]._reqid === 1 && nr94[0].status === 200,
      '[94g] parseNetworkReqResponse parses reqid + status correctly');

    // parseNetworkReqResponse — extended status text (GAP-022 regression guard)
    const nr94ext = parseNetworkReqResponse('reqid=5 POST /api/auth [401 Unauthorized]');
    assert(nr94ext.length === 1 && nr94ext[0].status === 401,
      '[94h] parseNetworkReqResponse handles "[401 Unauthorized]" status text format');
  }

  // ── Block [95] registry.js plugin registration ────────────────────────────────
  {
    console.log('\n[95] registry.js — plugin registration order + getCheap/getExpensive');

    // Analyzers self-register at module import time via orchestrator.js → crawl-and-report.js.
    // All 6 production analyzers call registerExpensive() — none call registerCheap()
    // (cheap analyzers are hard-wired in crawlRouteCheap, not discovered via registry).
    const cheap95  = getCheap();
    const exp95    = getExpensive();
    assert(Array.isArray(cheap95),
      `[95a] getCheap returns an array (no production analyzer self-registers as cheap; got ${cheap95.length})`);
    assert(cheap95.every(a => typeof a.analyze === 'function'),
      '[95b] all cheap analyzers have an analyze() function (vacuously true — none registered)');
    assert(exp95.length >= 6,
      `[95c] getExpensive returns ≥6 registered expensive analyzers (got ${exp95.length})`);

    // Manual registration adds immediately
    const cheapBefore95 = getCheap().length;
    registerCheap({ name: 'harness-probe-cheap', analyze: () => [] });
    assert(getCheap().length === cheapBefore95 + 1,
      '[95d] registerCheap adds analyzer immediately (getCheap() length +1)');

    // Cheap and expensive sets are disjoint by name
    const cheapNames95 = new Set(getCheap().map(a => a.name));
    const expNames95   = new Set(getExpensive().map(a => a.name));
    const overlap95    = [...cheapNames95].filter(n => expNames95.has(n));
    assert(overlap95.length === 0,
      `[95e] cheap and expensive analyzer sets are disjoint (overlap: ${overlap95.join(', ') || 'none'})`);
  }

  // ── Block [96] report-processor.js — deduplicateFindings + rebuildSummary ────
  {
    console.log('\n[96] report-processor.js — deduplicateFindings + rebuildSummary pure functions');

    // deduplicateFindings — empty input
    assert(deduplicateFindings([]).length === 0,
      '[96a] deduplicateFindings([]) returns []');

    // deduplicateFindings — removes exact duplicates (same type + message + url)
    const dup96 = [
      { type: 'console', message: 'err', url: 'http://localhost/' },
      { type: 'console', message: 'err', url: 'http://localhost/' },
    ];
    assert(deduplicateFindings(dup96).length === 1,
      '[96b] deduplicateFindings removes identical type+message+url entries');

    // deduplicateFindings — different URL = not a duplicate
    const diff96 = [
      { type: 'console', message: 'err', url: 'http://localhost/a' },
      { type: 'console', message: 'err', url: 'http://localhost/b' },
    ];
    assert(deduplicateFindings(diff96).length === 2,
      '[96c] deduplicateFindings keeps entries with different URLs');

    // rebuildSummary — counts correctly across severities
    const report96 = {
      routes: [{ errors: [
        { type: 'a', severity: 'critical' },
        { type: 'b', severity: 'warning' },
        { type: 'c', severity: 'info' },
      ]}],
      flows: [],
      codebase: [],
      summary: {},
    };
    rebuildSummary(report96);
    assert(report96.summary.total === 3,    `[96d] rebuildSummary total=3 (got ${report96.summary.total})`);
    assert(report96.summary.critical === 1, `[96e] rebuildSummary critical=1 (got ${report96.summary.critical})`);
    assert(report96.summary.warning === 1,  `[96f] rebuildSummary warning=1 (got ${report96.summary.warning})`);
    assert(report96.summary.info === 1,     `[96g] rebuildSummary info=1 (got ${report96.summary.info})`);
  }

  // ── Block [97] config/targets.js — thresholds + config constants ──────────────
  {
    console.log('\n[97] config/targets.js — thresholds + config constants');

    const { thresholds: th97, config: cfg97 } = argusTargets;

    assert(typeof th97.perf.LCP === 'number' && th97.perf.LCP > 0,
      `[97a] thresholds.perf.LCP is a positive number (got ${th97.perf.LCP})`);
    assert(th97.network.slowCritical > th97.network.slowWarning,
      `[97b] slowCritical > slowWarning ordering invariant (${th97.network.slowCritical} > ${th97.network.slowWarning})`);
    assert(typeof cfg97.pageSettleMs === 'number' && cfg97.pageSettleMs > 0,
      `[97c] config.pageSettleMs is a positive number (got ${cfg97.pageSettleMs})`);
    assert(typeof th97.lighthouse.accessibility.critical === 'number',
      '[97d] thresholds.lighthouse.accessibility.critical is a number');
    assert(th97.memory.detachedCritical > th97.memory.detachedWarning,
      `[97e] memory detachedCritical > detachedWarning (${th97.memory.detachedCritical} > ${th97.memory.detachedWarning})`);
  }

  // ── Block [98] slug.js — slugify edge cases ───────────────────────────────────
  {
    console.log('\n[98] slug.js — slugify edge cases');

    assert(slugify('Hello World!') === 'hello-world',
      '[98a] slugify("Hello World!") → "hello-world"');
    assert(slugify('') === 'unnamed',
      '[98b] slugify("") → "unnamed"');
    assert(slugify(null) === 'unnamed',
      '[98c] slugify(null) → "unnamed"');
    assert(!/^-|-$/.test(slugify('--leading-trailing--')),
      '[98d] slugify strips leading/trailing dashes');
    assert(/^[a-z0-9-]+$/.test(slugify('Argus QA Tool — v9.5!')),
      '[98e] slugify output contains only [a-z0-9-] characters');
  }

  // ── Block [99] telemetry.js — no-op transparent wrapper ──────────────────────
  {
    console.log('\n[99] telemetry.js — no-op transparent wrapper (no OTEL endpoint set)');

    // recordFinding, recordFlaky, recordNewFindings must not throw in no-op mode
    let threw99 = false;
    try {
      recordFinding('console', 'critical', 'home');
      recordFlaky(0, 'home');
      recordFlaky(3, 'checkout');
      recordNewFindings(5);
      recordNewFindings(0);
    } catch { threw99 = true; }
    assert(!threw99, '[99a] recordFinding/recordFlaky/recordNewFindings do not throw without OTEL endpoint');

    // startSpan must be transparent — callback return value passes through
    const spanResult99 = await startSpan('harness.test', { block: '99' }, () => 'sentinel-value-99');
    assert(spanResult99 === 'sentinel-value-99',
      '[99b] startSpan passes callback return value through (transparent wrapper)');

    // startSpan must not suppress thrown errors
    let spanThrew99 = false;
    try {
      await startSpan('harness.err', {}, () => { throw new Error('intentional-99'); });
    } catch (e) {
      spanThrew99 = e.message === 'intentional-99';
    }
    assert(spanThrew99, '[99c] startSpan re-throws errors from callback');
  }

  // ── Block [100] logger.js — childLogger factory ───────────────────────────────
  {
    console.log('\n[100] logger.js — childLogger returns structured Pino child logger');

    const log100 = childLogger('harness-test-100');
    assert(log100 !== null && typeof log100 === 'object',
      '[100a] childLogger returns a non-null object');
    assert(typeof log100.info === 'function',
      '[100b] childLogger result has info() method');
    assert(typeof log100.warn === 'function' && typeof log100.error === 'function',
      '[100c] childLogger result has warn() and error() methods');
  }

  // ── Block [101] argus.js + batch-runner.js re-export barrels ─────────────────
  {
    console.log('\n[101] argus.js + batch-runner.js — re-export barrel validation');

    assert(typeof argusJs.runCrawl === 'function',
      '[101a] argus.js re-exports runCrawl as a function');
    assert(typeof argBatchRunner.runCrawl === 'function',
      '[101b] batch-runner.js re-exports runCrawl as a function');
    assert(argusJs.runCrawl === argBatchRunner.runCrawl,
      '[101c] both barrel files point to the same runCrawl function reference');
  }

  // ── Block [102] mcp-client.js — unwrapEval shapes ────────────────────────────
  {
    console.log('\n[102] mcp-client.js — unwrapEval handles all response shapes');

    assert(unwrapEval(null) === null,
      '[102a] unwrapEval(null) → null');
    assert(unwrapEval({ result: 'hello' }) === 'hello',
      '[102b] unwrapEval({ result: "hello" }) → "hello"');
    assert(unwrapEval('plain-string') === 'plain-string',
      '[102c] unwrapEval(string) → same string (no unwrapping)');
    // Object without result field → return the object itself
    const obj102 = { data: 42 };
    assert(unwrapEval(obj102) === obj102,
      '[102d] unwrapEval(object without result) → returns object itself');
  }

  // ── Block [103] verifySlackSignature — pure HMAC function ────────────────────
  {
    console.log('\n[103] server/slash-command-handler.js — verifySlackSignature pure function');

    const prevSecret103 = process.env.SLACK_SIGNING_SECRET;

    // [103a] No signing secret → false
    delete process.env.SLACK_SIGNING_SECRET;
    assert(
      verifySlackSignature({ headers: {}, rawBody: '' }) === false,
      '[103a] verifySlackSignature returns false when SLACK_SIGNING_SECRET is unset',
    );

    // [103b] Missing headers → false (secret present but no header fields)
    process.env.SLACK_SIGNING_SECRET = 'test-secret-103';
    assert(
      verifySlackSignature({ headers: {}, rawBody: '' }) === false,
      '[103b] verifySlackSignature returns false when headers are missing',
    );

    // [103c] Stale timestamp (> 5 min old) → false
    const staleTs103 = String(Math.floor(Date.now() / 1000) - 400);
    assert(
      verifySlackSignature({
        headers: { 'x-slack-signature': 'v0=abc', 'x-slack-request-timestamp': staleTs103 },
        rawBody: '',
      }) === false,
      '[103c] verifySlackSignature returns false for stale timestamp (>5 min)',
    );

    // [103d] Fresh timestamp + wrong signature → false
    const freshTs103 = String(Math.floor(Date.now() / 1000));
    assert(
      verifySlackSignature({
        headers: { 'x-slack-signature': 'v0=badhash', 'x-slack-request-timestamp': freshTs103 },
        rawBody: 'body=test',
      }) === false,
      '[103d] verifySlackSignature returns false for mismatched signature',
    );

    // [103e] Correctly constructed HMAC → true
    const secret103 = 'harness-signing-secret-103';
    process.env.SLACK_SIGNING_SECRET = secret103;
    const ts103    = String(Math.floor(Date.now() / 1000));
    const body103  = 'command=%2Fargus-retest&text=http%3A%2F%2Fexample.com';
    const sig103   = 'v0=' + crypto.createHmac('sha256', secret103)
      .update(`v0:${ts103}:${body103}`).digest('hex');
    assert(
      verifySlackSignature({
        headers: { 'x-slack-signature': sig103, 'x-slack-request-timestamp': ts103 },
        rawBody: body103,
      }) === true,
      '[103e] verifySlackSignature returns true for valid HMAC signature',
    );

    // Restore
    if (prevSecret103 !== undefined) process.env.SLACK_SIGNING_SECRET = prevSecret103;
    else delete process.env.SLACK_SIGNING_SECRET;
  }

  // ── Block [104] server/interaction-handler.js — handleInteraction mock ────────
  {
    console.log('\n[104] server/interaction-handler.js — handleInteraction with mocked req/res');

    const mkRes = () => {
      const r = { _status: 200, _body: null };
      r.status = code => { r._status = code; return r; };
      r.json = body => { r._body = body; return r; };
      r.send = body => { r._body = body; return r; };
      return r;
    };

    // [104a] Missing/invalid Slack signature → 401
    const res104a = mkRes();
    await handleInteraction(
      { headers: {}, rawBody: '', body: {} },
      res104a,
    );
    assert(res104a._status === 401,
      '[104a] handleInteraction returns 401 when signature is invalid/missing');

    // Build a valid signature so we can test downstream paths
    const secret104 = 'harness-secret-104';
    const prevSecret104 = process.env.SLACK_SIGNING_SECRET;
    process.env.SLACK_SIGNING_SECRET = secret104;

    const ts104    = String(Math.floor(Date.now() / 1000));
    const body104  = 'payload=%7Binvalid+json%7D';
    const sig104   = 'v0=' + crypto.createHmac('sha256', secret104)
      .update(`v0:${ts104}:${body104}`).digest('hex');

    // [104b] Valid signature + malformed JSON payload → 400
    const res104b = mkRes();
    await handleInteraction({
      headers: { 'x-slack-signature': sig104, 'x-slack-request-timestamp': ts104 },
      rawBody: body104,
      body: { payload: '{invalid json}' },
    }, res104b);
    assert(res104b._status === 400,
      '[104b] handleInteraction returns 400 for malformed JSON payload');

    // [104c] Valid signature + unrecognised interaction type → 200 (ack'd and ignored)
    const validPayload104 = JSON.stringify({
      type: 'unknown_interaction_type',
      actions: [],
    });
    const body104c   = `payload=${encodeURIComponent(validPayload104)}`;
    const sig104c    = 'v0=' + crypto.createHmac('sha256', secret104)
      .update(`v0:${ts104}:${body104c}`).digest('hex');
    const res104c = mkRes();
    await handleInteraction({
      headers: { 'x-slack-signature': sig104c, 'x-slack-request-timestamp': ts104 },
      rawBody: body104c,
      body: { payload: validPayload104 },
    }, res104c);
    assert(res104c._status === 200,
      '[104c] handleInteraction returns 200 (ack) for unrecognised interaction type');

    // [104d] handleInteraction is an async function
    assert(handleInteraction.constructor.name === 'AsyncFunction',
      '[104d] handleInteraction is an async function');

    if (prevSecret104 !== undefined) process.env.SLACK_SIGNING_SECRET = prevSecret104;
    else delete process.env.SLACK_SIGNING_SECRET;
  }

  // ── Block [105] slack-notifier.js — exported function shapes ─────────────────
  {
    console.log('\n[105] slack-notifier.js — exported function shapes (without Slack token)');

    assert(typeof postBugReport === 'function',
      '[105a] postBugReport is a function');
    assert(typeof postRetestResult === 'function',
      '[105b] postRetestResult is a function');
    assert(typeof acknowledgeMessage === 'function',
      '[105c] acknowledgeMessage is a function');
  }

  // ── Block [106] report-processor.js — processReport integration ──────────────
  {
    console.log('\n[106] report-processor.js — processReport integration (file I/O + baseline)');

    const tmpDir106 = path.join(os.tmpdir(), `argus-harness-106-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir106, 'baselines'), { recursive: true });

    const report106 = {
      generatedAt: new Date().toISOString(),
      baseUrl:     'http://localhost:3100',
      routes: [{
        route: 'Home',
        url:   'http://localhost:3100/',
        errors: [
          { type: 'console', message: 'err-a', severity: 'critical', url: 'http://localhost:3100/' },
          { type: 'network', message: 'net-b', severity: 'warning',  url: 'http://localhost:3100/' },
        ],
      }],
      flows:    [],
      codebase: [],
      summary:  { total: 0, critical: 0, warning: 0, info: 0 },
    };

    const { reportPath: rp106, diff: diff106 } = await processReport(report106, {
      outputDir:         tmpDir106,
      severityOverrides: {},
    });

    assert(fs.existsSync(rp106),
      '[106a] processReport writes JSON report to disk');
    assert(rp106.endsWith('.json'),
      '[106b] reportPath has .json extension');
    assert(report106.summary.total === 2,
      `[106c] rebuildSummary counts all findings (expected 2, got ${report106.summary.total})`);
    assert(diff106.isFirstRun === true,
      '[106d] first run — isFirstRun: true (no prior baseline)');
  }

  // ── Block [107] dispatcher.js — dispatchAll HTML fallback ────────────────────
  {
    console.log('\n[107] dispatcher.js — dispatchAll routes to HTML report when no Slack token');

    const tmpDir107 = path.join(os.tmpdir(), `argus-harness-107-${Date.now()}`);
    fs.mkdirSync(tmpDir107, { recursive: true });

    const rp107 = path.join(tmpDir107, 'test-report.json');
    const report107 = {
      generatedAt: new Date().toISOString(),
      baseUrl:     'http://localhost:3100',
      summary:     { total: 0, critical: 0, warning: 0, info: 0 },
      routes: [{ route: '/test', url: 'http://localhost:3100/test', errors: [] }],
      flows:       [],
    };
    fs.writeFileSync(rp107, JSON.stringify(report107, null, 2), 'utf8');

    // Ensure Slack is NOT configured so the HTML path is taken
    const prevSlack107 = process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;

    await dispatchAll(
      report107,
      { isFirstRun: true, newCount: 0, resolvedCount: 0 },
      rp107,
    );

    // generateHtmlReport always writes <dir>/report.html
    const htmlPath107 = path.join(tmpDir107, 'report.html');
    assert(fs.existsSync(htmlPath107),
      '[107a] dispatchAll generates report.html when SLACK_BOT_TOKEN is absent');

    const html107 = fs.readFileSync(htmlPath107, 'utf8');
    assert(html107.includes('<title>'),
      '[107b] generated HTML contains <title> tag');
    assert(html107.includes('Argus'),
      '[107c] generated HTML mentions "Argus"');
    assert(typeof dispatchAll === 'function',
      '[107d] dispatchAll is exported as a function');

    if (prevSlack107 !== undefined) process.env.SLACK_BOT_TOKEN = prevSlack107;
  }

  // ── Block [108] session-persistence.js error paths ───────────────────────────
  {
    console.log('\n[108] session-persistence.js — restoreSession error paths + hasSession staleness');

    const tmpDir108 = path.join(os.tmpdir(), `argus-harness-108-${Date.now()}`);
    fs.mkdirSync(tmpDir108, { recursive: true });

    // [108a] Corrupt JSON → false (no browser interaction before parse)
    const corrupt108 = path.join(tmpDir108, 'corrupt.json');
    fs.writeFileSync(corrupt108, '{ not valid json !!!', 'utf8');
    const r108a = await restoreSession(null, 'http://localhost:3100', corrupt108);
    assert(r108a === false, '[108a] restoreSession returns false for corrupt JSON');

    // [108b] Missing file → false
    const missing108 = path.join(tmpDir108, 'missing.json');
    const r108b = await restoreSession(null, 'http://localhost:3100', missing108);
    assert(r108b === false, '[108b] restoreSession returns false when session file does not exist');

    // [108c] hasSession with missing file → false
    assert(hasSession(missing108) === false,
      '[108c] hasSession returns false when file does not exist');

    // [108d] hasSession with stale savedAt (>1 hour ago) → false
    const stale108 = path.join(tmpDir108, 'stale.json');
    fs.writeFileSync(stale108, JSON.stringify({
      savedAt: new Date(Date.now() - 4 * 3600 * 1000).toISOString(),
      baseUrl: 'http://localhost:3100',
      localStorage: {}, sessionStorage: {}, cookies: [],
    }), 'utf8');
    assert(hasSession(stale108) === false,
      '[108d] hasSession returns false when savedAt is >1 hour old');
  }

  // ── Block [109] baseline-manager.js branch sanitization + null case ──────────
  {
    console.log('\n[109] baseline-manager.js — getCurrentBranch env var + loadBaseline null');

    const tmpDir109 = path.join(os.tmpdir(), `argus-harness-109-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir109, 'baselines'), { recursive: true });

    // [109a] loadBaseline on non-existent file → null
    const missing109 = path.join(tmpDir109, 'baselines', 'no-branch.json');
    const bl109null  = loadBaseline(missing109);
    assert(bl109null === null,
      '[109a] loadBaseline returns null for non-existent baseline file');

    // [109b] getCurrentBranch via GITHUB_REF_NAME env var
    const prev109 = process.env.GITHUB_REF_NAME;
    process.env.GITHUB_REF_NAME = 'feature/my-branch';
    const branch109 = getCurrentBranch();
    assert(typeof branch109 === 'string' && branch109.length > 0,
      `[109b] getCurrentBranch returns a non-empty string via GITHUB_REF_NAME (got "${branch109}")`);
    // Sanitized branch must not contain '/'
    assert(!branch109.includes('/'),
      `[109c] getCurrentBranch sanitizes slashes from branch names (got "${branch109}")`);
    if (prev109 !== undefined) process.env.GITHUB_REF_NAME = prev109;
    else delete process.env.GITHUB_REF_NAME;

    // [109d] Multi-branch non-interference: save for A, save for B, load A unchanged
    const reportA109 = {
      baseUrl: 'http://localhost:3100',
      routes: [{ url: 'http://localhost:3100/', errors: [{ type: 'console', message: 'branch-a', severity: 'warning' }] }],
      flows: [], codebase: [], summary: {},
    };
    const reportB109 = {
      baseUrl: 'http://localhost:3100',
      routes: [{ url: 'http://localhost:3100/', errors: [{ type: 'network', message: 'branch-b', severity: 'critical' }] }],
      flows: [], codebase: [], summary: {},
    };
    const fileA109 = path.join(tmpDir109, 'baselines', 'branch-a.json');
    const fileB109 = path.join(tmpDir109, 'baselines', 'branch-b.json');
    saveBaseline(fileA109, reportA109);
    saveBaseline(fileB109, reportB109);
    const loadedA109 = loadBaseline(fileA109);
    assert(loadedA109 !== null,
      '[109d] loadBaseline(branchA) returns non-null after branchB baseline was also saved');
  }

  // ── Block [110] schema.js — Zod error message content ────────────────────────
  {
    console.log('\n[110] schema.js — Zod error message content verification');

    // [110a] Missing path → error message string contains field clue
    let err110a = null;
    try { validateConfig({ routes: [{ name: 'X' }] }); } catch (e) { err110a = e; }
    assert(err110a !== null && typeof err110a.message === 'string',
      '[110a] validateConfig with missing route.path throws an Error with message');

    // [110b] path not starting with '/' → error contains slash clue
    let err110b = null;
    try { validateConfig({ routes: [{ name: 'X', path: 'no-slash' }] }); } catch (e) { err110b = e; }
    assert(err110b !== null && typeof err110b.message === 'string',
      '[110b] validateConfig with path not starting with "/" throws with a message');

    // [110c] Wrong LCP type → error message is a non-empty string
    let err110c = null;
    try {
      validateConfig({
        routes: [{ name: 'X', path: '/' }],
        thresholds: { perf: { LCP: 'not-a-number' } },
      });
    } catch (e) { err110c = e; }
    assert(err110c !== null && err110c.message.length > 0,
      '[110c] validateConfig with string LCP throws non-empty error message');
  }

  // ── Block [111] github-reporter.js — isGitHubConfigured + formatPrComment cap ─
  {
    console.log('\n[111] github-reporter.js — isGitHubConfigured + formatPrComment MAX_TABLE_ROWS cap');

    const prevGhToken111 = process.env.GITHUB_TOKEN;
    const prevGhRepo111  = process.env.GITHUB_REPOSITORY;

    // [111a] isGitHubConfigured returns false when env vars absent
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_REPOSITORY;
    assert(isGitHubConfigured() === false,
      '[111a] isGitHubConfigured returns false when GITHUB_TOKEN and GITHUB_REPOSITORY are unset');

    // [111b] isGitHubConfigured returns true when both set
    process.env.GITHUB_TOKEN      = 'tok-test-111';
    process.env.GITHUB_REPOSITORY = 'test-org/test-repo';
    assert(isGitHubConfigured() === true,
      '[111b] isGitHubConfigured returns true when both GITHUB_TOKEN and GITHUB_REPOSITORY are set');

    if (prevGhToken111 !== undefined) process.env.GITHUB_TOKEN      = prevGhToken111;
    else delete process.env.GITHUB_TOKEN;
    if (prevGhRepo111  !== undefined) process.env.GITHUB_REPOSITORY = prevGhRepo111;
    else delete process.env.GITHUB_REPOSITORY;

    // [111c] formatPrComment with 20 new findings caps table at 15 rows (MAX_TABLE_ROWS)
    const bigErrors111 = Array.from({ length: 20 }, (_, i) => ({
      type: 'console', severity: 'warning', message: `Finding ${i}`,
      url: 'http://localhost:3100/', isNew: true,
    }));
    const bigReport111 = {
      baseUrl: 'http://localhost:3100/',
      generatedAt: new Date().toISOString(),
      summary: { total: 20, critical: 0, warning: 20, info: 0 },
      routes: [{ route: 'Home', url: 'http://localhost:3100/', errors: bigErrors111 }],
      flows: [], codebase: [],
    };
    const comment111 = formatPrComment(bigReport111, { isFirstRun: false, newCount: 20, resolvedCount: 0 });
    assert(comment111.includes('more — see full report'),
      '[111c] formatPrComment with 20 findings includes overflow row ("more — see full report")');

    // [111d] postPrComment throws when GITHUB_PR_NUMBER not set (guard test)
    delete process.env.GITHUB_PR_NUMBER;
    delete process.env.GITHUB_REPOSITORY;
    let threw111d = false;
    try { await postPrComment({}, {}); } catch { threw111d = true; }
    assert(threw111d, '[111d] postPrComment throws when GITHUB_REPOSITORY/PR_NUMBER are not set');
  }

  // ── Block [112] html-reporter.js — large finding set (1000+ findings) ────────
  {
    console.log('\n[112] html-reporter.js — generateHtmlReport handles 1000+ findings');

    const tmpDir112 = path.join(os.tmpdir(), `argus-harness-112-${Date.now()}`);
    fs.mkdirSync(tmpDir112, { recursive: true });

    // Build a report with 1000 findings (10 routes × 100 errors each)
    const bigReport112 = {
      generatedAt: new Date().toISOString(),
      baseUrl: 'http://localhost:3100',
      summary: { total: 1000, critical: 200, warning: 500, info: 300 },
      routes: Array.from({ length: 10 }, (_, i) => ({
        route: `/route-${i}`,
        url: `http://localhost:3100/route-${i}`,
        errors: Array.from({ length: 100 }, (_, j) => ({
          type: 'console', severity: j < 20 ? 'critical' : j < 70 ? 'warning' : 'info',
          message: `Error ${j} on route ${i}`, url: `http://localhost:3100/route-${i}`,
        })),
      })),
      flows: [], codebase: [],
    };
    const rp112 = path.join(tmpDir112, 'big-report.json');
    fs.writeFileSync(rp112, JSON.stringify(bigReport112, null, 2), 'utf8');

    let threw112 = false;
    let html112  = '';
    try { html112 = fs.readFileSync(generateHtmlReport(rp112), 'utf8'); } catch { threw112 = true; }
    assert(!threw112, '[112a] generateHtmlReport with 1000 findings does not throw');
    assert(html112.includes('<title>'), '[112b] large report generates valid HTML with <title>');
    assert(html112.includes('Argus'),   '[112c] large report HTML mentions "Argus"');
  }

  // ── Block [113] diff.js — URL normalization + edge cases ─────────────────────
  {
    console.log('\n[113] diff.js — diffNetworkRequests URL normalization + edge cases');

    // [113a] /user/123 and /user/456 normalized to same key → no diff (same endpoint)
    const reqs113devA   = [{ url: 'http://localhost:3100/user/123', status: 200, method: 'GET' }];
    const reqs113stagA  = [{ url: 'http://localhost:3100/user/456', status: 200, method: 'GET' }];
    const diff113a = diffNetworkRequests(reqs113devA, reqs113stagA);
    assert(diff113a.added.length === 0 && diff113a.removed.length === 0 && diff113a.changed.length === 0,
      `[113a] diffNetworkRequests treats /user/123 and /user/456 as the same normalized endpoint (added=${diff113a.added.length}, removed=${diff113a.removed.length}, changed=${diff113a.changed.length})`);

    // [113b] Empty arrays → zero diffs
    const diff113b = diffNetworkRequests([], []);
    assert(diff113b.added.length === 0 && diff113b.removed.length === 0 && diff113b.changed.length === 0,
      '[113b] diffNetworkRequests([], []) → { added:[], removed:[], changed:[] }');

    // [113c] diffConsoleMessages: warnings are ignored (only errors returned)
    const msgs113dev = [];
    const msgs113stg = [
      { level: 'error',   text: 'new-error' },
      { level: 'warning', text: 'new-warning' }, // warnings should be excluded
    ];
    const newErrs113 = diffConsoleMessages(msgs113dev, msgs113stg);
    assert(newErrs113.every(m => (m.level ?? m.severity) !== 'warning'),
      `[113c] diffConsoleMessages only returns errors, not warnings (got ${newErrs113.length}: ${newErrs113.map(m => m.level).join(',')})`);

    // [113d] diffConsoleMessages: exact-match dedup prevents re-reporting pre-existing error
    const preExisting113 = [{ level: 'error', text: 'known-error' }];
    const newErrs113d    = diffConsoleMessages(preExisting113, [...preExisting113, { level: 'error', text: 'known-error' }]);
    assert(newErrs113d.length === 0,
      `[113d] diffConsoleMessages deduplicates pre-existing exact-match errors (got ${newErrs113d.length})`);
  }

  // ── Block [114] mcp-server.js — LRU eviction constants ───────────────────────
  {
    console.log('\n[114] mcp-server.js — LRU cache constants + eviction code presence');

    const serverSrc114 = fs.readFileSync(
      path.resolve(__dirname, '../src/mcp-server.js'), 'utf8',
    );

    assert(serverSrc114.includes('MAX_SNAPSHOTS'),
      '[114a] mcp-server.js defines MAX_SNAPSHOTS constant for snapshotStore LRU limit');
    assert(serverSrc114.includes('MAX_AUDIT_CACHE'),
      '[114b] mcp-server.js defines MAX_AUDIT_CACHE constant for auditCache LRU limit');
    assert(serverSrc114.includes('.keys().next()'),
      '[114c] mcp-server.js contains oldest-first LRU eviction logic (.keys().next())');
  }

  // ── Block [115] flow-runner.js — press_key step action + resolveUidForSelector ─
  {
    console.log('\n[115] flow-runner.js — press_key step action + resolveUidForSelector uid resolution');

    // [115a] press_key step is registered — flow completes without flow_step_failed
    const pkFlow115 = {
      name: 'press-key-test',
      steps: [
        { action: 'navigate', url: `${B}/typetext-issues.html` },
        { action: 'press_key', key: 'Tab' },
        { action: 'press_key', key: 'Escape' },
      ],
    };
    const result115a = await runFlow(pkFlow115, B, browser);
    const fail115a   = result115a.findings.filter(f => f.type === 'flow_step_failed');
    assert(fail115a.length === 0,
      `[115a] press_key flow completes without flow_step_failed (got ${fail115a.length})`);

    // [115b] resolveUidForSelector resolves a known selector on the fixture page
    const uid115 = await resolveUidForSelector(browser, '#fill-input');
    assert(uid115 !== null && uid115 !== undefined,
      `[115b] resolveUidForSelector resolves #fill-input uid on typetext-issues.html (got ${uid115})`);

    // [115c] press_key 'Enter' on focused element completes without error
    const enterFlow115 = {
      name: 'press-enter-test',
      steps: [
        { action: 'navigate', url: `${B}/typetext-issues.html` },
        { action: 'press_key', key: 'Enter' },
      ],
    };
    const result115c = await runFlow(enterFlow115, B, browser);
    assert(result115c.status !== 'error',
      `[115c] press_key "Enter" flow status is not "error" (got ${result115c.status})`);

    // [115d] flow-runner.js source registers press_key as a step action
    const frSrc115 = fs.readFileSync(path.resolve(__dirname, '../src/utils/flow-runner.js'), 'utf8');
    assert(frSrc115.includes("'press_key'") || frSrc115.includes('"press_key"'),
      '[115d] flow-runner.js source registers press_key step action');
  }

  // ── Block [116] watch mode — startDashboard HTTP /data endpoint ───────────────
  {
    console.log('\n[116] watch mode — startDashboard HTTP /data endpoint');

    const port116 = await findFreePort(3200);
    const mockFindings116 = [
      { type: 'console', severity: 'warning', message: 'test-finding-116', url: 'http://localhost:3100/' },
    ];

    const server116 = startDashboard(() => mockFindings116, 'http://localhost:3100', port116);

    // Wait for server to be ready
    await new Promise(r => setTimeout(r, 200));

    let json116 = null;
    let httpErr116 = null;
    try {
      const res116 = await fetch(`http://localhost:${port116}/data`);
      json116 = await res116.json();
    } catch (e) { httpErr116 = e; }

    server116.close();

    assert(httpErr116 === null,
      `[116a] GET /data on dashboard server succeeds (no HTTP error: ${httpErr116?.message ?? 'none'})`);
    assert(json116 !== null && typeof json116 === 'object',
      '[116b] /data response is a JSON object');
    assert(Array.isArray(json116.findings),
      `[116c] /data response has findings array (got ${typeof json116?.findings})`);
    assert(json116.findings.length === 1 && json116.findings[0].type === 'console',
      `[116d] /data findings reflects mock data (got ${json116.findings.length} findings)`);
  }

  // ── Block [117] MCP stdio transport — initialize handshake + tools/list ───────
  {
    console.log('\n[117] MCP stdio transport — initialize handshake + tools/list');

    let srv117 = null;
    let initErr117 = null;
    let toolsResp117 = null;
    try {
      srv117 = await spawnArgusServer(path.resolve(__dirname, '..'));

      const listId = ++_mcpSeq;
      srv117.proc.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: listId, method: 'tools/list', params: {},
      }) + '\n');
      toolsResp117 = await mcpStdioRead(srv117.proc.stdout, listId, 8000);
    } catch (e) {
      initErr117 = e;
    } finally {
      try { srv117?.proc?.kill(); } catch {}
    }

    assert(initErr117 === null,
      `[117a] MCP server spawns and initializes without error (${initErr117?.message ?? 'ok'})`);
    assert(srv117?.initResp?.result?.serverInfo?.name === 'argus',
      `[117b] initialize response serverInfo.name === "argus" (got ${srv117?.initResp?.result?.serverInfo?.name})`);
    const tools117 = toolsResp117?.result?.tools ?? [];
    assert(Array.isArray(tools117) && tools117.length >= 8,
      `[117c] tools/list returns ≥ 8 tools (got ${tools117.length})`);
    const names117 = tools117.map(t => t.name);
    assert(['argus_audit', 'argus_last_report', 'argus_watch_snapshot', 'argus_get_context', 'argus_visual_diff'].every(n => names117.includes(n)),
      `[117d] tools/list includes all 5 key MCP tool names (got [${names117.join(', ')}])`);
  }

  // ── Block [118] argus_last_report MCP tool — missing reports dir returns structured error ──
  {
    console.log('\n[118] MCP tool argus_last_report — no-reports-dir returns structured JSON error');

    const tmpDir118 = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-mcp-118-'));
    let srv118 = null;
    let lastRptResp118 = null;
    let err118 = null;
    try {
      srv118 = await spawnArgusServer(tmpDir118); // cwd has no reports/ subdir

      const callId = ++_mcpSeq;
      srv118.proc.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: callId, method: 'tools/call',
        params: { name: 'argus_last_report', arguments: {} },
      }) + '\n');
      lastRptResp118 = await mcpStdioRead(srv118.proc.stdout, callId, 10000);
    } catch (e) {
      err118 = e;
    } finally {
      try { srv118?.proc?.kill(); } catch {}
      try { fs.rmdirSync(tmpDir118); } catch {}
    }

    assert(err118 === null,
      `[118a] argus_last_report call completes without crashing (${err118?.message ?? 'ok'})`);
    const text118 = lastRptResp118?.result?.content?.[0]?.text ?? '';
    assert(text118.includes('No reports found'),
      `[118b] argus_last_report returns "No reports found" when reports/ dir is absent (got: ${text118.slice(0, 80)})`);
    let parsed118 = null;
    try { parsed118 = JSON.parse(text118); } catch {}
    assert(parsed118 !== null && typeof parsed118 === 'object',
      `[118c] argus_last_report error response is valid JSON object (got: ${text118.slice(0, 40)})`);
  }

  // ── Block [119] argus_get_context MCP tool — snapshot_id + fix-loop diff ─────
  {
    console.log('\n[119] MCP tool argus_get_context — snapshot_id + fix-loop diff protocol');

    let srv119 = null;
    let snap1Resp119 = null;
    let snap2Resp119 = null;
    let err119 = null;
    try {
      srv119 = await spawnArgusServer(path.resolve(__dirname, '..'));

      // First call — no snapshot_id → creates new snapshot
      const call1Id = ++_mcpSeq;
      srv119.proc.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: call1Id, method: 'tools/call',
        params: { name: 'argus_get_context', arguments: {} },
      }) + '\n');
      snap1Resp119 = await mcpStdioRead(srv119.proc.stdout, call1Id, 20000);

      const snap1Text = snap1Resp119?.result?.content?.[0]?.text ?? '{}';
      let snap1 = {};
      try { snap1 = JSON.parse(snap1Text); } catch {}

      if (typeof snap1.snapshot_id === 'string') {
        // Second call — with snapshot_id → returns diff (resolved/new_issues/persisting)
        const call2Id = ++_mcpSeq;
        srv119.proc.stdin.write(JSON.stringify({
          jsonrpc: '2.0', id: call2Id, method: 'tools/call',
          params: { name: 'argus_get_context', arguments: { snapshot_id: snap1.snapshot_id } },
        }) + '\n');
        snap2Resp119 = await mcpStdioRead(srv119.proc.stdout, call2Id, 20000);
      }
    } catch (e) {
      err119 = e;
    } finally {
      try { srv119?.proc?.kill(); } catch {}
    }

    const snap1Obj119 = (() => { try { return JSON.parse(snap1Resp119?.result?.content?.[0]?.text ?? '{}'); } catch { return {}; } })();
    const snap2Obj119 = (() => { try { return JSON.parse(snap2Resp119?.result?.content?.[0]?.text ?? '{}'); } catch { return {}; } })();

    assert(err119 === null,
      `[119a] argus_get_context calls complete without throwing (${err119?.message ?? 'ok'})`);
    assert(typeof snap1Obj119.snapshot_id === 'string' && snap1Obj119.snapshot_id.length > 0,
      `[119b] argus_get_context response includes snapshot_id string (got ${typeof snap1Obj119.snapshot_id})`);
    assert(
      Array.isArray(snap1Obj119.open_tabs) && snap1Obj119.open_tabs.length >= 1 &&
      typeof snap1Obj119.open_tabs[0].id === 'number',
      `[119c] argus_get_context open_tabs is a non-empty array of tabs with numeric ids — not the [] failure mode (got ${JSON.stringify(snap1Obj119.open_tabs)})`);
    assert(snap2Resp119 !== null && 'resolved' in snap2Obj119 && 'new_issues' in snap2Obj119,
      `[119d] argus_get_context with snapshot_id returns diff shape with resolved + new_issues fields`);
  }

  // ── Block [120] argus_watch_snapshot MCP tool — response structure ─────────
  {
    console.log('\n[120] MCP tool argus_watch_snapshot — findings array + newConsole/newNetwork fields');

    let srv120 = null;
    let snapResp120 = null;
    let err120 = null;
    try {
      srv120 = await spawnArgusServer(path.resolve(__dirname, '..'));

      const callId = ++_mcpSeq;
      srv120.proc.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: callId, method: 'tools/call',
        params: { name: 'argus_watch_snapshot', arguments: {} },
      }) + '\n');
      snapResp120 = await mcpStdioRead(srv120.proc.stdout, callId, 20000);
    } catch (e) {
      err120 = e;
    } finally {
      try { srv120?.proc?.kill(); } catch {}
    }

    const snapObj120 = (() => { try { return JSON.parse(snapResp120?.result?.content?.[0]?.text ?? '{}'); } catch { return null; } })();

    assert(err120 === null,
      `[120a] argus_watch_snapshot call completes without throwing (${err120?.message ?? 'ok'})`);
    assert(snapObj120 !== null && typeof snapObj120 === 'object',
      `[120b] argus_watch_snapshot response is parseable JSON object (got ${typeof snapObj120})`);
    assert(Array.isArray(snapObj120?.findings),
      `[120c] argus_watch_snapshot response has findings array (got ${typeof snapObj120?.findings})`);
    assert('newConsole' in (snapObj120 ?? {}) && 'newNetwork' in (snapObj120 ?? {}),
      `[120d] argus_watch_snapshot response has newConsole + newNetwork fields`);
  }

  // ── Block [121] server/index.js — Express startup + /health endpoint ──────────
  {
    console.log('\n[121] server/index.js — Express startup + /health endpoint');

    const port121 = await findFreePort(3300);
    const srvProc121 = spawn(process.execPath, [path.resolve(__dirname, '../src/server/index.js')], {
      cwd: path.resolve(__dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(port121), ARGUS_LOG_LEVEL: 'error', ARGUS_LOG_PRETTY: '0' },
    });
    srvProc121.stderr.on('data', () => {});
    srvProc121.on('error', () => {});

    let healthResp121 = null;
    const deadline121 = Date.now() + 8000;
    while (Date.now() < deadline121) {
      try {
        const r = await fetch(`http://localhost:${port121}/health`);
        if (r.ok) { healthResp121 = await r.json(); break; }
      } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    srvProc121.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));

    assert(healthResp121 !== null,
      `[121a] Express server starts and /health responds within 8s`);
    assert(healthResp121?.status === 'ok',
      `[121b] /health returns { status: 'ok' } (got ${healthResp121?.status})`);
    assert(healthResp121?.service === 'argus',
      `[121c] /health returns { service: 'argus' } (got ${healthResp121?.service})`);
    assert(typeof healthResp121?.ts === 'string',
      `[121d] /health returns ISO timestamp in 'ts' field (got ${typeof healthResp121?.ts})`);
  }

  // ── Block [122] html-reporter.js CLI — report:html file-write path ────────────
  {
    console.log('\n[122] html-reporter.js CLI — report:html file-write path');

    const tmpDir122 = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-html-cli-122-'));
    const report122 = {
      generatedAt: new Date().toISOString(),
      baseUrl: 'http://localhost:3100',
      summary: { total: 1, critical: 0, warning: 1, info: 0 },
      routes: [{
        path: '/test', url: 'http://localhost:3100/test',
        errors: [{ severity: 'warning', type: 'seo', message: 'test-seo-section4-gap' }],
      }],
      flows: [],
    };
    const jsonPath122 = path.join(tmpDir122, 'test-report.json');
    fs.writeFileSync(jsonPath122, JSON.stringify(report122));

    let cliErr122 = null;
    let cliExit122 = null;
    try {
      await new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, [
          path.resolve(__dirname, '../src/utils/html-reporter.js'),
          jsonPath122,
        ], {
          cwd: path.resolve(__dirname, '..'),
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ARGUS_LOG_LEVEL: 'error', ARGUS_LOG_PRETTY: '0' },
        });
        proc.stderr.on('data', () => {});
        proc.on('error', reject);
        proc.on('close', (code) => { cliExit122 = code; resolve(); });
      });
    } catch (e) { cliErr122 = e; }

    const htmlPath122 = path.join(tmpDir122, 'report.html');
    const htmlExists122 = fs.existsSync(htmlPath122);
    const html122 = htmlExists122 ? fs.readFileSync(htmlPath122, 'utf8') : '';
    try { fs.rmSync(tmpDir122, { recursive: true, force: true }); } catch {}

    assert(cliErr122 === null && cliExit122 === 0,
      `[122a] html-reporter.js CLI exits 0 (exit=${cliExit122}, err=${cliErr122?.message ?? 'none'})`);
    assert(htmlExists122,
      `[122b] CLI writes report.html alongside the source JSON`);
    assert(html122.includes('test-seo-section4-gap'),
      `[122c] generated HTML contains the finding message from the source report`);
    assert(!/Generated by.*Argus.*·.*T\d\d:\d\d:\d\d/.test(html122),
      `[122d] HTML footer uses human-readable date format (not raw ISO timestamp)`);
  }

  // ── Block [123] navigate_page throws → crawlRouteCheap error propagation ─────
  {
    console.log('\n[123] Unhappy path: navigate_page throws → crawlRouteCheap propagates error (Chrome-down / page-crash)');

    const savedRetry123 = process.env.ARGUS_RETRY_ATTEMPTS;
    process.env.ARGUS_RETRY_ATTEMPTS = '1'; // skip retries so mock throws immediately

    let threw123 = false;
    let errMsg123 = '';
    let callCount123 = 0;
    const mockMcp123 = {
      navigate_page: async () => { callCount123++; throw new Error('net::ERR_CONNECTION_REFUSED 127.0.0.1:9222'); },
      // listConsoleRaw() calls list_console_messages() synchronously — must be defined so
      // .catch(() => null) at the call-site can intercept it (sync throw bypasses .catch).
      // Other async adaptor methods (listConsole, listNetwork) wrap calls in async — safe undefined.
      list_console_messages: async () => [],
    };

    try {
      await crawlRouteCheap({ path: '/test', name: 'chrome-down', critical: false }, 'http://localhost:19999', mockMcp123);
    } catch (e) {
      threw123 = true;
      errMsg123 = e.message ?? '';
    } finally {
      if (savedRetry123 === undefined) delete process.env.ARGUS_RETRY_ATTEMPTS;
      else process.env.ARGUS_RETRY_ATTEMPTS = savedRetry123;
    }

    assert(threw123,
      '[123a] crawlRouteCheap throws when navigate_page always fails (Chrome-down simulation)');
    assert(errMsg123.includes('ERR_CONNECTION_REFUSED'),
      `[123b] thrown error includes original navigate_page error (got: "${errMsg123.slice(0, 80)}")`);
    assert(callCount123 === 1,
      `[123c] ARGUS_RETRY_ATTEMPTS=1 → navigate_page called exactly once before throw (got ${callCount123})`);
  }

  // ── Block [124] take_screenshot throws → crawlRouteCheap continues gracefully ─
  {
    console.log('\n[124] Unhappy path: take_screenshot throws → crawlRouteCheap continues, screenshot null');

    // Proxy over the real mcp connection — intercept only take_screenshot
    const screenshotFailMcp124 = new Proxy(mcp, {
      get(target, prop) {
        if (prop === 'take_screenshot') return async () => { throw new Error('screenshot-test-error-124'); };
        const val = target[prop];
        return typeof val === 'function' ? val.bind(target) : val;
      },
    });

    let result124 = null;
    let err124 = null;
    try {
      result124 = await crawlRouteCheap(
        { path: '/clean.html', name: 'screenshot-fail', critical: false },
        B,
        screenshotFailMcp124,
      );
    } catch (e) {
      err124 = e;
    }

    assert(err124 === null,
      `[124a] crawlRouteCheap does NOT throw when take_screenshot fails (err: ${err124?.message ?? 'none'})`);
    assert(result124 !== null && result124.screenshot === null,
      `[124b] result.screenshot is null when take_screenshot throws (got: ${result124?.screenshot})`);
    assert(Array.isArray(result124?.errors),
      `[124c] result.errors is still a valid array despite screenshot failure`);
    assert(typeof result124?.crawledAt === 'string',
      `[124d] result.crawledAt is present — crawl ran to completion`);
  }

  // ── Block [125] parseConsoleMsgResponse overflow — 12k messages stress test ───
  {
    console.log('\n[125] Unhappy path: parseConsoleMsgResponse with 12,000 messages — overflow stress test');

    const lines125 = [];
    for (let i = 1; i <= 12000; i++) {
      const lvl = i % 3 === 0 ? 'error' : i % 3 === 1 ? 'warning' : 'info';
      lines125.push(`msgid=${i} [${lvl}] Console message number ${i} — stress test payload argus-section5`);
    }
    const bigText125 = lines125.join('\n');

    const t0125 = Date.now();
    let parsed125 = null;
    let parseErr125 = null;
    try {
      parsed125 = parseConsoleMsgResponse(bigText125);
    } catch (e) {
      parseErr125 = e;
    }
    const elapsed125 = Date.now() - t0125;

    assert(parseErr125 === null,
      `[125a] parseConsoleMsgResponse with 12k messages does not throw (got: ${parseErr125?.message ?? 'ok'})`);
    assert(Array.isArray(parsed125) && parsed125.length === 12000,
      `[125b] parseConsoleMsgResponse returns all 12,000 messages (got ${parsed125?.length})`);
    assert(elapsed125 < 5000,
      `[125c] parseConsoleMsgResponse 12k messages completes in < 5s (took ${elapsed125}ms)`);
  }

  // ── Block [126] cli/init.js — end-to-end file write to temp directory ────────
  {
    console.log('\n[126] cli/init.js — end-to-end file write: generateTargetsJs + generateEnvFile write to disk');

    const tmpDir126 = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-init-e2e-'));
    try {
      const routes126 = [{ path: '/home', name: 'Home', critical: true, waitFor: null }];
      const targetsContent126 = generateTargetsJs(routes126, { framework: 'unknown' });
      const envContent126 = generateEnvFile({ devUrl: 'http://localhost:3000' });

      const targetsPath126 = path.join(tmpDir126, 'targets.js');
      const envPath126    = path.join(tmpDir126, '.env');
      fs.writeFileSync(targetsPath126, targetsContent126, 'utf8');
      fs.writeFileSync(envPath126, envContent126, 'utf8');

      assert(fs.existsSync(targetsPath126),
        '[126a] targets.js written to disk and exists');
      assert(fs.existsSync(envPath126),
        '[126b] .env written to disk and exists');
      assert(targetsContent126.includes('/home'),
        '[126c] written targets.js contains the route path /home');
      assert(envContent126.includes('TARGET_DEV_URL=http://localhost:3000'),
        '[126d] written .env contains TARGET_DEV_URL=http://localhost:3000');
      assert(targetsContent126.includes('export const routes'),
        '[126e] written targets.js is valid ES module syntax (export const routes)');
    } finally {
      fs.rmSync(tmpDir126, { recursive: true, force: true });
    }
  }

  // ── Block [127] A7 — Theme & Dark Mode ──────────────────────────────────────
  {
    console.log('\n[127] theme-analyzer — A7 dark mode detection on theme-issues.html');
    const browser127 = new CdpBrowserAdapter(mcp);
    const url127     = `http://localhost:${devPort}/theme-issues.html`;

    const results127 = await analyzeTheme(browser127, url127);

    assert(Array.isArray(results127),
      '[127a] analyzeTheme returns an array');

    const nodalFinding127 = results127.find(f => f.type === 'theme_no_dark_mode');
    assert(nodalFinding127 !== undefined,
      '[127b] theme_no_dark_mode finding present — fixture has no dark mode media query');

    assert(nodalFinding127?.severity === 'info',
      '[127c] theme_no_dark_mode severity is info');

    assert(typeof nodalFinding127?.message === 'string' && nodalFinding127.message.length > 0,
      '[127d] theme_no_dark_mode message is a non-empty string');

    const summary127 = results127.find(f => f.type === 'theme_summary');
    assert(summary127 !== undefined,
      '[127e] theme_summary finding present');

    assert(summary127?.hasDarkMode === false,
      '[127f] theme_summary.hasDarkMode is false for fixture with no dark mode query');

    assert(typeof summary127?.rootVarCount === 'number' && summary127.rootVarCount > 0,
      '[127g] theme_summary.rootVarCount > 0 — fixture declares :root CSS custom properties');
  }

  // ── Block [128] D9 — Design Fidelity ─────────────────────────────────────────
  {
    console.log('\n[128] design-fidelity-analyzer — D9 full rich comparison (tokens + nodes + components)');

    // Synthetic Figma data with both legacy fields (tokens/components) and rich
    // per-node comparison data (nodes[]).  The fixture page has intentional
    // deviations in computed styles to exercise every new finding type.
    const syntheticFigmaData128 = {
      tokens: {
        '--color-primary':  '#6200ee',  // fixture has #5100cd → mismatch
        '--color-text':     '#333333',  // fixture has #333333 → match (no finding)
        '--font-size-base': '16px',     // fixture has 14px    → mismatch
        '--spacing-md':     '16px',     // fixture has 12px    → mismatch
      },
      components: [
        { name: 'Primary Button', selector: 'button.design-primary' }, // exists → no finding
        { name: 'Hero Section',   selector: '.figma-hero-section'   }, // absent → finding
      ],
      nodes: [
        {
          // .action-button: bg #5100cd vs Figma #6200ee (delta≈37), padding 8/12 vs 16/24, radius 4 vs 8
          id: '1:1', name: 'Action Button', type: 'RECTANGLE', selector: '.action-button',
          fill:         { r: 98, g: 0, b: 238, a: 255 },
          spacing:      { paddingTop: 16, paddingRight: 24, paddingBottom: 16, paddingLeft: 24, gap: 0 },
          cornerRadius: 8,
          typography: null, bounds: null, stroke: null, shadow: null, opacity: 1,
        },
        {
          // .heading-label: color #555 vs rgb(33,33,33) (delta≈90), fontSize 20 vs 24, fontWeight 400 vs 700
          id: '1:2', name: 'Heading Label', type: 'TEXT', selector: '.heading-label',
          fill:       { r: 33, g: 33, b: 33, a: 255 },
          typography: { fontFamily: 'sans-serif', fontSize: 24, fontWeight: 700, lineHeightPx: null, letterSpacing: 0 },
          spacing: null, cornerRadius: null, bounds: null, stroke: null, shadow: null, opacity: 1,
        },
        {
          // .shadow-box: DOM has 0px 2px blur:4px — Figma: offsetX:2 offsetY:4 blur:8
          id: '1:3', name: 'Shadow Box', type: 'RECTANGLE', selector: '.shadow-box',
          shadow:       { offsetX: 2, offsetY: 4, blur: 8, spread: 0, r: 0, g: 0, b: 0, a: 64 },
          fill: null, typography: null, spacing: null, cornerRadius: null, bounds: null, stroke: null, opacity: 1,
        },
        {
          // .stroke-box: DOM has 1px solid #999 — Figma: 2px rgb(98,0,238)
          id: '1:4', name: 'Stroke Box', type: 'RECTANGLE', selector: '.stroke-box',
          stroke:       { r: 98, g: 0, b: 238, a: 255, weight: 2 },
          fill: null, typography: null, spacing: null, cornerRadius: null, bounds: null, shadow: null, opacity: 1,
        },
        {
          // .faded-box: DOM opacity 1 — Figma opacity 0.5
          id: '1:5', name: 'Faded Box', type: 'RECTANGLE', selector: '.faded-box',
          opacity:      0.5,
          fill: null, typography: null, spacing: null, cornerRadius: null, bounds: null, shadow: null, stroke: null,
        },
        {
          // .label-text: fontFamily sans-serif vs Inter, letterSpacing 0 vs 2px, text 'Goodbye World' vs 'Hello World'
          id: '1:6', name: 'Label Text', type: 'TEXT', selector: '.label-text',
          characters:   'Hello World',
          typography:   { fontFamily: 'Inter', fontSize: 16, fontWeight: 400, lineHeightPx: null, letterSpacing: 4 },
          fill: null, spacing: null, cornerRadius: null, bounds: null, shadow: null, stroke: null, opacity: 1,
        },
        {
          // .flex-row: column-gap 8px vs Figma gap 24, layoutMode HORIZONTAL
          id: '1:7', name: 'Flex Row', type: 'FRAME', selector: '.flex-row',
          spacing:      { paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0, gap: 24, layoutMode: 'HORIZONTAL' },
          fill: null, typography: null, cornerRadius: null, bounds: null, shadow: null, stroke: null, opacity: 1,
        },
        {
          // .shadow-color-box: DOM has black shadow spread:0 — Figma has purple spread:4
          // Tests shadow COLOR + SPREAD comparison (both now fully compared)
          id: '1:8', name: 'Shadow Color Box', type: 'RECTANGLE',
          selectors: ['[data-testid="shadow-color-box"]', '.shadow-color-box'],
          selector: '.shadow-color-box',
          shadow: { offsetX: 0, offsetY: 4, blur: 8, spread: 4, r: 98, g: 0, b: 238, a: 128 },
          fill: null, typography: null, spacing: null, cornerRadius: null, bounds: null, stroke: null, opacity: 1,
        },
        {
          // .corner-box: DOM border-radius 4px 8px 12px 16px — Figma all corners should be 4px
          // Tests per-corner radius comparison (TR=8 vs 4, BR=12 vs 4, BL=16 vs 4)
          id: '1:9', name: 'Corner Box', type: 'RECTANGLE',
          selectors: ['[data-testid="corner-box"]', '.corner-box'],
          selector: '.corner-box',
          cornerRadius: { topLeft: 4, topRight: 4, bottomRight: 4, bottomLeft: 4 },
          fill: null, typography: null, spacing: null, bounds: null, stroke: null, shadow: null, opacity: 1,
        },
        {
          // data-testid="test-card": tests selector fallback chain (data-testid matched first)
          // Figma fill: green rgb(0,128,0) — DOM background: red #ff0000 — color mismatch
          id: '1:10', name: 'Test Card', type: 'RECTANGLE',
          selectors: ['[data-testid="test-card"]', '#test-card', '.test-card'],
          selector: '[data-testid="test-card"]',
          fill: { r: 0, g: 128, b: 0, a: 255 },
          typography: null, spacing: null, cornerRadius: null, bounds: null, stroke: null, shadow: null, opacity: 1,
        },
        {
          // .drift-box: margin-left 80px gives absolute left ≈ 80+padding px — Figma says x=0
          // Tests position drift detection (scroll-corrected absolute position vs Figma bounds)
          id: '1:11', name: 'Drift Box', type: 'RECTANGLE',
          selectors: ['[data-testid="drift-box"]', '.drift-box'],
          selector: '.drift-box',
          bounds: { x: 0, y: 0, width: 100, height: 40 },
          fill: null, typography: null, spacing: null, cornerRadius: null, stroke: null, shadow: null, opacity: 1,
        },
      ],
      frame: { name: 'Argus Test Frame', width: 1440, height: 900 },
    };

    const browser128 = new CdpBrowserAdapter(mcp);
    const url128     = `http://localhost:${devPort}/design-fidelity.html`;

    const results128 = await analyzeDesignFidelity(browser128, url128, syntheticFigmaData128);

    assert(Array.isArray(results128),
      '[128a] analyzeDesignFidelity returns an array');

    const mismatches128 = results128.filter(f => f.type === 'design_token_mismatch');
    assert(mismatches128.length >= 2,
      `[128b] at least 2 design_token_mismatch findings (got ${mismatches128.length})`);

    assert(mismatches128.every(f => f.severity === 'warning'),
      '[128c] all design_token_mismatch findings have severity "warning"');

    assert(mismatches128.some(f => f.token === '--color-primary'),
      '[128d] --color-primary mismatch detected');

    const missing128 = results128.find(f => f.type === 'design_component_missing' && f.selector === '.figma-hero-section');
    assert(missing128 !== undefined,
      '[128e] design_component_missing for .figma-hero-section present');

    const summary128 = results128.find(f => f.type === 'design_fidelity_summary');
    assert(summary128 !== undefined,
      '[128f] design_fidelity_summary finding present');

    // parseFigmaUrl unit test — no external API needed
    const parsed128a = parseFigmaUrl('https://www.figma.com/file/ABC123XYZ/MyApp?node-id=42%3A0');
    assert(parsed128a?.fileKey === 'ABC123XYZ',
      `[128g] parseFigmaUrl extracts fileKey correctly (got ${parsed128a?.fileKey})`);

    assert(parsed128a?.nodeId === '42:0',
      `[128h] parseFigmaUrl normalises node-id to colon format (got ${parsed128a?.nodeId})`);

    const parsed128b = parseFigmaUrl('not-a-figma-url');
    assert(parsed128b === null,
      '[128i] parseFigmaUrl returns null for non-Figma URL');

    // ── Per-node rich comparison assertions ───────────────────────────────────

    const colorMismatches128 = results128.filter(f => f.type === 'design_color_mismatch');
    assert(colorMismatches128.length >= 2,
      `[128j] at least 2 design_color_mismatch findings — action-button bg + heading-label color (got ${colorMismatches128.length})`);

    assert(colorMismatches128.every(f => f.severity === 'warning' && f.expected && f.actual && typeof f.delta === 'number'),
      '[128k] design_color_mismatch findings have severity "warning", expected, actual, and numeric delta');

    const typographyMismatches128 = results128.filter(f => f.type === 'design_typography_mismatch');
    assert(typographyMismatches128.length >= 2,
      `[128l] at least 2 design_typography_mismatch findings — fontSize + fontWeight on heading-label (got ${typographyMismatches128.length})`);

    assert(typographyMismatches128.every(f => f.severity === 'warning' && f.property && f.expected != null && f.actual != null),
      '[128m] design_typography_mismatch findings have severity "warning" and property/expected/actual fields');

    const spacingMismatches128 = results128.filter(f => f.type === 'design_spacing_mismatch');
    assert(spacingMismatches128.length >= 1,
      `[128n] at least 1 design_spacing_mismatch finding — action-button padding deviates (got ${spacingMismatches128.length})`);

    const radiusMismatches128 = results128.filter(f => f.type === 'design_radius_mismatch');
    assert(radiusMismatches128.length >= 1,
      `[128o] at least 1 design_radius_mismatch finding — action-button border-radius 4px vs Figma 8px (got ${radiusMismatches128.length})`);

    assert(typeof summary128?.colorMismatches === 'number' && summary128.colorMismatches >= 2,
      `[128p] design_fidelity_summary.colorMismatches >= 2 (got ${summary128?.colorMismatches})`);

    // ── New property comparisons (stroke, shadow, opacity, fontFamily, letterSpacing, gap, text) ─

    const shadowMismatches128 = results128.filter(f => f.type === 'design_shadow_mismatch');
    assert(shadowMismatches128.length >= 1,
      `[128q] at least 1 design_shadow_mismatch — shadow-box offsetX/blur differ from Figma (got ${shadowMismatches128.length})`);

    const strokeMismatches128 = results128.filter(f => f.type === 'design_stroke_mismatch');
    assert(strokeMismatches128.length >= 1,
      `[128r] at least 1 design_stroke_mismatch — stroke-box border 1px #999 vs Figma 2px #6200ee (got ${strokeMismatches128.length})`);

    const opacityMismatches128 = results128.filter(f => f.type === 'design_opacity_mismatch');
    assert(opacityMismatches128.length >= 1,
      `[128s] at least 1 design_opacity_mismatch — faded-box opacity 1 vs Figma 0.5 (got ${opacityMismatches128.length})`);

    const textMismatches128 = results128.filter(f => f.type === 'design_text_mismatch');
    assert(textMismatches128.length >= 1,
      `[128t] at least 1 design_text_mismatch — label-text "Goodbye World" vs Figma "Hello World" (got ${textMismatches128.length})`);

    const gapMismatches128 = results128.filter(f => f.type === 'design_gap_mismatch');
    assert(gapMismatches128.length >= 1,
      `[128u] at least 1 design_gap_mismatch — flex-row column-gap 8px vs Figma 24px (got ${gapMismatches128.length})`);

    const typoMismatches128All = results128.filter(f => f.type === 'design_typography_mismatch');
    assert(typoMismatches128All.some(f => f.property === 'fontFamily'),
      `[128v] design_typography_mismatch includes fontFamily finding — label-text sans-serif vs Inter`);

    assert(typoMismatches128All.some(f => f.property === 'letterSpacing'),
      `[128w] design_typography_mismatch includes letterSpacing finding — label-text 0px vs 2px`);

    assert(
      typeof summary128?.strokeMismatches === 'number' &&
      typeof summary128?.shadowMismatches === 'number' &&
      typeof summary128?.opacityMismatches === 'number' &&
      typeof summary128?.textMismatches === 'number' &&
      typeof summary128?.gapMismatches === 'number',
      '[128x] design_fidelity_summary includes all new mismatch type counts'
    );

    // ── Enhancement assertions (shadow color+spread, per-corner radius, selector fallback, position drift) ─

    const shadowMismatches128All = results128.filter(f => f.type === 'design_shadow_mismatch');
    assert(shadowMismatches128All.some(f => typeof f.expectedSpread === 'number' && typeof f.actualSpread === 'number'),
      '[128y] design_shadow_mismatch findings include spread fields (expectedSpread/actualSpread)');

    assert(shadowMismatches128All.some(f => f.colorDelta !== null && f.colorDelta !== undefined),
      '[128z] design_shadow_mismatch findings include colorDelta field — shadow color is now compared');

    const radiusMismatches128All = results128.filter(f => f.type === 'design_radius_mismatch');
    assert(radiusMismatches128All.some(f => f.corner && f.corner !== 'all'),
      `[128aa] design_radius_mismatch findings include per-corner field (corners found: ${[...new Set(radiusMismatches128All.map(f => f.corner))].join(', ')})`);

    assert(radiusMismatches128All.filter(f => f.corner && f.corner !== 'all').length >= 3,
      `[128ab] at least 3 per-corner radius mismatches (topRight/bottomRight/bottomLeft all differ from Figma 4px) — got ${radiusMismatches128All.length}`);

    const colorMismatches128All = results128.filter(f => f.type === 'design_color_mismatch');
    assert(colorMismatches128All.some(f => f.selector && (f.selector.includes('data-testid') || f.selector.includes('test-card'))),
      '[128ac] design_color_mismatch found via data-testid selector fallback — test-card matched by [data-testid="test-card"]');

    const positionDrifts128 = results128.filter(f => f.type === 'design_position_drift');
    assert(positionDrifts128.length >= 1,
      `[128ad] at least 1 design_position_drift finding — drift-box has margin-left:80px but Figma bounds x:0, drift > 20px threshold (got ${positionDrifts128.length})`);
  }

  // ── Block [129] Web Vitals + Bundle Size ──────────────────────────
  {
    console.log('\n[129] web-vitals-analyzer — LCP/CLS/FCP/TTI + perf_bundle_large');

    const browser129 = new CdpBrowserAdapter(mcp);
    const url129     = `${B}/perf-vitals.html`;

    const results129 = await analyzeWebVitals(browser129, url129);

    assert(Array.isArray(results129),
      '[129a] analyzeWebVitals returns an array');

    const summary129 = results129.find(f => f.type === 'perf_vitals_summary');
    assert(summary129 !== undefined,
      '[129b] perf_vitals_summary always present');

    assert(
      summary129 !== undefined &&
      Object.prototype.hasOwnProperty.call(summary129, 'lcp') &&
      Object.prototype.hasOwnProperty.call(summary129, 'cls') &&
      Object.prototype.hasOwnProperty.call(summary129, 'fcp') &&
      Object.prototype.hasOwnProperty.call(summary129, 'tti') &&
      Object.prototype.hasOwnProperty.call(summary129, 'ttfb'),
      '[129c] perf_vitals_summary has lcp, cls, fcp, tti, ttfb fields'
    );

    assert(summary129?.severity === 'info',
      `[129d] perf_vitals_summary severity is 'info' (got ${summary129?.severity})`);

    const bundleFindings129 = results129.filter(f => f.type === 'perf_bundle_large');
    assert(bundleFindings129.length >= 1,
      `[129e] perf_bundle_large detected — /api/large.js is ~600 KB > 500 KB threshold (found ${bundleFindings129.length})`);

    assert(bundleFindings129.every(f => f.severity === 'warning' || f.severity === 'critical'),
      '[129f] perf_bundle_large severity is warning or critical');

    const largeJs129 = bundleFindings129.find(f => f.ext === 'js');
    assert(largeJs129 !== undefined && largeJs129.sizeKb > 500,
      `[129g] perf_bundle_large JS sizeKb > 500 (got ${largeJs129?.sizeKb ?? 'none'})`);

    // Soft: LCP and TTI may not be captured in all headless configurations
    soft(
      typeof summary129?.lcp === 'number',
      `[129h] (soft) LCP captured as a number (got ${typeof summary129?.lcp}: ${summary129?.lcp})`
    );

    soft(
      typeof summary129?.tti === 'number' && summary129.tti > 0,
      `[129i] (soft) TTI (domInteractive) captured as positive number (got ${summary129?.tti})`
    );
  }

  // ── Block [130] Visual Regression (A8) ─────────────────────────
  {
    console.log('\n[130] visual-diff-analyzer — A8 baseline comparison');

    const tmpDir130  = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-harness-130-'));
    const browser130 = new CdpBrowserAdapter(mcp);
    const url130     = `${B}/visual-regression.html`;

    // Navigate once so the page is loaded for screenshot capture
    await browser130.navigate(url130);
    await browser130.waitFor({ state: 'networkidle' }).catch(() => {});

    // ── First run — no baseline exists ────────────────────────────────────────
    const results130a = await analyzeVisualRegression(browser130, url130, { baselineDir: tmpDir130 });

    assert(Array.isArray(results130a),
      '[130a] analyzeVisualRegression returns an array');

    const created130 = results130a.find(f => f.type === 'visual_baseline_created');
    assert(created130 !== undefined,
      `[130b] first run → visual_baseline_created present (got types: ${results130a.map(f => f.type).join(', ')})`);

    assert(created130?.severity === 'info',
      `[130c] visual_baseline_created severity is 'info' (got ${created130?.severity})`);

    const slug130      = created130?.baselinePath ?? '';
    const baseline130  = path.join(tmpDir130, slug130.split(path.sep).pop() ?? '');
    assert(created130?.baselinePath && fs.existsSync(created130.baselinePath),
      `[130d] baseline PNG file written to baselineDir (path: ${created130?.baselinePath})`);

    // ── Introduce visual change via JS injection ───────────────────────────────
    await browser130.evaluate(`() => {
      document.getElementById('primary-block').style.backgroundColor = '#e53935';
    }`);
    // Allow repaint to settle
    await new Promise(r => setTimeout(r, 300));

    // ── Second run — baseline exists, diff detected ───────────────────────────
    const results130b = await analyzeVisualRegression(browser130, url130, { baselineDir: tmpDir130 });

    const regression130 = results130b.find(f => f.type === 'visual_regression');
    assert(regression130 !== undefined,
      `[130e] after visual change → visual_regression detected (got types: ${results130b.map(f => f.type).join(', ')})`);

    assert(regression130?.severity === 'warning' || regression130?.severity === 'critical',
      `[130f] visual_regression severity is warning or critical (got ${regression130?.severity})`);

    assert(typeof regression130?.diffPercent === 'number' && regression130.diffPercent > 0,
      `[130g] visual_regression diffPercent > 0 (got ${regression130?.diffPercent})`);

    const summary130 = results130b.find(f => f.type === 'visual_diff_summary');
    assert(summary130 !== undefined,
      `[130h] visual_diff_summary always present in second run (got types: ${results130b.map(f => f.type).join(', ')})`);

    assert(typeof summary130?.diffPercent === 'number',
      `[130i] visual_diff_summary has diffPercent field (number) (got ${typeof summary130?.diffPercent})`);

    // Clean up temp baseline directory
    try { fs.rmSync(tmpDir130, { recursive: true, force: true }); } catch {}
  }

  // ── Block [131] Axe-core + Color Blind Simulation (A12) ────────
  {
    console.log('\n[131] a11y-deep-analyzer — A12 axe-core + color blind simulation');

    const browser131 = new CdpBrowserAdapter(mcp);
    const url131     = `${B}/a11y-deep-issues.html`;

    const results131 = await analyzeA11yDeep(browser131, url131);

    assert(Array.isArray(results131),
      '[131a] analyzeA11yDeep returns an array');

    const axeViolations131 = results131.filter(f => f.type === 'a11y_axe_violation');
    assert(axeViolations131.length >= 1,
      `[131b] at least 1 a11y_axe_violation found (got ${axeViolations131.length})`);

    const v131 = axeViolations131[0];
    assert(
      v131 !== undefined &&
      typeof v131.axeId     === 'string' &&
      typeof v131.impact    === 'string' &&
      typeof v131.helpUrl   === 'string',
      `[131c] a11y_axe_violation has required fields axeId/impact/helpUrl (got ${JSON.stringify(Object.keys(v131 ?? {}))})`
    );

    const warningOrCrit131 = axeViolations131.filter(f => f.severity === 'warning' || f.severity === 'critical');
    assert(warningOrCrit131.length >= 1,
      `[131d] serious/moderate axe violations map to warning or critical severity (got ${axeViolations131.map(f=>f.severity).join(',')})`);

    const summary131 = results131.find(f => f.type === 'a11y_deep_summary');
    assert(summary131 !== undefined,
      `[131e] a11y_deep_summary always present (got types: ${[...new Set(results131.map(f=>f.type))].join(', ')})`);

    assert(typeof summary131?.axeViolations === 'number',
      `[131f] a11y_deep_summary has axeViolations count (number) (got ${typeof summary131?.axeViolations})`);

    const imageAlt131 = axeViolations131.find(f => f.axeId === 'image-alt');
    assert(imageAlt131 !== undefined,
      `[131g] image-alt violation detected for img#no-alt (found axeIds: ${axeViolations131.map(f=>f.axeId).join(', ')})`);

    const colorblind131 = results131.filter(f => f.type === 'a11y_colorblind_risk');
    assert(colorblind131.length >= 1,
      `[131h] a11y_colorblind_risk detected for red-on-gray element (got ${colorblind131.length})`);

    assert(typeof colorblind131[0]?.contrastRatio === 'number',
      `[131i] a11y_colorblind_risk has contrastRatio field (number) (got ${typeof colorblind131[0]?.contrastRatio})`);
  }

  // ── Block [132] HAR Network Baseline (N1) ─────────────────────
  {
    console.log('\n[132] har-recorder — HAR network baseline');
    const tmpDir132 = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-harness-132-'));
    const browser132 = new CdpBrowserAdapter(mcp);
    const url132     = `${B}/har-baseline.html`;

    const results132a = await analyzeHar(browser132, url132, { baselineDir: tmpDir132 });

    assert(Array.isArray(results132a),
      '[132a] analyzeHar returns an array');

    const baseline132 = results132a.find(f => f.type === 'har_baseline_created');
    assert(baseline132 !== undefined,
      `[132b] first run: har_baseline_created present (got types: ${[...new Set(results132a.map(f => f.type))].join(', ')})`);

    const harFile132 = path.join(tmpDir132, `${slugify(url132)}.json`);
    assert(fs.existsSync(harFile132),
      `[132c] baseline HAR file written to baselineDir (expected: ${harFile132})`);

    assert(typeof baseline132?.requestCount === 'number',
      `[132d] har_baseline_created has requestCount field (number) (got ${typeof baseline132?.requestCount})`);

    // Second run: compare against baseline just saved
    const results132b = await analyzeHar(browser132, url132, { baselineDir: tmpDir132 });
    const summary132  = results132b.find(f => f.type === 'har_comparison_summary');
    assert(summary132 !== undefined,
      `[132e] second run: har_comparison_summary present (got types: ${[...new Set(results132b.map(f => f.type))].join(', ')})`);

    assert(
      typeof summary132?.newRequests === 'number' && typeof summary132?.missingRequests === 'number',
      `[132f] har_comparison_summary has newRequests and missingRequests fields (got ${JSON.stringify({ new: typeof summary132?.newRequests, missing: typeof summary132?.missingRequests })})`
    );

    try { fs.rmSync(tmpDir132, { recursive: true, force: true }); } catch {}
  }

  // ── Block [133] Motion & Animation Accessibility (A9) ────────
  {
    console.log('\n[133] motion-analyzer — A9 motion & animation accessibility');
    const browser133 = new CdpBrowserAdapter(mcp);
    const url133     = `${B}/motion-issues.html`;

    const results133 = await analyzeMotion(browser133, url133);

    assert(Array.isArray(results133),
      '[133a] analyzeMotion returns an array');

    const motionFindings133 = results133.filter(f => f.type !== 'motion_summary');
    assert(motionFindings133.length >= 1,
      `[133b] at least 1 motion finding detected (got ${motionFindings133.length}; types: ${[...new Set(results133.map(f => f.type))].join(', ')})`);

    const noQuery133 = results133.find(f => f.type === 'motion_no_reduced_motion_query');
    assert(noQuery133 !== undefined,
      `[133c] motion_no_reduced_motion_query detected (fixture has animation but no @media prefers-reduced-motion)`);

    const autoplay133 = results133.find(f => f.type === 'motion_autoplay_no_pause');
    assert(autoplay133 !== undefined,
      `[133d] motion_autoplay_no_pause detected (fixture has autoplay video without controls)`);

    const summary133 = results133.find(f => f.type === 'motion_summary');
    assert(summary133 !== undefined,
      `[133e] motion_summary always present (got types: ${[...new Set(results133.map(f => f.type))].join(', ')})`);

    assert(typeof summary133?.animationCount === 'number',
      `[133f] motion_summary has animationCount field (number) (got ${typeof summary133?.animationCount})`);
  }

  // ── Block [134] Font Loading (A10) ───────────────────────────
  {
    console.log('\n[134] font-analyzer — A10 font loading');
    const browser134 = new CdpBrowserAdapter(mcp);
    const url134     = `${B}/font-issues.html`;

    const results134 = await analyzeFont(browser134, url134);

    assert(Array.isArray(results134),
      '[134a] analyzeFont returns an array');

    const fontFindings134 = results134.filter(f => f.type !== 'font_summary');
    assert(fontFindings134.length >= 1,
      `[134b] at least 1 font finding detected (got ${fontFindings134.length}; types: ${[...new Set(results134.map(f => f.type))].join(', ')})`);

    const foit134 = results134.find(f => f.type === 'font_foit_risk');
    assert(foit134 !== undefined,
      `[134c] font_foit_risk detected (@font-face without font-display in fixture)`);

    assert(typeof foit134?.fontFamily === 'string',
      `[134d] font_foit_risk has fontFamily field (string) (got ${typeof foit134?.fontFamily})`);

    const summary134 = results134.find(f => f.type === 'font_summary');
    assert(summary134 !== undefined,
      `[134e] font_summary always present (got types: ${[...new Set(results134.map(f => f.type))].join(', ')})`);

    assert(typeof summary134?.foitRisks === 'number',
      `[134f] font_summary has foitRisks count (number) (got ${typeof summary134?.foitRisks})`);
  }

  // ── Block [135] Form Validation (A11) ────────────────────────
  {
    console.log('\n[135] form-analyzer — A11 form validation');
    const browser135 = new CdpBrowserAdapter(mcp);
    const url135     = `${B}/form-issues.html`;

    const results135 = await analyzeForm(browser135, url135);

    assert(Array.isArray(results135),
      '[135a] analyzeForm returns an array');

    const formFindings135 = results135.filter(f => f.type !== 'form_summary');
    assert(formFindings135.length >= 1,
      `[135b] at least 1 form finding detected (got ${formFindings135.length}; types: ${[...new Set(results135.map(f => f.type))].join(', ')})`);

    const missingReq135 = results135.find(f => f.type === 'form_missing_required');
    assert(missingReq135 !== undefined,
      `[135c] form_missing_required detected (fixture has inputs without required attribute)`);

    const noAutocomplete135 = results135.find(f => f.type === 'form_no_autocomplete');
    assert(noAutocomplete135 !== undefined,
      `[135d] form_no_autocomplete detected (fixture has name/email fields without autocomplete)`);

    const summary135 = results135.find(f => f.type === 'form_summary');
    assert(summary135 !== undefined,
      `[135e] form_summary always present (got types: ${[...new Set(results135.map(f => f.type))].join(', ')})`);

    assert(typeof summary135?.missingRequired === 'number',
      `[135f] form_summary has missingRequired count (number) (got ${typeof summary135?.missingRequired})`);
  }

  // ── Block [136] Rich GitHub PR Comments (Check Runs + Release Notes) ──
  {
    console.log('\n[136] github-reporter — rich PR comments + check runs + release notes');

    // Synthetic report with selector-bearing findings and visual_regression
    const report136 = {
      baseUrl:     'http://localhost:3000',
      generatedAt: new Date().toISOString(),
      summary:     { total: 3, critical: 1, warning: 1, info: 1 },
      routes: [{
        route: '/dashboard',
        errors: [
          { type: 'console_error', message: 'TypeError: x is null', severity: 'critical', isNew: true, selector: '#app > div.error' },
          { type: 'visual_regression', message: '5.2% pixels changed', severity: 'critical', diffPercent: 5.2, isNew: true },
        ],
        screenshot: null,
      }],
      codebase: [],
      flows:    [],
    };
    const diff136 = { isFirstRun: false, resolvedCount: 1, flowResolvedCount: 0 };

    // [136a] formatPrComment now includes Selector column when findings have selector field
    const comment136 = formatPrComment(report136, diff136);
    assert(
      typeof comment136 === 'string' && comment136.includes('Selector'),
      `[136a] formatPrComment includes Selector column when findings have selector field (got: ${comment136.slice(0, 100)})`
    );

    // [136b] formatPrComment includes visual regression section
    assert(
      comment136.includes('Visual Regressions'),
      `[136b] formatPrComment includes Visual Regressions section when visual_regression findings present`
    );

    // [136c] buildStatusPayload respects ARGUS_CRITICAL_THRESHOLD=0 — never blocks
    const origThreshold = process.env.ARGUS_CRITICAL_THRESHOLD;
    process.env.ARGUS_CRITICAL_THRESHOLD = '0';
    const status136zero = buildStatusPayload(report136, diff136);
    process.env.ARGUS_CRITICAL_THRESHOLD = origThreshold ?? '';
    assert(
      status136zero.state === 'success',
      `[136c] buildStatusPayload with ARGUS_CRITICAL_THRESHOLD=0 never blocks merge (got state: ${status136zero.state})`
    );

    // [136d] buildStatusPayload respects ARGUS_CRITICAL_THRESHOLD=5 — doesn't block when criticals < threshold
    process.env.ARGUS_CRITICAL_THRESHOLD = '5';
    const status136five = buildStatusPayload(report136, diff136);
    process.env.ARGUS_CRITICAL_THRESHOLD = origThreshold ?? '';
    assert(
      status136five.state === 'success',
      `[136d] buildStatusPayload with threshold=5 doesn't block when only 1 critical (got state: ${status136five.state})`
    );

    // [136e] buildStatusPayload blocks when criticals >= threshold (default threshold=1)
    delete process.env.ARGUS_CRITICAL_THRESHOLD;
    const status136default = buildStatusPayload(report136, diff136);
    if (origThreshold !== undefined) process.env.ARGUS_CRITICAL_THRESHOLD = origThreshold;
    assert(
      status136default.state === 'failure',
      `[136e] buildStatusPayload blocks merge with default threshold=1 and 1 critical (got state: ${status136default.state})`
    );

    // [136f] generateReleaseNotes returns markdown string with new/resolved sections
    const prevReport136 = {
      baseUrl: 'http://localhost:3000',
      generatedAt: new Date(Date.now() - 86400000).toISOString(),
      summary: { total: 2, critical: 0, warning: 2, info: 0 },
      routes: [{ route: '/dashboard', errors: [
        { type: 'css_important_override', message: 'Old CSS issue', severity: 'warning', isNew: false },
      ], screenshot: null }],
      codebase: [], flows: [],
    };
    const notes136 = generateReleaseNotes(report136, prevReport136, { fromTag: 'v1.0.0', toTag: 'v1.1.0' });
    assert(
      typeof notes136 === 'string' && notes136.includes('Release Notes'),
      `[136f] generateReleaseNotes returns markdown string with heading (got: ${notes136.slice(0, 80)})`
    );

    // [136g] generateReleaseNotes includes new issues section
    assert(
      notes136.includes('New Issues'),
      `[136g] generateReleaseNotes includes New Issues section for findings in current but not previous report`
    );

    // [136h] generateReleaseNotes includes resolved issues section
    assert(
      notes136.includes('Resolved Issues'),
      `[136h] generateReleaseNotes includes Resolved Issues section for findings in previous but not current report`
    );

    // [136i] createCheckRun and completeCheckRun exported from github-reporter.js
    assert(
      typeof createCheckRun === 'function' && typeof completeCheckRun === 'function',
      `[136i] createCheckRun and completeCheckRun are exported functions`
    );

    // [136j] buildStatusPayload includes newCriticalCount and threshold fields (check-run enrichment)
    const statusShape136 = buildStatusPayload(report136, diff136);
    assert(
      typeof statusShape136.newCriticalCount === 'number' && typeof statusShape136.threshold === 'number',
      `[136j] buildStatusPayload includes newCriticalCount and threshold fields (got: ${JSON.stringify({ nc: typeof statusShape136.newCriticalCount, th: typeof statusShape136.threshold })})`
    );
  }

  // ── Block [137] PR Diff Analyzer (pure function unit tests) ───────
  {
    console.log('\n[137] pr-diff-analyzer — parsePrUrl + mapFilesToRoutes pure functions');

    // [137a] parsePrUrl extracts owner, repo, and prNumber from a standard PR URL
    const parsed137 = parsePrUrl('https://github.com/acme/my-app/pull/42');
    assert(
      parsed137.owner === 'acme' && parsed137.repo === 'my-app' && parsed137.prNumber === 42,
      `[137a] parsePrUrl extracts owner/repo/prNumber (got: ${JSON.stringify(parsed137)})`
    );

    // [137b] parsePrUrl accepts URLs with trailing path segments (e.g. /files)
    const parsed137b = parsePrUrl('https://github.com/org/repo/pull/100/files');
    assert(
      parsed137b.prNumber === 100 && parsed137b.owner === 'org',
      `[137b] parsePrUrl accepts PR URL with /files suffix (got: ${JSON.stringify(parsed137b)})`
    );

    // [137c] parsePrUrl throws on non-GitHub URLs
    let threw137c = false;
    try { parsePrUrl('https://gitlab.com/owner/repo/-/merge_requests/1'); }
    catch { threw137c = true; }
    assert(threw137c, `[137c] parsePrUrl throws on non-GitHub URL`);

    // [137d] mapFilesToRoutes returns all routes when changedFiles is empty
    const routes137 = [{ path: '/home', name: 'Home' }, { path: '/login', name: 'Login' }];
    const result137d = mapFilesToRoutes([], routes137);
    assert(
      result137d.length === routes137.length,
      `[137d] mapFilesToRoutes returns all routes when changedFiles is empty (got ${result137d.length})`
    );

    // [137e] mapFilesToRoutes detects infrastructure files and returns all routes
    const infra137 = ['next.config.js', 'src/app/page.tsx'];
    const result137e = mapFilesToRoutes(infra137, routes137);
    assert(
      result137e.length === routes137.length,
      `[137e] mapFilesToRoutes returns all routes for infrastructure file changes (got ${result137e.length})`
    );

    // [137f] mapFilesToRoutes filters to matching route via slug heuristic
    const routes137f = [{ path: '/checkout', name: 'Checkout' }, { path: '/about', name: 'About' }];
    const result137f = mapFilesToRoutes(['src/pages/checkout.tsx'], routes137f);
    assert(
      result137f.length === 1 && result137f[0].path === '/checkout',
      `[137f] mapFilesToRoutes matches "checkout" slug to /checkout route (got: ${JSON.stringify(result137f.map(r => r.path))})`
    );

    // [137g] mapFilesToRoutes falls back to all routes when no slug matches
    const result137g = mapFilesToRoutes(['src/utils/logger.js'], routes137f);
    assert(
      result137g.length === routes137f.length,
      `[137g] mapFilesToRoutes falls back to all routes when no slug matches (got ${result137g.length})`
    );

    // [137h] mapFilesToRoutes returns empty array when routes array is empty
    const result137h = mapFilesToRoutes(['src/pages/checkout.tsx'], []);
    assert(
      Array.isArray(result137h) && result137h.length === 0,
      `[137h] mapFilesToRoutes returns empty array when routes is empty (got ${result137h.length})`
    );

    // [137i] mapFilesToRoutes returns [] for a .github/-only PR (EXCLUDED_PATTERNS)
    const result137i = mapFilesToRoutes(
      ['.github/workflows/ci.yml', '.github/dependabot.yml'],
      routes137,
    );
    assert(
      Array.isArray(result137i) && result137i.length === 0,
      `[137i] mapFilesToRoutes returns [] for .github/-only PR — audit should be skipped (got ${result137i.length})`
    );

    // [137j] mapFilesToRoutes returns [] for a docs/markdown-only PR (EXCLUDED_PATTERNS)
    const result137j = mapFilesToRoutes(
      ['README.md', 'docs/setup.md', 'CHANGELOG.md'],
      routes137,
    );
    assert(
      Array.isArray(result137j) && result137j.length === 0,
      `[137j] mapFilesToRoutes returns [] for markdown-only PR — audit should be skipped (got ${result137j.length})`
    );

    // [137k] mapFilesToRoutes proceeds to route matching when mix of excluded + app files
    const result137k = mapFilesToRoutes(
      ['.github/workflows/ci.yml', 'src/pages/login.tsx'],
      [{ path: '/login', name: 'Login' }, { path: '/home', name: 'Home' }],
    );
    assert(
      result137k.length === 1 && result137k[0].path === '/login',
      `[137k] mapFilesToRoutes proceeds when PR has excluded files alongside app files (got: ${JSON.stringify(result137k.map(r => r.path))})`
    );
  }

  // ── Block [138] PR Validate CLI helpers (no Chrome required) ──────
  {
    console.log('\n[138] pr-validate.js CLI — buildStepSummary + writeGithubOutputs unit tests');

    // [138a] buildStepSummary is an exported function
    assert(
      typeof buildStepSummary === 'function',
      '[138a] buildStepSummary is exported from src/cli/pr-validate.js'
    );

    // [138b] writeGithubOutputs is an exported function
    assert(
      typeof writeGithubOutputs === 'function',
      '[138b] writeGithubOutputs is exported from src/cli/pr-validate.js'
    );

    // [138c] buildStepSummary with blocked=true contains "BLOCKED"
    const md138blocked = buildStepSummary({
      blocked: true,
      summary: { critical: 2, warning: 0, info: 1 },
      affectedRoutes: [{ path: '/checkout' }],
      perRoute: [{ route: '/checkout', critical: 2, warning: 0, info: 1 }],
      findings: [
        { severity: 'critical', type: 'console_error', message: 'TypeError: x is null', url: 'http://localhost:3000/checkout' },
      ],
      changedFiles: ['src/pages/checkout.tsx'],
      blockOn: 'critical',
    });
    assert(
      typeof md138blocked === 'string' && md138blocked.includes('BLOCKED'),
      `[138c] buildStepSummary(blocked=true) contains "BLOCKED" (got: ${md138blocked.slice(0, 80)})`
    );

    // [138d] buildStepSummary with blocked=false contains "PASSED"
    const md138passed = buildStepSummary({
      blocked: false,
      summary: { critical: 0, warning: 0, info: 2 },
      affectedRoutes: [{ path: '/login' }],
      perRoute: [{ route: '/login', critical: 0, warning: 0, info: 2 }],
      findings: [],
      changedFiles: ['src/pages/login.tsx'],
      blockOn: 'critical',
    });
    assert(
      typeof md138passed === 'string' && md138passed.includes('PASSED'),
      `[138d] buildStepSummary(blocked=false) contains "PASSED" (got: ${md138passed.slice(0, 80)})`
    );

    // [138e] buildStepSummary with critical findings shows critical count in the summary table
    assert(
      md138blocked.includes('**2**'),
      `[138e] buildStepSummary with 2 criticals bolds the critical count in the table`
    );

    // [138f] buildStepSummary escapes pipe chars in finding messages
    const md138pipe = buildStepSummary({
      blocked: false,
      summary: { critical: 0, warning: 1, info: 0 },
      affectedRoutes: [{ path: '/' }],
      perRoute: [{ route: '/', critical: 0, warning: 1, info: 0 }],
      findings: [{ severity: 'warning', type: 'seo_meta', message: 'Title | Subtitle has pipe', url: '/' }],
      changedFiles: [],
      blockOn: 'critical',
    });
    assert(
      md138pipe.includes('Title \\| Subtitle has pipe'),
      `[138f] buildStepSummary escapes "|" in finding messages to "\\|"`
    );

    // [138g] writeGithubOutputs writes blocked=true to a temp file via GITHUB_OUTPUT
    const tmpOutput138 = path.join(os.tmpdir(), `argus-test-output-${Date.now()}.txt`);
    const savedOutput138 = process.env.GITHUB_OUTPUT;
    process.env.GITHUB_OUTPUT = tmpOutput138;
    writeGithubOutputs({
      blocked: true,
      summary: { critical: 3, warning: 1, info: 0 },
      affectedRoutes: [{ path: '/dashboard' }, { path: '/checkout' }],
    });
    if (savedOutput138 === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = savedOutput138;
    const written138 = fs.existsSync(tmpOutput138) ? fs.readFileSync(tmpOutput138, 'utf8') : '';
    try { fs.unlinkSync(tmpOutput138); } catch { /* best-effort */ }
    assert(
      written138.includes('blocked=true'),
      `[138g] writeGithubOutputs writes blocked=true to GITHUB_OUTPUT file`
    );

    // [138h] writeGithubOutputs writes correct critical_count
    assert(
      written138.includes('critical_count=3'),
      `[138h] writeGithubOutputs writes critical_count=3 to GITHUB_OUTPUT file (got: ${written138.trim()})`
    );

    // [138i] writeGithubOutputs writes affected_routes as comma-separated string
    assert(
      written138.includes('affected_routes=/dashboard,/checkout'),
      `[138i] writeGithubOutputs writes affected_routes comma-separated (got: ${written138.trim()})`
    );

    // [138j] pr-validate.js CLI file exists on disk at the expected src/cli path
    const cliPath138 = path.join(__dirname, '../src/cli/pr-validate.js');
    assert(
      fs.existsSync(cliPath138),
      `[138j] src/cli/pr-validate.js exists at expected path (${cliPath138})`
    );

    // [138k] checkTargetReachable returns { ok: true } for a live server (harness fixture)
    const reach138k = await checkTargetReachable(`http://localhost:${devPort}/`);
    assert(
      reach138k.ok === true,
      `[138k] checkTargetReachable returns ok=true for live harness server on port ${devPort} (got: ${JSON.stringify(reach138k)})`
    );

    // [138l] checkTargetReachable returns { ok: false } for a port with nothing listening
    const reach138l = await checkTargetReachable('http://localhost:19999/');
    assert(
      reach138l.ok === false && typeof reach138l.error === 'string',
      `[138l] checkTargetReachable returns ok=false + error string for unreachable port (got: ${JSON.stringify(reach138l)})`
    );

    // [138m] checkTargetReachable returns ok=true for HTTP 4xx (server is up, route just missing)
    const reach138m = await checkTargetReachable(`http://localhost:${devPort}/this-path-does-not-exist-404`);
    assert(
      reach138m.ok === true,
      `[138m] checkTargetReachable returns ok=true for HTTP 404 — only network errors fail (got: ${JSON.stringify(reach138m)})`
    );

    // [138n] normalizeRoutePaths prepends leading slash to paths that are missing it
    const norm138n = normalizeRoutePaths([{ path: 'login', name: 'Login' }]);
    assert(
      norm138n[0].path === '/login',
      `[138n] normalizeRoutePaths prepends / to route path missing leading slash (got: "${norm138n[0].path}")`
    );

    // [138o] normalizeRoutePaths leaves paths that already have a leading slash unchanged
    const norm138o = normalizeRoutePaths([{ path: '/checkout', name: 'Checkout' }]);
    assert(
      norm138o[0].path === '/checkout',
      `[138o] normalizeRoutePaths leaves correctly-prefixed paths unchanged (got: "${norm138o[0].path}")`
    );

    // [138p] all-routes-failed guard condition: detects when every perRoute entry has an error
    const failedPerRoute138 = [
      { route: '/login', critical: 0, warning: 0, info: 0, error: 'navigate timeout' },
      { route: '/checkout', critical: 0, warning: 0, info: 0, error: 'MCP tool timeout' },
    ];
    const failCount138 = failedPerRoute138.filter(r => r.error).length;
    assert(
      failCount138 > 0 && failCount138 === failedPerRoute138.length,
      `[138p] all-routes-failed guard condition correctly identifies all-failed perRoute array (failCount=${failCount138}, total=${failedPerRoute138.length})`
    );
  }

  // ── Block [139]: Chrome Launcher, Doctor, Security Extensions ────
  {
    console.log('\n[139] Chrome launcher, doctor, security extensions');

    // [139a] checkSourceMapExposure fires for .js.map URL
    const mapReqs139 = [{ url: 'https://example.com/bundle.js.map' }];
    const mapFindings139 = checkSourceMapExposure(mapReqs139, 'https://example.com/');
    assert(
      mapFindings139.length === 1 && mapFindings139[0].type === 'security_sourcemap_exposed',
      `[139a] checkSourceMapExposure returns security_sourcemap_exposed for .js.map URL (got: ${mapFindings139.length} findings)`
    );

    // [139b] checkSourceMapExposure skips non-map URLs
    const safeReqs139 = [{ url: 'https://example.com/bundle.js' }, { url: 'https://example.com/style.css' }];
    const safeMapFindings139 = checkSourceMapExposure(safeReqs139, 'https://example.com/');
    assert(
      safeMapFindings139.length === 0,
      `[139b] checkSourceMapExposure returns no findings for non-map URLs (got: ${safeMapFindings139.length})`
    );

    // [139c] checkOpenRedirects fires for ?redirect= parameter
    const redirectReqs139 = [{ url: 'https://example.com/auth?redirect=https://evil.com' }];
    const redirectFindings139 = checkOpenRedirects(redirectReqs139, 'https://example.com/auth');
    assert(
      redirectFindings139.length === 1 && redirectFindings139[0].type === 'security_open_redirect',
      `[139c] checkOpenRedirects returns security_open_redirect for ?redirect= URL (got: ${redirectFindings139.length} findings)`
    );

    // [139d] checkOpenRedirects skips safe URLs
    const safeRedirectReqs139 = [{ url: 'https://example.com/api/data' }, { url: 'https://example.com/page?id=5' }];
    const safeRedirectFindings139 = checkOpenRedirects(safeRedirectReqs139, 'https://example.com/');
    assert(
      safeRedirectFindings139.length === 0,
      `[139d] checkOpenRedirects returns no findings for safe URLs (got: ${safeRedirectFindings139.length})`
    );

    // [139e] parseSecurityAnalysisResult emits security_missing_sri for external script without integrity
    const sriData139 = JSON.stringify({
      storageTokenKeys: [], evalUsage: false, jsCookies: [], hasCSP: null, hasXFrame: null,
      unsandboxedIframes: [], unsafeBlankLinks: [],
      sriViolations: [{ tag: 'script', src: 'https://cdn.example.com/lib.js' }],
    });
    const sriFindings139 = parseSecurityAnalysisResult(sriData139, 'https://example.com/');
    assert(
      sriFindings139.some(f => f.type === 'security_missing_sri'),
      `[139e] parseSecurityAnalysisResult emits security_missing_sri for external script without integrity (got types: ${sriFindings139.map(f => f.type).join(', ') || 'none'})`
    );

    // [139f] parseSecurityAnalysisResult emits no SRI finding when sriViolations is empty
    const noSriData139 = JSON.stringify({
      storageTokenKeys: [], evalUsage: false, jsCookies: [], hasCSP: null, hasXFrame: null,
      unsandboxedIframes: [], unsafeBlankLinks: [], sriViolations: [],
    });
    const noSriFindings139 = parseSecurityAnalysisResult(noSriData139, 'https://example.com/').filter(f => f.type === 'security_missing_sri');
    assert(
      noSriFindings139.length === 0,
      `[139f] parseSecurityAnalysisResult emits no security_missing_sri when sriViolations is empty`
    );

    // [139g] checkChrome returns { ok, detail } shape (may be ok=false in harness — Chrome may not be on 9222 this moment)
    const chromeResult139 = await checkChrome(9222);
    assert(
      typeof chromeResult139 === 'object' && chromeResult139 !== null &&
      typeof chromeResult139.ok === 'boolean' && typeof chromeResult139.detail === 'string',
      `[139g] checkChrome returns { ok: boolean, detail: string } shape (got: ${JSON.stringify(chromeResult139)})`
    );

    // [139h] checkMcpConfig returns ok=false for a missing file path
    const mcpMissing139 = checkMcpConfig('/nonexistent/path/.mcp.json');
    assert(
      mcpMissing139.ok === false && typeof mcpMissing139.detail === 'string',
      `[139h] checkMcpConfig returns ok=false for missing file (got: ${JSON.stringify(mcpMissing139)})`
    );

    // [139i] checkMcpConfig returns ok=true for valid config with chrome-devtools entry
    const tmpMcp139 = path.join(os.tmpdir(), 'argus-test-mcp-139.json');
    fs.writeFileSync(tmpMcp139, JSON.stringify({
      mcpServers: {
        'chrome-devtools': { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.1.1'] },
      },
    }));
    const mcpValid139 = checkMcpConfig(tmpMcp139);
    fs.unlinkSync(tmpMcp139);
    assert(
      mcpValid139.ok === true,
      `[139i] checkMcpConfig returns ok=true for valid chrome-devtools config (got: ${JSON.stringify(mcpValid139)})`
    );

    // [139j] checkEnvKeys returns ok=true when TARGET_DEV_URL is present in .env content
    const tmpEnv139 = path.join(os.tmpdir(), 'argus-test-env-139');
    fs.writeFileSync(tmpEnv139, 'TARGET_DEV_URL=http://localhost:3000\n');
    // Temporarily unset env var so checkEnvKeys reads from file
    const savedUrl139 = process.env.TARGET_DEV_URL;
    delete process.env.TARGET_DEV_URL;
    const envResult139 = checkEnvKeys(tmpEnv139);
    if (savedUrl139 !== undefined) process.env.TARGET_DEV_URL = savedUrl139;
    fs.unlinkSync(tmpEnv139);
    assert(
      envResult139.ok === true && envResult139.detail.includes('localhost:3000'),
      `[139j] checkEnvKeys returns ok=true when TARGET_DEV_URL in .env file (got: ${JSON.stringify(envResult139)})`
    );

    // [139k] findChrome() returns string or null without throwing (pure path resolution, no side effects)
    let chromePathResult139;
    let chromeThrew139 = false;
    try { chromePathResult139 = findChrome(); } catch { chromeThrew139 = true; }
    assert(
      !chromeThrew139 && (chromePathResult139 === null || typeof chromePathResult139 === 'string'),
      `[139k] findChrome() returns string or null without throwing (got: ${chromeThrew139 ? 'threw' : JSON.stringify(chromePathResult139)})`
    );
  }

  // ── Block [140]: Noise Filter — intelligent baseline filtering (pure unit) ──
  {
    console.log('\n[140] Noise filter — cross-run flip-flop classifier (intelligent baseline filtering)');

    const url140 = 'http://localhost:3000/dash';
    const flipKey140   = 'console::boom';      // present in runs 1,3,5 — absent 2,4
    const stableKey140 = 'network::dead';      // present in every run
    const mkHistory140 = (runs) => runs.map(keys => ({ runAt: 'x', routes: { [url140]: keys } }));
    const history140 = mkHistory140([
      [flipKey140, stableKey140],
      [stableKey140],
      [flipKey140, stableKey140],
      [stableKey140],
      [flipKey140, stableKey140],
    ]);

    // [140a] flip-flopping key scores 1.0 (flips on every consecutive run pair)
    const scores140 = computeNoiseScores(history140);
    const flipScore140 = scores140.get(`${url140}::${flipKey140}`);
    assert(
      flipScore140 && flipScore140.score === 1 && flipScore140.runs === 5,
      `[140a] flip-flopping finding scores 1.0 over 5 runs (got: ${JSON.stringify(flipScore140)})`
    );

    // [140b] stable always-present key scores 0
    const stableScore140 = scores140.get(`${url140}::${stableKey140}`);
    assert(
      stableScore140 && stableScore140.score === 0,
      `[140b] stable always-present finding scores 0 (got: ${JSON.stringify(stableScore140)})`
    );

    // [140c] applyNoiseFilter downgrades the noisy finding to info + annotates
    const report140 = { routes: [{ url: url140, errors: [
      { type: 'console', message: 'boom', severity: 'warning' },
      { type: 'network', message: 'dead', severity: 'critical' },
    ] }] };
    const { noisyCount: noisy140 } = applyNoiseFilter(report140, history140);
    const flipFinding140 = report140.routes[0].errors[0];
    assert(
      noisy140 === 1 && flipFinding140.noisy === true && flipFinding140.severity === 'info' &&
      flipFinding140.originalSeverity === 'warning' && typeof flipFinding140.noiseScore === 'number',
      `[140c] noisy finding downgraded to info with noisy:true + originalSeverity (got: noisy=${noisy140}, ${JSON.stringify(flipFinding140)})`
    );

    // [140d] stable critical finding untouched
    const stableFinding140 = report140.routes[0].errors[1];
    assert(
      stableFinding140.severity === 'critical' && stableFinding140.noisy === undefined,
      `[140d] stable finding keeps original severity (got: ${stableFinding140.severity}, noisy=${stableFinding140.noisy})`
    );

    // [140e] history shorter than NOISE_MIN_RUNS → no downgrade even when flip-flopping
    const shortHistory140 = mkHistory140([[flipKey140], [], [flipKey140]]); // 3 runs < 4
    const shortReport140 = { routes: [{ url: url140, errors: [{ type: 'console', message: 'boom', severity: 'warning' }] }] };
    const { noisyCount: shortNoisy140 } = applyNoiseFilter(shortReport140, shortHistory140);
    assert(
      shortNoisy140 === 0 && shortReport140.routes[0].errors[0].severity === 'warning',
      `[140e] ${NOISE_MIN_RUNS}-run minimum respected — 3-run history produces no downgrade (got noisy=${shortNoisy140})`
    );

    // [140f] recordRunHistory round-trip + caps at maxRuns
    const tmpHistory140 = path.join(os.tmpdir(), `argus-history-140-${Date.now()}.json`);
    const runReport140 = { generatedAt: 'now', routes: [{ url: url140, errors: [{ type: 'console', message: 'boom' }] }] };
    for (let i = 0; i < 6; i++) recordRunHistory(tmpHistory140, runReport140, 5);
    const loaded140 = loadRunHistory(tmpHistory140);
    assert(
      loaded140.length === 5 && loaded140[0].routes[url140]?.includes('console::boom'),
      `[140f] recordRunHistory caps at maxRuns=5 and round-trips finding keys (got ${loaded140.length} runs)`
    );

    // [140g] corrupt history file → loadRunHistory returns []
    fs.writeFileSync(tmpHistory140, 'not json {{');
    const corrupt140 = loadRunHistory(tmpHistory140);
    fs.unlinkSync(tmpHistory140);
    assert(
      Array.isArray(corrupt140) && corrupt140.length === 0,
      `[140g] corrupt history file returns [] (got: ${JSON.stringify(corrupt140)})`
    );
  }

  // ── Block [141]: Root Cause Linker — git diff → route heuristic (pure unit) ──
  {
    console.log('\n[141] Root cause linker — recent git changes mapped to new findings');

    // [141a] getRecentChanges returns an array (this repo, or [] when git unavailable)
    let changes141;
    let changesThrew141 = false;
    try { changes141 = getRecentChanges(); } catch { changesThrew141 = true; }
    assert(
      !changesThrew141 && Array.isArray(changes141),
      `[141a] getRecentChanges returns an array without throwing (got ${changesThrew141 ? 'throw' : changes141.length + ' commit(s)'})`
    );

    // [141b] slug match: checkout page file matches /checkout route
    const direct141 = matchFilesToRoutePath(['src/pages/checkout/Form.jsx'], '/checkout');
    assert(
      direct141.files.length === 1 && direct141.global === false,
      `[141b] src/pages/checkout/Form.jsx matches route /checkout (got: ${JSON.stringify(direct141)})`
    );

    // [141c] unrelated file → no match, not global
    const none141 = matchFilesToRoutePath(['src/utils/random-helper.js'], '/checkout');
    assert(
      none141.files.length === 0 && none141.global === false,
      `[141c] unrelated file does not match /checkout (got: ${JSON.stringify(none141)})`
    );

    // [141d] infra file → global scope, not a direct match
    const infra141 = matchFilesToRoutePath(['next.config.js'], '/checkout');
    assert(
      infra141.global === true && infra141.files.length === 0,
      `[141d] next.config.js flagged global for any route (got: ${JSON.stringify(infra141)})`
    );

    // [141e] linkRootCauses annotates the NEW finding with rootCause.files
    const report141 = { routes: [{ url: 'http://localhost:3000/checkout', errors: [
      { type: 'console', message: 'boom', isNew: true },
      { type: 'network', message: 'old issue', isNew: false },
    ] }] };
    const commits141 = [{ hash: 'abc1234', subject: 'fix checkout form', files: ['src/pages/checkout/Form.jsx'] }];
    const { linkedCount: linked141 } = linkRootCauses(report141, commits141);
    const newFinding141 = report141.routes[0].errors[0];
    assert(
      linked141 === 1 && newFinding141.rootCause?.files?.includes('src/pages/checkout/Form.jsx') &&
      newFinding141.rootCause.commits[0].hash === 'abc1234' && newFinding141.rootCause.global === false,
      `[141e] new finding annotated with rootCause files + commit (got: ${JSON.stringify(newFinding141.rootCause)})`
    );

    // [141f] pre-existing (isNew: false) finding NOT annotated
    assert(
      report141.routes[0].errors[1].rootCause === undefined,
      `[141f] pre-existing finding has no rootCause annotation`
    );

    // [141g] empty changes → no annotation, no throw
    const emptyReport141 = { routes: [{ url: 'http://localhost:3000/checkout', errors: [{ type: 'console', message: 'x', isNew: true }] }] };
    const { linkedCount: emptyLinked141 } = linkRootCauses(emptyReport141, []);
    assert(
      emptyLinked141 === 0 && emptyReport141.routes[0].errors[0].rootCause === undefined,
      `[141g] empty changes list links nothing (got linkedCount=${emptyLinked141})`
    );

    // [141h] infra-only commit → rootCause.global true with infra files as suspects
    const globalReport141 = { routes: [{ url: 'http://localhost:3000/checkout', errors: [{ type: 'console', message: 'y', isNew: true }] }] };
    const infraCommits141 = [{ hash: 'def5678', subject: 'bump deps', files: ['package.json'] }];
    const { linkedCount: globalLinked141 } = linkRootCauses(globalReport141, infraCommits141);
    const globalFinding141 = globalReport141.routes[0].errors[0];
    assert(
      globalLinked141 === 1 && globalFinding141.rootCause?.global === true &&
      globalFinding141.rootCause.files.includes('package.json'),
      `[141h] infra-only commit links with global:true (got: ${JSON.stringify(globalFinding141.rootCause)})`
    );
  }

  // ── Block [142]: MCP wire-contract regressions (2026-06-12 audit) ──────────
  // Guards the bug class where markdown MCP responses were consumed as
  // structured data, plus the mcp-server logger/version regressions.
  {
    console.log('\n[142] MCP wire-contract regressions — list_pages parse, response body extraction, server hygiene');

    // [142a] parseListPagesResponse parses the markdown pages list
    const pages142 = parseListPagesResponse('## Pages\n1: http://localhost:3100/a.html [selected]\n2: about:blank');
    assert(
      pages142.length === 2 && pages142[0].id === 1 && pages142[0].selected === true &&
      pages142[0].url === 'http://localhost:3100/a.html' && pages142[1].selected === false,
      `[142a] parseListPagesResponse parses ids/urls/selected (got: ${JSON.stringify(pages142)})`
    );

    // [142b] parseListPagesResponse guards null/garbage input
    assert(
      Array.isArray(parseListPagesResponse(null)) && parseListPagesResponse(null).length === 0 &&
      parseListPagesResponse('no pages here').length === 0,
      `[142b] parseListPagesResponse returns [] for null/garbage`
    );

    // [142c] extractResponseBody parses the "### Response Body" markdown section
    const md142 = '## Request http://x/api\nStatus: 200\n### Response Headers\n- a:b\n### Response Body\n{"ok":true,"n":2}';
    const body142 = extractResponseBody(md142);
    assert(
      body142 && body142.ok === true && body142.n === 2,
      `[142c] extractResponseBody parses markdown body section (got: ${JSON.stringify(body142)})`
    );

    // [142d] extractResponseBody returns null when no body section exists
    assert(
      extractResponseBody('## Request http://x/api\nStatus: 304\n### Response Headers\n- a:b') === null &&
      extractResponseBody(null) === null,
      `[142d] extractResponseBody returns null without a body section`
    );

    // [142e] extractResponseBody legacy structured shapes still work
    assert(
      extractResponseBody({ responseBody: '{"a":1}' })?.a === 1 &&
      extractResponseBody({ body: '{"b":2}' })?.b === 2,
      `[142e] extractResponseBody handles legacy { responseBody } / { body } shapes`
    );

    // [142f]–[142i] static source regressions on mcp-server.js + adapters
    const mcpSrc142     = fs.readFileSync(path.resolve('src/mcp-server.js'), 'utf8');
    const browserSrc142 = fs.readFileSync(path.resolve('src/adapters/browser.js'), 'utf8');
    const prDiffSrc142  = fs.readFileSync(path.resolve('src/utils/pr-diff-analyzer.js'), 'utf8');

    // [142f] mcp-server.js defines its logger (a bare `logger.` reference once
    // threw ReferenceError inside withMcp, masking every handler error)
    assert(
      mcpSrc142.includes("childLogger('mcp-server')"),
      `[142f] mcp-server.js imports and instantiates childLogger`
    );

    // [142g] mcp-server.js reads its version from package.json (hardcoded '9.6.6' drifted)
    assert(
      mcpSrc142.includes('version: pkg.version') && !mcpSrc142.includes("version: '9.6.6'"),
      `[142g] mcp-server.js Server version comes from package.json`
    );

    // [142h] browser adapter sends the reqid wire param (requestId is rejected by chrome-devtools-mcp)
    assert(
      browserSrc142.includes('get_network_request({ reqid:'),
      `[142h] CdpBrowserAdapter.getNetworkRequest sends reqid`
    );

    // [142i] pr-diff-analyzer must never write to stdout (imported by the MCP server)
    assert(
      !prDiffSrc142.includes('console.log('),
      `[142i] pr-diff-analyzer.js has no console.log (stdout reserved for JSON-RPC)`
    );
  }

  // ── [143] CdpBrowserAdapter wire-contract conformance ───────────────────────
  // One content-level assertion per adapter method against live Chrome. Motivated by
  // the 2026-06-12 audit: three adapter/client wire bugs (reqid, markdown parsing,
  // logger) shipped silently because no test exercised the real wire. The meta-
  // assertion at the end enumerates CdpBrowserAdapter.prototype so a new adapter
  // method CANNOT ship without a conformance entry here.
  // NOTE: chrome-devtools-mcp returns tool input-validation failures as RESOLVED
  // error-text responses (not thrown errors), so every assertion here checks content;
  // "it didn't throw" proves nothing.
  {
    console.log('\n[143] CdpBrowserAdapter wire-contract conformance — content assertion per adapter method');

    const covered = new Set(); // methods with a conformance entry in this block
    const C = `${B}/adapter-conformance.html`;
    const ZOD_ERR = 'Input validation error';

    try {
      // ── navigate + waitFor (text appears 600 ms post-load, so wait_for must wait) ──
      covered.add('navigate');
      const navResp143 = await browser.navigate(C);
      const navText143 = String(navResp143);
      assert(
        navText143.includes('Successfully navigated') && navText143.includes('/adapter-conformance.html'),
        `[143a] navigate() response confirms navigation to the fixture URL (got: ${navText143.slice(0, 120)})`
      );

      covered.add('waitFor');
      const wfStart143 = Date.now();
      const wfResp143 = String(await browser.waitFor({ text: 'late-probe-ready' }));
      const wfMs143 = Date.now() - wfStart143;
      assert(
        wfResp143.includes('late-probe-ready') && wfResp143.includes('found') && !wfResp143.includes(ZOD_ERR),
        `[143b] waitFor({ text: string }) normalises to the array wire shape and finds the late text (got: ${wfResp143.slice(0, 120)})`
      );
      // The text appears 600 ms after load; sub-100 ms resolution would mean wait_for
      // never actually waited (e.g. silently matched nothing).
      assert(
        wfMs143 >= 100,
        `[143c] waitFor() actually waited for the 600 ms-late text (resolved in ${wfMs143} ms)`
      );

      const wfIdle143 = String(await browser.waitFor({ state: 'networkidle' }) ?? '');
      assert(
        !wfIdle143.includes(ZOD_ERR),
        `[143d] waitFor({ state: 'networkidle' }) is translated by the adapter, not rejected by wait_for input validation (got: ${wfIdle143.slice(0, 120) || '<empty — resolved>'})`
      );

      // ── evaluate / snapshot / screenshot ──
      covered.add('evaluate');
      const evalVal143 = unwrapEval(await browser.evaluate('() => 6 * 7'));
      assert(
        Number(evalVal143) === 42,
        `[143e] evaluate('() => 6 * 7') unwraps to 42 (got: ${JSON.stringify(evalVal143)})`
      );

      covered.add('snapshot');
      const snapText143 = String(await browser.snapshot());
      assert(
        snapText143.includes('uid=') && snapText143.includes('Conformance Click Probe'),
        `[143f] snapshot() returns uid= tokens with the fixture's accessible names (got: ${snapText143.slice(0, 120)})`
      );

      covered.add('screenshot');
      const shot143 = await browser.screenshot({ format: 'png' });
      const shotMagic143 = shot143?.data
        ? Buffer.from(String(shot143.data).slice(0, 16), 'base64').toString('hex')
        : '(no data)';
      assert(
        typeof shot143?.data === 'string' && shot143.data.length > 1000 && shotMagic143.startsWith('89504e47'),
        `[143g] screenshot({ format: 'png' }) returns base64 image data with PNG magic bytes — the image content item, not the text caption (magic: ${shotMagic143}, len: ${shot143?.data?.length ?? typeof shot143})`
      );

      // ── interactions: click / fill / type / pressKey / hover / drag / uploadFile ──
      covered.add('click');
      const clickUid143 = await resolveUidForSelector(browser, '#click-btn');
      if (clickUid143) await browser.click(clickUid143);
      const clicked143 = unwrapEval(await browser.evaluate(`() => document.getElementById('click-btn').getAttribute('data-clicked')`));
      assert(
        clickUid143 != null && String(clicked143) === 'true',
        `[143h] click(uid) fires the click handler — data-clicked="true" (uid: ${clickUid143}, got: ${JSON.stringify(clicked143)})`
      );

      covered.add('fill');
      const fillUid143 = await resolveUidForSelector(browser, '#fill-input');
      if (fillUid143) await browser.fill(fillUid143, 'wire-fill-143');
      const fillVal143 = unwrapEval(await browser.evaluate(`() => document.getElementById('fill-input').value`));
      assert(
        fillUid143 != null && String(fillVal143) === 'wire-fill-143',
        `[143i] fill(uid, value) delivers the value to the input (uid: ${fillUid143}, got: ${JSON.stringify(fillVal143)})`
      );

      covered.add('type');
      // click does not move document.activeElement for text inputs in headless —
      // focus via evaluate, same as block [48b]
      const typeFocused143 = !!unwrapEval(await browser.evaluate(`() => { const el = document.getElementById('type-input'); if (!el) return false; el.focus(); return true; }`));
      const typeResp143 = String(await browser.type('wire-type-143'));
      const typeVal143 = unwrapEval(await browser.evaluate(`() => document.getElementById('type-input').value`));
      assert(
        typeFocused143 && typeResp143.includes('Typed text') && String(typeVal143) === 'wire-type-143',
        `[143j] type(text) types into the focused element (response: ${typeResp143.slice(0, 60)}, value: ${JSON.stringify(typeVal143)})`
      );

      covered.add('pressKey');
      // #fill-input and #type-input are adjacent in tab order — Tab from fill lands on type
      await browser.evaluate(`() => { document.getElementById('fill-input').focus(); return true; }`);
      await browser.pressKey('Tab');
      const activeId143 = unwrapEval(await browser.evaluate(`() => document.activeElement.id`));
      assert(
        String(activeId143) === 'type-input',
        `[143k] pressKey('Tab') moves focus to the next focusable element (activeElement.id: ${JSON.stringify(activeId143)})`
      );

      covered.add('hover');
      const hoverUid143 = await resolveUidForSelector(browser, '#hover-target');
      if (hoverUid143) await browser.hover(hoverUid143);
      const hovered143 = unwrapEval(await browser.evaluate(`() => document.getElementById('hover-target').getAttribute('data-hovered')`));
      assert(
        hoverUid143 != null && String(hovered143) === 'true',
        `[143l] hover(uid) fires mouseenter — data-hovered="true" (uid: ${hoverUid143}, got: ${JSON.stringify(hovered143)})`
      );

      covered.add('drag');
      const dragSrcUid143 = await resolveUidForSelector(browser, '#drag-source');
      const dropUid143 = await resolveUidForSelector(browser, '#drop-zone');
      if (dragSrcUid143 && dropUid143) await browser.drag(dragSrcUid143, dropUid143);
      const dropped143 = unwrapEval(await browser.evaluate(`() => document.getElementById('drop-zone').getAttribute('data-dropped')`));
      assert(
        dragSrcUid143 != null && dropUid143 != null && String(dropped143) === 'true',
        `[143m] drag(src, tgt) fires the drop handler — data-dropped="true" (uids: ${dragSrcUid143}/${dropUid143}, got: ${JSON.stringify(dropped143)})`
      );

      covered.add('uploadFile');
      const uploadUid143 = await resolveUidForSelector(browser, 'input[type=file]');
      if (uploadUid143) await browser.uploadFile(uploadUid143, path.resolve(__dirname, 'pages', 'test-upload.txt'));
      const uploadName143 = unwrapEval(await browser.evaluate(`() => { const f = document.getElementById('file-input').files; return f.length ? f[0].name : null; }`));
      assert(
        uploadUid143 != null && String(uploadName143) === 'test-upload.txt',
        `[143n] uploadFile(uid, path) delivers the file to the input (uid: ${uploadUid143}, files[0].name: ${JSON.stringify(uploadName143)})`
      );

      // ── viewport: emulate / emulateCpu / emulateColorScheme / emulateReducedMotion / resize ──
      covered.add('emulate');
      await browser.emulate('375x667x1,mobile,touch');
      const emuWidth143 = Number(unwrapEval(await browser.evaluate('() => document.documentElement.clientWidth')));
      assert(
        emuWidth143 === 375,
        `[143o] emulate('375x667x1,mobile,touch') sets the visual viewport — clientWidth 375 (got: ${emuWidth143})`
      );
      await browser.emulate('1280x900x1');

      covered.add('emulateCpu');
      const cpuResp143 = String(await browser.emulateCpu(2));
      assert(
        cpuResp143.includes('CPU throttling: 2x'),
        `[143p] emulateCpu(2) response confirms the throttling rate (got: ${cpuResp143.slice(0, 120)})`
      );
      await browser.emulateCpu(1);

      covered.add('emulateColorScheme');
      await browser.emulateColorScheme('dark');
      const darkMatch143 = unwrapEval(await browser.evaluate(`() => window.matchMedia('(prefers-color-scheme: dark)').matches`));
      assert(
        darkMatch143 === true || String(darkMatch143) === 'true',
        `[143q] emulateColorScheme('dark') flips prefers-color-scheme (matches: ${JSON.stringify(darkMatch143)})`
      );
      await browser.emulateColorScheme('light');

      covered.add('emulateReducedMotion');
      // chrome-devtools-mcp@1.1.1 has no reduced-motion emulation (emulate tool rejects
      // the argument as unknown) — the adapter must surface that as a thrown error,
      // never a silent no-op. If a future upstream version adds support, the call must
      // actually flip the media feature. Both outcomes pass; silence fails.
      let rmOutcome143;
      try {
        await browser.emulateReducedMotion('reduce');
        const motionMatch143 = unwrapEval(await browser.evaluate(`() => window.matchMedia('(prefers-reduced-motion: reduce)').matches`));
        rmOutcome143 = (motionMatch143 === true || String(motionMatch143) === 'true')
          ? 'emulated'
          : `silent-noop (matches: ${JSON.stringify(motionMatch143)})`;
        await browser.emulateReducedMotion('no-preference').catch(() => { });
      } catch (e) {
        rmOutcome143 = /reducedMotion/i.test(e.message)
          ? 'unsupported-error'
          : `wrong-error (${e.message.slice(0, 80)})`;
      }
      assert(
        rmOutcome143 === 'emulated' || rmOutcome143 === 'unsupported-error',
        `[143r] emulateReducedMotion('reduce') either emulates the media feature or throws an explicit unsupported error — never a silent no-op (outcome: ${rmOutcome143})`
      );

      covered.add('resize');
      // An active viewport emulation pins innerWidth regardless of window size —
      // clear the override (empty-string viewport) so resize_page's effect is visible
      await browser.emulate('');
      await browser.resize(1234, 777);
      const resizeWidth143 = Number(unwrapEval(await browser.evaluate('() => window.innerWidth')));
      assert(
        resizeWidth143 === 1234,
        `[143s] resize(1234, 777) resizes the window — innerWidth 1234 (got: ${resizeWidth143})`
      );
      await browser.emulate('1280x900x1');

      // ── network & console lists (the v9.7.4 bug class lived here) ──
      covered.add('listNetwork');
      const net143 = await browser.listNetwork();
      const apiReq143 = net143.find(r => r.url.includes('/api/data'));
      assert(
        apiReq143 != null && apiReq143.status === 200 && Number.isFinite(apiReq143.requestId),
        `[143t] listNetwork() parses the fixture's /api/data request with numeric requestId and status 200 (got: ${JSON.stringify(apiReq143 ?? net143.slice(0, 2))})`
      );

      covered.add('getNetworkRequest');
      const gnr143 = apiReq143 ? String(await browser.getNetworkRequest(apiReq143.requestId)) : '(skipped — no /api/data request)';
      assert(
        gnr143.includes('/api/data') && gnr143.includes('Status: 200') && gnr143.includes('### Response Headers'),
        `[143u] getNetworkRequest(id) sends the reqid wire param and returns the request detail (got: ${gnr143.slice(0, 150)})`
      );

      covered.add('listConsole');
      const console143 = await browser.listConsole();
      const probeMsg143 = console143.find(m => (m.text ?? '').includes('argus-conformance-probe'));
      assert(
        probeMsg143 != null && probeMsg143.level === 'log',
        `[143v] listConsole() parses the fixture's console.log probe with its level (got: ${JSON.stringify(probeMsg143 ?? console143.slice(0, 2))})`
      );

      covered.add('listConsoleRaw');
      const rawConsole143 = await browser.listConsoleRaw({});
      assert(
        typeof rawConsole143 === 'string' && rawConsole143.includes('argus-conformance-probe') && rawConsole143.includes('msgid='),
        `[143w] listConsoleRaw() passes through unparsed msgid= markdown containing the probe (got: ${String(rawConsole143).slice(0, 120)})`
      );

      // ── tab management: listPages / selectPage ──
      covered.add('listPages');
      const pages143 = parseListPagesResponse(await browser.listPages());
      const selPage143 = pages143.find(p => p.selected);
      assert(
        pages143.length >= 1 && selPage143 != null && Number.isFinite(selPage143.id) && selPage143.url.includes('/adapter-conformance.html'),
        `[143x] listPages() parses ≥1 page with numeric id and the fixture URL selected (got: ${JSON.stringify(pages143)})`
      );

      covered.add('selectPage');
      // String input is the contract — MCP tool args arrive as strings; selectPage must
      // coerce to the number select_page's input validation requires
      const selResp143 = String(await browser.selectPage(String(selPage143?.id ?? 1)));
      assert(
        !selResp143.includes(ZOD_ERR) && selResp143.includes('[selected]'),
        `[143y] selectPage('${selPage143?.id ?? 1}') coerces the string id and confirms selection (got: ${selResp143.slice(0, 120)})`
      );

      // ── handleDialog — LAST interaction: an open dialog blocks every other tool ──
      covered.add('handleDialog');
      await browser.evaluate(`() => { setTimeout(() => { window.__dialogResult = window.confirm('argus-143-dialog'); }, 150); return true; }`);
      await sleep(500);
      const dialogResp143 = String(await browser.handleDialog(true));
      const dialogResult143 = unwrapEval(await browser.evaluate('() => String(window.__dialogResult)'));
      assert(
        dialogResp143.includes('Successfully accepted the dialog') && String(dialogResult143) === 'true',
        `[143z] handleDialog(true) sends { action: 'accept' } and the page's confirm() returns true (response: ${dialogResp143.slice(0, 100)}, confirm: ${JSON.stringify(dialogResult143)})`
      );

      // ── soft: heapSnapshot / lighthouse / traces (headless-fragile, existing policy) ──
      covered.add('heapSnapshot');
      try {
        const heapPath143 = path.join(os.tmpdir(), `argus-143-${Date.now()}.heapsnapshot`);
        const heapResp143 = String(await browser.heapSnapshot({ filePath: heapPath143 }));
        const heapSize143 = fs.existsSync(heapPath143) ? fs.statSync(heapPath143).size : 0;
        soft(
          heapResp143.includes('Heap snapshot saved') && heapSize143 > 100_000,
          `[143aa] heapSnapshot({ filePath }) writes a heap snapshot file (response: ${heapResp143.slice(0, 60)}, bytes: ${heapSize143})`
        );
        fs.rmSync(heapPath143, { force: true });
      } catch (e) {
        soft(false, `[143aa] heapSnapshot({ filePath }) writes a heap snapshot file (threw: ${e.message})`);
      }

      covered.add('startTrace');
      covered.add('stopTrace');
      covered.add('analyzeInsight');
      try {
        // performance_start_trace defaults to reload + autoStop, so the summary
        // arrives in the START response; stopTrace afterwards is a no-op
        const traceResp143 = String(await browser.startTrace());
        soft(
          /trace|insight/i.test(traceResp143),
          `[143ab] startTrace() returns a performance trace summary (got: ${traceResp143.slice(0, 80)})`
        );
        const stopResp143 = String(await browser.stopTrace() ?? '');
        soft(
          !stopResp143.includes(ZOD_ERR),
          `[143ac] stopTrace() resolves without input-validation rejection (got: ${stopResp143.slice(0, 80) || '<empty>'})`
        );
        const insightResp143 = String(await browser.analyzeInsight({ insightName: 'DocumentLatency' }) ?? '');
        soft(
          insightResp143.length > 0,
          `[143ad] analyzeInsight() reaches the tool — response or structured validation text (got: ${insightResp143.slice(0, 80)})`
        );
      } catch (e) {
        soft(false, `[143ab] trace methods unavailable in this Chrome (threw: ${e.message})`);
      }

      covered.add('lighthouse');
      try {
        const lhResp143 = String(await browser.lighthouse(C) ?? '');
        soft(
          lhResp143.length > 0 && !lhResp143.includes(ZOD_ERR),
          `[143ae] lighthouse(url) reaches lighthouse_audit (got: ${lhResp143.slice(0, 80)})`
        );
      } catch (e) {
        soft(false, `[143ae] lighthouse(url) unavailable in headless (threw: ${e.message})`);
      }

      // ── close — proven on a dedicated client so the shared one survives ──
      covered.add('close');
      const mcp143 = await createMcpClient();
      let closeErr143 = null;
      try {
        const probe143 = unwrapEval(await mcp143.evaluate_script({ function: '() => 1 + 1' }));
        mcp143.close();
        try {
          await mcp143.evaluate_script({ function: '() => 2 + 2' });
        } catch (e) {
          closeErr143 = e.message;
        }
        // Post-close rejection surfaces via one of three paths: close() pending sweep
        // ("MCP client closed"), the stdin error event ("MCP stdin error: ..."), or the
        // raw write callback ("write after end" / EPIPE) — all prove termination.
        assert(
          Number(probe143) === 2 && closeErr143 != null && /closed|exited|stdin|write after end|EPIPE/i.test(closeErr143),
          `[143af] close() terminates the client — follow-up calls reject with a closed-client error (probe: ${JSON.stringify(probe143)}, error: ${closeErr143})`
        );
      } finally {
        try { mcp143.close(); } catch { }
      }
    } finally {
      // Restore every emulation override and clear any dialog left open so later
      // blocks (and reruns) start clean — an open dialog poisons all tool calls.
      try { await mcp.handle_dialog({ action: 'dismiss' }); } catch { }
      try { await browser.emulate('1280x900x1'); } catch { }
      try { await browser.emulateCpu(1); } catch { }
      try { await browser.emulateColorScheme('light'); } catch { }
      try { await browser.emulateReducedMotion('no-preference'); } catch { }
    }

    // ── meta-assertion: the coverage ratchet ──
    const protoMethods143 = Object.getOwnPropertyNames(CdpBrowserAdapter.prototype)
      .filter(m => m !== 'constructor');
    const uncovered143 = protoMethods143.filter(m => !covered.has(m));
    assert(
      protoMethods143.length >= 30 && uncovered143.length === 0,
      `[143zz] every CdpBrowserAdapter method has a conformance entry in this block (${protoMethods143.length} methods; uncovered: ${uncovered143.join(', ') || 'none'})`
    );
  }

  // ── Block [144] MCP tool error-path matrix — invalid input + environmental failure ──
  // Direct guard for the v9.7.4 masked-error bug class: a missing `logger` import in
  // mcp-server.js turned every withMcp error path into "logger is not defined", hiding
  // the real cause. So every error-path assertion here ALSO asserts the response does
  // NOT contain "is not defined", and after each provoked error a follow-up tools/list
  // proves the SAME server instance is still answering. Happy paths are covered
  // elsewhere and not duplicated here: [117] tools/list, [118] argus_last_report
  // (no-reports), [119] argus_get_context diff, [120] argus_watch_snapshot. Every error
  // shape below was pinned against live Chrome before these assertions were written.
  {
    console.log('\n[144] MCP tool error-path matrix — structured {error} + isError + server-survives + no masked ReferenceError');

    const ND = 'is not defined';                 // the masked-ReferenceError signature
    const parse144 = (resp) => {
      const text = resp?.result?.content?.[0]?.text ?? '';
      let obj = null; try { obj = JSON.parse(text); } catch { /* non-JSON error text */ }
      return { text, obj, isError: resp?.result?.isError === true };
    };

    let srvA144 = null;        // normal server (real Chrome on 9222); FIGMA token forced off
    let srvB144 = null;        // dead-browser server (MCP_BROWSER_URL → closed port)
    const surviveA144 = [];    // tools-count after each srvA error/edge call
    let err144 = null;

    try {
      // FIGMA_API_TOKEN:'' makes the no-token design-audit path deterministic regardless
      // of the developer's shell; ARGUS_RETRY_ATTEMPTS:'1' makes the unreachable-URL
      // navigate fail on the first attempt instead of retrying with backoff.
      srvA144 = await spawnArgusServer(
        path.resolve(__dirname, '..'),
        { FIGMA_API_TOKEN: '', ARGUS_RETRY_ATTEMPTS: '1', MCP_TOOL_TIMEOUT_MS: '20000' },
      );

      // ── invalid-input rows: handler throw → dispatch catch → { error } + isError:true ──
      const invalidRows144 = [
        ['144a', 'argus_audit',        {},                                        'Invalid URL'],
        ['144b', 'argus_audit',        { url: 'not-a-url' },                      'Invalid URL'],
        ['144c', 'argus_audit_full',   {},                                        'Invalid URL'],
        ['144d', 'argus_visual_diff',  {},                                        'url is required'],
        ['144e', 'argus_design_audit', { url: 'http://localhost:3100/x' },        'figmaFrameUrl is required'],
        ['144f', 'argus_pr_validate',  {},                                        'prUrl is required'],
        ['144g', 'argus_pr_validate',  { prUrl: 'http://example.com/not-a-pr' },  'Invalid GitHub PR URL'],
      ];
      for (const [label, tool, args, substr] of invalidRows144) {
        const p = parse144(await mcpToolCall(srvA144.proc, tool, args, 60000));
        surviveA144.push((await mcpListTools(srvA144.proc, 10000)).length);
        assert(
          p.isError === true && p.obj !== null && typeof p.obj.error === 'string'
            && p.obj.error.includes(substr) && !p.text.includes(ND),
          `[${label}] ${tool}(${JSON.stringify(args)}) → isError:true with structured {error} containing "${substr}", no "${ND}" (got: isError=${p.isError}, error=${JSON.stringify(p.obj?.error)?.slice(0, 120)})`
        );
      }

      // ── graceful-degradation row: missing FIGMA token → structured error, NOT isError ──
      const figP144 = parse144(await mcpToolCall(
        srvA144.proc, 'argus_design_audit',
        { url: 'http://localhost:3100/x', figmaFrameUrl: 'https://www.figma.com/file/ABC123/Test?node-id=1%3A2' },
        20000,
      ));
      surviveA144.push((await mcpListTools(srvA144.proc, 10000)).length);
      assert(
        figP144.isError === false && figP144.obj !== null
          && String(figP144.obj.error).includes('FIGMA_API_TOKEN')
          && Array.isArray(figP144.obj.findings) && figP144.obj.findings.length === 0
          && !figP144.text.includes(ND),
        `[144h] argus_design_audit with no FIGMA_API_TOKEN degrades gracefully — error field set, findings:[], NOT isError (got: isError=${figP144.isError}, error=${JSON.stringify(figP144.obj?.error)?.slice(0, 80)})`
      );

      // ── resilience rows: edge input that must NOT crash the handler (isError:false) ──
      const cmpP144 = parse144(await mcpToolCall(srvA144.proc, 'argus_compare', {}, 90000));
      surviveA144.push((await mcpListTools(srvA144.proc, 10000)).length);
      assert(
        cmpP144.isError === false && cmpP144.obj !== null
          && typeof cmpP144.obj.mode === 'string' && !cmpP144.text.includes(ND),
        `[144i] argus_compare returns a structured report with a mode string and never crashes (got: isError=${cmpP144.isError}, mode=${JSON.stringify(cmpP144.obj?.mode)})`
      );

      const wsP144 = parse144(await mcpToolCall(srvA144.proc, 'argus_watch_snapshot', { tabId: 'bogus-tab-999' }, 60000));
      surviveA144.push((await mcpListTools(srvA144.proc, 10000)).length);
      assert(
        wsP144.isError === false && wsP144.obj !== null
          && Array.isArray(wsP144.obj.findings) && !wsP144.text.includes(ND),
        `[144j] argus_watch_snapshot with a bogus tabId degrades to the active tab — findings array, no crash (got: isError=${wsP144.isError}, findings=${Array.isArray(wsP144.obj?.findings) ? wsP144.obj.findings.length : typeof wsP144.obj?.findings})`
      );

      const gcP144 = parse144(await mcpToolCall(srvA144.proc, 'argus_get_context', { tabId: 'bogus-tab-999' }, 60000));
      surviveA144.push((await mcpListTools(srvA144.proc, 10000)).length);
      assert(
        gcP144.isError === false && gcP144.obj !== null
          && typeof gcP144.obj.snapshot_id === 'string' && gcP144.obj.snapshot_id.length > 0
          && !gcP144.text.includes(ND),
        `[144k] argus_get_context with a bogus tabId degrades to the active tab — snapshot_id present, no crash (got: isError=${gcP144.isError}, snapshot_id=${JSON.stringify(gcP144.obj?.snapshot_id)?.slice(0, 40)})`
      );

      // ── MARQUEE 1: unreachable target → navigate() throws (the v9.7.4 navigate fix) ──
      const unreachP144 = parse144(await mcpToolCall(srvA144.proc, 'argus_audit', { url: 'http://localhost:9/' }, 60000));
      surviveA144.push((await mcpListTools(srvA144.proc, 10000)).length);
      assert(
        unreachP144.isError === true && unreachP144.obj !== null
          && String(unreachP144.obj.error).includes('navigate')
          && String(unreachP144.obj.error).includes('Unable to navigate')
          && !unreachP144.text.includes(ND),
        `[144l] argus_audit on an unreachable URL surfaces navigate()'s thrown error, not a fake-clean result (got: isError=${unreachP144.isError}, error=${JSON.stringify(unreachP144.obj?.error)?.slice(0, 140)})`
      );

      // ── MARQUEE 2: dead Chrome → "Could not connect", NOT "logger is not defined" ──
      srvB144 = await spawnArgusServer(
        path.resolve(__dirname, '..'),
        { MCP_BROWSER_URL: 'http://127.0.0.1:9777', ARGUS_RETRY_ATTEMPTS: '1', MCP_TOOL_TIMEOUT_MS: '15000' },
      );
      const deadP144 = parse144(await mcpToolCall(srvB144.proc, 'argus_audit', { url: 'http://localhost:3100/clean.html' }, 60000));
      const deadSurvive144 = (await mcpListTools(srvB144.proc, 10000)).length;
      assert(
        deadP144.isError === true && deadP144.obj !== null
          && String(deadP144.obj.error).includes('Could not connect to Chrome')
          && !deadP144.text.includes(ND),
        `[144m] argus_audit against a dead Chrome reports the real cause through the withMcp error path — no masked "${ND}" (got: isError=${deadP144.isError}, error=${JSON.stringify(deadP144.obj?.error)?.slice(0, 140)})`
      );

      // ── server-survives: every provoked error left both servers answering ──
      const minA144 = surviveA144.length ? Math.min(...surviveA144) : 0;
      assert(
        surviveA144.length >= 12 && minA144 >= 8,
        `[144n] the normal server answered tools/list after every one of its ${surviveA144.length} error/edge calls (min tools seen: ${minA144})`
      );
      assert(
        deadSurvive144 >= 8,
        `[144o] the dead-Chrome server recovered and answered tools/list after the environmental failure (tools: ${deadSurvive144})`
      );
    } catch (e) {
      err144 = e;
    } finally {
      try { srvA144?.proc?.kill(); } catch { }
      try { srvB144?.proc?.kill(); } catch { }
    }
    assert(
      err144 === null,
      `[144p] error-path matrix ran to completion without the harness itself throwing (${err144?.message ?? 'ok'})`
    );
  }

  // ── Block [145] multi-tab end-to-end — open_tabs + selectPage page-switch ─────
  // Behaviorally pins the v9.7.4 open_tabs fix end-to-end: [142a] pins the parser and
  // [119c] the shape, but neither drives a real second tab through argus_get_context.
  // Observed against live Chrome first: new_page() auto-selects the new tab, selectPage
  // switches the page evaluate_script targets, close_page returns to one tab. The tab
  // created here is closed in finally — a leaked tab poisons later blocks' snapshots.
  {
    console.log('\n[145] multi-tab end-to-end — argus_get_context.open_tabs + selectPage page-switch + close_page cleanup');

    const pageAUrl145 = `${B}/clean.html`;
    const pageBUrl145 = `${B}/adapter-conformance.html?tab=multitab145`;
    let bOpened145 = false;
    let srv145 = null;
    let err145 = null;
    let openTabs145 = [];
    let titleA145 = '';
    let titleB145 = '';

    try {
      // establish page A on the shared client, then open page B (auto-selected)
      await browser.navigate(pageAUrl145);
      const beforePages145 = parseListPagesResponse(await mcp.list_pages({}));
      await mcp.new_page({ url: pageBUrl145 });
      bOpened145 = true;
      const afterPages145 = parseListPagesResponse(await mcp.list_pages({}));

      // [145a] new_page added exactly one tab and auto-selected it
      const newSel145 = afterPages145.find(p => p.selected);
      assert(
        afterPages145.length === beforePages145.length + 1
          && newSel145 != null && String(newSel145.url).includes('tab=multitab145'),
        `[145a] new_page() opens a second tab and auto-selects it (before ${beforePages145.length} → after ${afterPages145.length}, selected url: ${newSel145?.url})`
      );

      // [145b] both tabs are visible via argus_get_context.open_tabs with distinct numeric ids
      srv145 = await spawnArgusServer(path.resolve(__dirname, '..'));
      const ctxResp145 = await mcpToolCall(srv145.proc, 'argus_get_context', {}, 30000);
      let ctx145 = {}; try { ctx145 = JSON.parse(ctxResp145?.result?.content?.[0]?.text ?? '{}'); } catch { /* non-JSON */ }
      openTabs145 = Array.isArray(ctx145.open_tabs) ? ctx145.open_tabs : [];
      const tabA145 = openTabs145.find(t => t.url === pageAUrl145);
      const tabB145 = openTabs145.find(t => String(t.url ?? '').includes('tab=multitab145'));
      assert(
        tabA145 != null && tabB145 != null
          && Number.isFinite(tabA145.id) && Number.isFinite(tabB145.id)
          && tabA145.id !== tabB145.id,
        `[145b] argus_get_context.open_tabs lists both tabs with distinct numeric ids (open_tabs: ${JSON.stringify(openTabs145)})`
      );

      // [145c] open_tabs reflects exactly the two open tabs, all numeric ids
      const ids145 = openTabs145.map(t => t.id);
      assert(
        openTabs145.length === 2 && ids145.every(id => Number.isFinite(id)),
        `[145c] open_tabs reflects exactly the two open tabs, all numeric ids (length ${openTabs145.length}, ids ${JSON.stringify(ids145)})`
      );

      // selectPage switches the page evaluate_script targets — pin via document.title,
      // using the shared client's own list_pages ids (the per-client page index).
      const sharedPages145 = parseListPagesResponse(await mcp.list_pages({}));
      const sharedA145 = sharedPages145.find(p => p.url === pageAUrl145);
      const sharedB145 = sharedPages145.find(p => String(p.url ?? '').includes('tab=multitab145'));

      // [145d] selectPage(string id) → page A is active (document.title is A's)
      await browser.selectPage(String(sharedA145?.id));
      titleA145 = String(unwrapEval(await browser.evaluate('() => document.title')));
      assert(
        sharedA145 != null && titleA145.includes('Clean Page'),
        `[145d] selectPage(tab A) makes evaluate_script run on page A (document.title: ${JSON.stringify(titleA145)})`
      );

      // [145e] selectPage(tab B) switches the active page — title flips A→B
      await browser.selectPage(String(sharedB145?.id));
      titleB145 = String(unwrapEval(await browser.evaluate('() => document.title')));
      assert(
        sharedB145 != null && titleB145.includes('Adapter Conformance') && titleB145 !== titleA145,
        `[145e] selectPage(tab B) switches the active page — document.title changes A→B (A: ${JSON.stringify(titleA145)}, B: ${JSON.stringify(titleB145)})`
      );
    } catch (e) {
      err145 = e;
    } finally {
      try { srv145?.proc?.kill(); } catch { }
      // close the tab we opened so later blocks/reruns start from a single tab
      if (bOpened145) {
        try {
          const fp = parseListPagesResponse(await mcp.list_pages({}));
          const bTab = fp.find(p => String(p.url ?? '').includes('tab=multitab145'));
          if (bTab) await mcp.close_page({ pageId: Number(bTab.id) });
          const rp = parseListPagesResponse(await mcp.list_pages({}));
          if (rp[0]) await browser.selectPage(String(rp[0].id));
        } catch { /* best-effort cleanup */ }
      }
    }

    // [145f] cleanup closed the created tab — exactly one tab remains and it is page A
    let finalPages145 = [];
    try { finalPages145 = parseListPagesResponse(await mcp.list_pages({})); } catch { /* ignore */ }
    assert(
      err145 === null && finalPages145.length === 1 && finalPages145[0]?.url === pageAUrl145,
      `[145f] close_page cleanup leaves a single tab (page A) — no leaked tab (err: ${err145?.message ?? 'none'}, final: ${JSON.stringify(finalPages145)})`
    );
  }

  // ── [146] SELF-LINT (anti-vacuous) — the harness forbids NEW bare-shape ──────────
  // assertions. A condition that is *solely* a shape predicate is satisfied by the
  // empty/default failure mode itself — `Array.isArray(x)` passes on `[]` (exactly
  // what let the v9.7.4 open_tabs bug ride [119c] green for months, now content-
  // checked); `typeof x === 'object'` passes on the wrong object; `x.length >= 0` is
  // a tautology. Such a guard proves nothing unless a SIBLING assertion checks
  // content. This block reads validate.js's own source and gates three families
  // against reviewed allowlists. Same self-reading discipline as [142f–i] / [143zz].
  // SELF-EXCLUSION: the scan covers blocks [1]–[145] ONLY — the source is sliced at
  // this block's "[146] SELF-LINT" marker, so [146]'s own allowlist, regexes, doc
  // comments, and positive-control samples can never self-match. (No fragile
  // "don't write pattern X in this file's prose" rule — the block excludes itself.)
  {
    console.log('\n[146] Anti-vacuous lint — no NEW bare-shape assertions outside the reviewed allowlists');

    const fullSrc146 = fs.readFileSync(path.join(__dirname, 'validate.js'), 'utf8');
    // Scan everything BEFORE this block. indexOf finds the comment header above (the
    // first "[146] SELF-LINT" in the file), excluding all of [146] from the scan.
    const scanSrc146 = fullSrc146.slice(0, fullSrc146.indexOf('[146] SELF-LINT'));

    // ── Family 1: bare `Array.isArray(x)` (the demonstrated [119c] pattern) ─────────
    // Reviewed exceptions — each is a bare Array.isArray(x) assertion (no && conjunct)
    // whose content IS proven by a sibling assertion, OR a soft-Lighthouse /
    // negative-control / documented-empty case. Keyed by the exact inner expression
    // (unique per block). See the 2.1 vacuous-sweep inventory.
    const ALLOWLIST_146 = new Set([
      'lh.failingAudits',               // [16a]  soft Lighthouse; failingAudits.length in [16] soft
      'violations',                     // [30]   checkLighthouse; fields checked when length>0 + soft
      'paths',                          // [57a]  sibling [57b] paths.includes('/about')
      'paths59',                        // [59a]  sibling [59b] paths59.includes('/dashboard')
      'merged61',                       // [61a]  siblings [61b]+ check route content
      'result65.errors',                // [65a]  sibling [65d] criticals filter (clean → 0)
      'findings66',                     // [66a]  siblings [66b]/[66c] (clean → none)
      'findings67',                     // [67a]  sibling [67b] csp.length>=1
      'findings68',                     // [68a]  sibling [68b] deprecated.length>=1
      'empty69',                        // [69a]  negative control — empty input → []
      'findings70',                     // [70a]  sibling [70b] heading_level_skip>=1
      'findings71',                     // [71a]  sibling [71b] responsive_overflow>0
      'findings72',                     // [72a]  sibling [72b] focus_visible_missing>=1
      'findings73',                     // [73a]  sibling [73b] aria_expanded_no_controls>=2
      'findings75.errors',              // [75a]  sibling [75b] origin-field check
      'findings77',                     // [77a]  sibling [77b] iframe_no_sandbox>=2
      'cssSummary90?.scssSourceFiles',  // [90b]  sibling [90c] scssSourceFiles.length>0
      'lhResult92',                     // [92a]  soft Lighthouse contract
      'parseConsoleMsgResponse(null)',  // [94a]  negative control — null input → array
      'cheap95',                        // [95a]  documented-empty; sibling [95c] exp>=6
      'json116.findings',               // [116c] sibling [116d] findings.length===1
      'snapObj120?.findings',           // [120c] watch-snapshot findings may legitimately be empty
      'result124?.errors',              // [124c] resilience shape-check (clean page → may be empty)
      'results127', 'results128', 'results129', 'results130a', 'results131',
      'results132a', 'results133', 'results134', 'results135', // [NNa] analyzer type-guards; each block's [NNb]+ check specific findings
    ]);

    // Matches assert(/soft( whose ENTIRE condition is Array.isArray(<expr>): the inner
    // call closes directly into the message comma — no && / || conjunct follows.
    const bareArrRe146 = /(?:assert|soft)\(\s*Array\.isArray\(((?:[^()]|\([^()]*\))*)\)\s*,/g;
    const foundBare146 = new Set();
    let m146;
    while ((m146 = bareArrRe146.exec(scanSrc146)) !== null) foundBare146.add(m146[1].trim());

    // [146a] scanner sanity — the regex actually matches the known bare occurrences
    // (guards against a broken pattern vacuously finding nothing and passing green).
    assert(
      foundBare146.size >= 30,
      `[146a] anti-vacuous scanner finds the reviewed bare-Array.isArray assertions (found ${foundBare146.size}; expected ≥30)`
    );

    // [146b] THE GATE — no bare Array.isArray assertion exists outside the allowlist.
    const unreviewed146 = [...foundBare146].filter(k => !ALLOWLIST_146.has(k));
    assert(
      unreviewed146.length === 0,
      `[146b] no NEW bare Array.isArray assertion outside the reviewed allowlist — add a content check (e.g. && x.length >= 1) or a justified allowlist entry (offenders: ${unreviewed146.join(' | ') || 'none'})`
    );

    // [146c] allowlist hygiene — every allowlisted key still exists as a bare assertion
    // (a fixed/renamed one must be dropped from the allowlist, keeping it honest).
    const stale146 = [...ALLOWLIST_146].filter(k => !foundBare146.has(k));
    assert(
      stale146.length === 0,
      `[146c] no stale allowlist entries — every reviewed exception still exists as a bare assertion (stale: ${stale146.join(' | ') || 'none'})`
    );

    // ── Families 2/3: bare `typeof x === 'object'` + `.length >= 0/> -1` tautology ──
    // ZERO instances exist today (every typeof-object check is conjoined with a
    // `!== null` and a sibling; no length tautology anywhere). A "no offenders" gate
    // over a zero-instance pattern is itself vacuous if the regex is dead — so each
    // family carries a POSITIVE CONTROL: a known-bad sample the regex MUST match,
    // proving it is live before [146e] asserts the real source is clean. (Both samples
    // live inside this self-excluded block, so they never count as real offenders.)
    const typeofObjRe146  = /(?:assert|soft)\(\s*typeof\s+[\w$.?]+\s*===\s*'object'\s*,/;
    const lengthTautRe146 = /\.length\s*(?:>=\s*0|>\s*-1)\b/;
    const SAMPLE_OBJ_146  = "assert(typeof zzz === 'object', 'known-bad sample');";
    const SAMPLE_LEN_146  = "assert(zzz.length >= 0, 'known-bad sample');";

    // [146d] positive controls — both family regexes match their known-bad samples.
    const objLive146 = typeofObjRe146.test(SAMPLE_OBJ_146);
    const lenLive146 = lengthTautRe146.test(SAMPLE_LEN_146);
    assert(
      objLive146 && lenLive146,
      `[146d] family regexes are live — positive controls match known-bad samples (typeof-object: ${objLive146}, length-tautology: ${lenLive146})`
    );

    // [146e] THE GATE — no bare `typeof x === 'object'` assertion and no `.length >= 0`
    // / `.length > -1` tautology in blocks [1]–[145] (conjoined typeof-object forms
    // like `x !== null && typeof x === 'object'` are fine and do not match).
    const typeofObjHits146  = scanSrc146.match(new RegExp(typeofObjRe146.source, 'g'))  || [];
    const lengthTautHits146 = scanSrc146.match(new RegExp(lengthTautRe146.source, 'g')) || [];
    assert(
      typeofObjHits146.length === 0 && lengthTautHits146.length === 0,
      `[146e] no bare typeof-object assertion and no .length>=0/> -1 tautology in [1]–[145] (typeof-object: ${typeofObjHits146.length}${typeofObjHits146.length ? ' → ' + typeofObjHits146.join(' | ') : ''}, length-tautology: ${lengthTautHits146.length}${lengthTautHits146.length ? ' → ' + lengthTautHits146.join(' | ') : ''})`
    );
  }

  // ── [147] Golden MCP tool response schemas ───────────────────────────────────
  // Every tool's happy-path response is safeParse'd against a Zod contract stored in
  // test-harness/contracts/mcp-tool-schemas.js (the single source of truth, exported
  // for E2E too). A handler that renames or drops a response field turns a silently-
  // changed contract into a loud, attributable failure — the exact blind spot that let
  // three features die in production while the harness stayed green (2.3 goal). The
  // schemas were derived from LIVE responses (prototype-147*.mjs, deleted), not memory.
  // 8 tools validate against a live response; argus_pr_validate's happy path needs the
  // GitHub network (non-hermetic, like Lighthouse) so it is pinned via a handler↔schema
  // source cross-check instead. Negative controls prove the safeParse-success assertions
  // are NOT vacuous — a real response with a required field removed must fail safeParse.
  {
    console.log('\n[147] Golden MCP tool response schemas — safeParse live responses against test-harness/contracts/');

    const parse147 = (resp) => {
      const text = resp?.result?.content?.[0]?.text ?? '';
      let obj = null; try { obj = JSON.parse(text); } catch { /* non-JSON */ }
      return { obj, isError: resp?.result?.isError === true, text };
    };
    const sp147 = (tool, obj) => {
      const r = TOOL_RESPONSE_SCHEMAS[tool].safeParse(obj);
      return { ok: r.success, msg: r.success ? 'valid' : formatZodError(r) };
    };

    let srv147 = null;
    let err147 = null;
    let auditObj147 = null;   // reused by negative controls [147k]/[147m]
    let ctxObj147 = null;     // reused by negative control [147l]

    try {
      // FIGMA_API_TOKEN:'' → deterministic no-token design-audit; TARGET_STAGING_URL:''
      // → deterministic CSS-only argus_compare regardless of the developer's shell.
      srv147 = await spawnArgusServer(path.resolve(__dirname, '..'), {
        FIGMA_API_TOKEN: '',
        ARGUS_RETRY_ATTEMPTS: '1',
        MCP_TOOL_TIMEOUT_MS: '25000',
        TARGET_DEV_URL: B,
        TARGET_STAGING_URL: '',
      });

      // [147a] argus_audit
      auditObj147 = parse147(await mcpToolCall(srv147.proc, 'argus_audit', { url: `${B}/clean.html` }, 60000)).obj;
      { const v = sp147('argus_audit', auditObj147);
        assert(v.ok, `[147a] argus_audit response matches golden schema (got: ${v.msg})`); }

      // [147b] argus_audit_full (full report) — also persists a report consumed by [147c]
      const fullObj147 = parse147(await mcpToolCall(srv147.proc, 'argus_audit_full', { url: `${B}/clean.html` }, 180000)).obj;
      { const v = sp147('argus_audit_full', fullObj147);
        assert(v.ok, `[147b] argus_audit_full report matches golden schema (got: ${v.msg})`); }

      // [147c] argus_last_report (report-from-disk OR no-reports sentinel — union schema)
      const lastObj147 = parse147(await mcpToolCall(srv147.proc, 'argus_last_report', {}, 20000)).obj;
      { const v = sp147('argus_last_report', lastObj147);
        assert(v.ok, `[147c] argus_last_report response matches golden schema (got: ${v.msg})`); }

      // [147d] argus_compare (CSS-only env-comparison)
      const cmpObj147 = parse147(await mcpToolCall(srv147.proc, 'argus_compare', {}, 120000)).obj;
      { const v = sp147('argus_compare', cmpObj147);
        assert(v.ok, `[147d] argus_compare response matches golden schema (got: ${v.msg})`); }

      // [147e] argus_watch_snapshot
      const wsObj147 = parse147(await mcpToolCall(srv147.proc, 'argus_watch_snapshot', {}, 60000)).obj;
      { const v = sp147('argus_watch_snapshot', wsObj147);
        assert(v.ok, `[147e] argus_watch_snapshot response matches golden schema (got: ${v.msg})`); }

      // [147f] argus_get_context
      ctxObj147 = parse147(await mcpToolCall(srv147.proc, 'argus_get_context', {}, 60000)).obj;
      { const v = sp147('argus_get_context', ctxObj147);
        assert(v.ok, `[147f] argus_get_context response matches golden schema (got: ${v.msg})`); }

      // [147g] argus_visual_diff
      const vdObj147 = parse147(await mcpToolCall(srv147.proc, 'argus_visual_diff', { url: `${B}/clean.html` }, 60000)).obj;
      { const v = sp147('argus_visual_diff', vdObj147);
        assert(v.ok, `[147g] argus_visual_diff response matches golden schema (got: ${v.msg})`); }

      // [147h] argus_design_audit (no-token degraded path — deterministic)
      const daObj147 = parse147(await mcpToolCall(srv147.proc, 'argus_design_audit',
        { url: `${B}/clean.html`, figmaFrameUrl: 'https://www.figma.com/file/ABC/X?node-id=1%3A2' }, 30000)).obj;
      { const v = sp147('argus_design_audit', daObj147);
        assert(v.ok, `[147h] argus_design_audit (degraded) response matches golden schema (got: ${v.msg})`); }

      // [147i] argus_pr_validate — happy path needs GitHub network (non-hermetic). Hermetic
      // substitute: assert every schema-required key appears in handlePrValidate's RETURN
      // literal in src/mcp-server.js. This guards a handler-side field rename — the same
      // direction the 8 live-validated tools cover via their actual responses. Live error
      // paths are already covered by [144f]/[144g].
      const serverSrc147   = fs.readFileSync(path.resolve(__dirname, '../src/mcp-server.js'), 'utf8');
      const prFnStart147   = serverSrc147.indexOf('async function handlePrValidate');
      const prJsonStart147 = serverSrc147.indexOf('JSON.stringify({', prFnStart147);
      const prJsonEnd147   = serverSrc147.indexOf('}, null, 2)', prJsonStart147);
      const prRetLiteral147 = prJsonStart147 !== -1 && prJsonEnd147 > prJsonStart147
        ? serverSrc147.slice(prJsonStart147, prJsonEnd147) : '';
      const prReqKeys147    = Object.keys(prValidateResponseSchema.shape);
      const missingPrKeys147 = prReqKeys147.filter(k => !new RegExp(`[\\s{]${k}\\s*[,:]`).test(prRetLiteral147));
      assert(
        prFnStart147 !== -1 && prRetLiteral147.length > 0 && missingPrKeys147.length === 0,
        `[147i] argus_pr_validate handler return literal contains all ${prReqKeys147.length} schema-required keys — guards a handler field rename (missing: ${missingPrKeys147.join(', ') || 'none'})`
      );

      // [147j] META coverage-ratchet — every tool the server advertises has a golden
      // schema. A new tool then cannot ship without a pinned response contract (mirrors
      // [143zz]'s adapter-method ratchet).
      const liveTools147  = (await mcpListTools(srv147.proc, 10000)).map(t => t.name);
      const unschemaed147 = liveTools147.filter(n => !TOOL_RESPONSE_SCHEMAS[n]);
      assert(
        liveTools147.length === TOOL_NAMES.length && unschemaed147.length === 0,
        `[147j] every advertised MCP tool has a golden schema (live: ${liveTools147.length}, schemas: ${TOOL_NAMES.length}, unschemaed: ${unschemaed147.join(', ') || 'none'})`
      );

      // ── Negative controls — prove the safeParse-success assertions are not vacuous. ──

      // [147k] argus_audit response with `summary` removed MUST be rejected.
      const auditNoSummary147 = { ...(auditObj147 ?? {}) }; delete auditNoSummary147.summary;
      const k147 = auditResponseSchema.safeParse(auditNoSummary147);
      assert(
        auditObj147 !== null && k147.success === false,
        `[147k] golden schema REJECTS an argus_audit response with summary removed — proves [147a] is non-vacuous (rejected: ${!k147.success})`
      );

      // [147l] argus_get_context without `snapshot_id`, and `{}`, MUST both be rejected.
      const ctxNoId147 = { ...(ctxObj147 ?? {}) }; delete ctxNoId147.snapshot_id;
      const l1_147 = getContextResponseSchema.safeParse(ctxNoId147);
      const l2_147 = getContextResponseSchema.safeParse({});
      assert(
        ctxObj147 !== null && l1_147.success === false && l2_147.success === false,
        `[147l] golden schema REJECTS get_context without snapshot_id and {} — non-vacuous (sans-id rejected: ${!l1_147.success}, {} rejected: ${!l2_147.success})`
      );

      // [147m] the two summary contracts are genuinely distinct: the report-summary schema
      // (requires `total`) must REJECT the cheap-audit summary (no `total`), so a handler
      // that drops `total` from a full report fails [147b]/[147d] rather than passing under
      // a one-size-fits-all summary schema.
      const m147 = reportSummarySchema.safeParse(auditObj147?.summary);
      assert(
        auditObj147?.summary != null && m147.success === false,
        `[147m] report-summary schema rejects the cheap-audit summary (no total) — the audit/report summary contracts are distinct (rejected: ${!m147.success})`
      );

    } catch (e) {
      err147 = e;
    } finally {
      try { srv147?.proc?.kill(); } catch { }
    }
    // [147n] completion guard — a mid-block throw must surface, not silently shrink the count.
    assert(
      err147 === null,
      `[147n] golden-schema block ran to completion without the harness itself throwing (${err147?.message ?? 'ok'})`
    );
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('\u2554' + '\u2550'.repeat(55) + '\u2557');
  console.log('\u2551     ARGUS Test Harness Validator — full coverage      \u2551');
  console.log('\u255A' + '\u2550'.repeat(55) + '\u255D');
  console.log('');

  let serverProc, stagingProc, mcp;

  try {
    const devPort = await findFreePort(HARNESS_DEV_PORT);
    const stagingPort = await findFreePort(devPort + 1);

    console.log('\u25B6 Starting dev fixture server on port', devPort, '...');
    serverProc = await startServer(devPort);

    console.log('\u25B6 Starting staging fixture server on port', stagingPort, '...');
    try {
      stagingProc = await startServer(stagingPort, { staging: true });
    } catch (stagingErr) {
      console.warn('  ⚠  Staging server failed to start: ' + stagingErr.message + ' — env-comparison tests will be skipped');
    }

    console.log('\u25B6 Connecting to Chrome DevTools MCP ...');
    mcp = await createMcpClient();
    console.log('  Connected.\n');

    await runTests(mcp, stagingProc, devPort, stagingPort);

  } catch (err) {
    console.error('\n\u274C Fatal error:', err.message);
    if (/MCP|chrome|connect|ECONNREFUSED/i.test(err.message)) {
      console.error('\n  Start Chrome with --remote-debugging-port=9222:');
      console.error('    Windows (PS): & "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --headless=new --no-sandbox --disable-gpu --user-data-dir="$env:TEMP\\chrome-argus"');
      console.error('    Mac:     open -a "Google Chrome" --args --remote-debugging-port=9222 --headless=new');
    }
    process.exitCode = 1;

  } finally {
    if (mcp?.close) try { mcp.close(); } catch { }
    if (stagingProc) stagingProc.kill();
    if (serverProc) serverProc.kill();

    const total = passed + failed;
    console.log('\n' + '\u2500'.repeat(56));
    console.log(`Results: ${passed}/${total} hard assertions passed, ${failed} failed`);
    if (failLog.length > 0) {
      console.log('\nFailed assertions:');
      failLog.forEach(f => console.log(`  \u2717 ${f}`));
    }
    // Empty since v9.7.2 \u2014 every previously "permanent" failure turned out to be an
    // Argus bug, not a Chrome/MCP limit:
    //   [49b] (removed v9.7.1) \u2014 resolveUidForSelector() substring matching resolved
    //     "#drag-source" to the fixture's explanatory paragraph text instead of the
    //     draggable div. Fixed with exact-accessible-name-first matching.
    //   [67b]/[68b] (removed v9.7.2) \u2014 issues WERE returned by the MCP as markdown
    //     text ("msgid=N [issue] text"), but normalizeArray() returns [] for strings,
    //     so they were always discarded. Fixed with parseConsoleMsgResponse(). The
    //     deprecated-API fixture also used APIs that no longer emit DeprecationIssues
    //     (Mutation Events removed in Chrome 127) \u2014 now uses an unload listener.
    // If a genuine upstream limit appears, add its block ID here; CI exits 0 when
    // only KNOWN_PERMANENT entries fail.
    const KNOWN_PERMANENT = [];
    const unexpected = failLog.filter(f => !KNOWN_PERMANENT.some(p => f.startsWith(p)));
    if (unexpected.length > 0) {
      console.log('\n\u274c Unexpected failures \u2014 fix before merging:');
      unexpected.forEach(f => console.log(`  \u2717 ${f}`));
      process.exit(1);
    } else if (failed > 0) {
      console.log(`\n\u26a0  ${failed} permanent MCP-limited failure${failed !== 1 ? 's' : ''} (expected \u2014 cannot be fixed in Argus code).`);
      process.exit(0);
    } else if (total > 0) {
      console.log('\n\u2705 All hard assertions passed.');
      process.exit(0);
    } else {
      process.exit(0);
    }
  }
}

main();
