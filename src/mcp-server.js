#!/usr/bin/env node
/**
 * Argus MCP Server (v9.6.1)
 *
 * Exposes Argus as an MCP server so Claude (or any MCP client) can call
 * argus_audit, argus_audit_full, argus_compare, argus_last_report, and
 * argus_get_context (fix loop) directly from a conversation without using the CLI.
 *
 * Architecture: MCP-inside-MCP
 *   Claude (MCP client)
 *     → Argus MCP Server (this file)
 *       → chrome-devtools-mcp client (mcp-client.js)
 *         → Chrome (CDP)
 *
 * Registration: add to .mcp.json as "argus" server.
 * Run standalone: node src/mcp-server.js
 */

import { Server }              from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs   from 'fs';
import path from 'path';

import { createMcpClient }                    from './utils/mcp-client.js';
import { crawlRouteCheap, runCrawl }          from './orchestration/crawl-and-report.js';
import { runComparison }                      from './orchestration/env-comparison.js';
import { WatchSession }                       from './orchestration/watch-mode.js';
import { CdpBrowserAdapter }                  from './adapters/browser.js';
import { getFigmaFrame }                      from './adapters/figma.js';
import { analyzeDesignFidelity }             from './utils/design-fidelity-analyzer.js';
import { analyzeVisualRegression }           from './utils/visual-diff-analyzer.js';
import { parsePrUrl, fetchPrFiles, mapFilesToRoutes } from './utils/pr-diff-analyzer.js';

const REPORTS_DIR = path.resolve(process.cwd(), 'reports');

// Fix loop: stores up to 20 snapshots keyed by snapshot_id so argus_get_context
// can diff before/after a fix. Keys are evicted oldest-first when the limit is hit.
const snapshotStore = new Map();
const MAX_SNAPSHOTS = 20;

// Audit cache: stores argus_audit results keyed by URL so cache:true skips re-crawl.
const auditCache = new Map();
const MAX_AUDIT_CACHE = 20;

function storeSnapshot(id, findings) {
  snapshotStore.set(id, findings);
  if (snapshotStore.size > MAX_SNAPSHOTS) {
    snapshotStore.delete(snapshotStore.keys().next().value);
  }
}

function cacheAudit(url, result) {
  auditCache.set(url, { result, ts: Date.now() });
  if (auditCache.size > MAX_AUDIT_CACHE) {
    auditCache.delete(auditCache.keys().next().value);
  }
}

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'argus_audit',
    description: 'Fast QA audit on a URL via Chrome DevTools Protocol. Runs 8 analyzers in one pass: JS errors, unhandled rejections, network failures (4xx/5xx), API frequency loops, CSS cascade issues, SEO violations, security header checks, and accessibility. Returns { findings: [{severity, type, message, url}], summary: {critical, warning, info} }. Use for CI smoke tests and pre-deploy gates. Pass cache: true to skip re-crawl on repeat calls to the same URL within a session — useful in tight fix loops. For Lighthouse scoring and memory leak detection, use argus_audit_full. Requires Chrome running with --remote-debugging-port=9222.',
    inputSchema: {
      type: 'object',
      properties: {
        url:      { type: 'string',  description: 'Full URL to audit, including protocol and path (e.g. http://localhost:3000/checkout). Must be reachable by the running Chrome instance.' },
        critical: { type: 'boolean', description: 'When true, console.error calls are escalated to critical severity. Set true for business-critical routes (login, checkout, dashboard) where any error is a blocker.', default: false },
        cache:    { type: 'boolean', description: 'When true, returns the cached result for this URL if one exists (from a previous argus_audit call in this session) without re-crawling. Use in fix loops to cheaply re-read the last audit while iterating on a fix. Cache is per-session, max 20 entries, LRU eviction.', default: false },
      },
      required: ['url'],
    },
  },
  {
    name: 'argus_audit_full',
    description: 'Deep QA audit — extends argus_audit with Lighthouse performance/accessibility scoring, responsive layout checks across 4 viewports (320/768/1280/1920px), memory leak detection via heap snapshot, hover-state regression detection, and accessibility tree snapshot. Returns full JSON report with findings by severity, Lighthouse scores, and layout overflow details. Use when argus_audit passes clean but visual or performance regressions are suspected. Requires Chrome running with --remote-debugging-port=9222.',
    inputSchema: {
      type: 'object',
      properties: {
        url:      { type: 'string',  description: 'Full URL to audit, including protocol and path (e.g. https://example.com/dashboard). Must be reachable by the running Chrome instance.' },
        critical: { type: 'boolean', description: 'When true, console.error calls are escalated to critical severity. Set true for business-critical routes (login, checkout, dashboard) where any error is a blocker.', default: false },
      },
      required: ['url'],
    },
  },
  {
    name: 'argus_compare',
    description: 'Diffs dev vs staging environments side-by-side. Navigates both URLs, captures screenshots, and runs the full analyzer suite on each, then surfaces regressions — findings present in staging but not dev, or with changed severity. Returns { regressions: [{type, devSeverity, stagingSeverity}], screenshots, summary }. Run before promoting a build to staging to catch environment-specific bugs. Set TARGET_DEV_URL and TARGET_STAGING_URL env vars before starting the server; omit TARGET_STAGING_URL to run CSS-analysis-only mode.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'argus_last_report',
    description: 'Returns the most recent Argus JSON report from the reports/ directory. Report includes a findings array and severity summary (critical/warning/info counts). Returns { "error": "No reports found in reports/" } when no audits have been run yet. Use to retrieve prior results without re-running a scan, or to pipe findings into another analysis tool.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'argus_watch_snapshot',
    description: 'Snapshots the currently open Chrome tab without navigating — captures console errors, network failures (4xx/5xx), CORS blocks, and auth failures in one poll. Returns { findings: [{severity, type, message, url}], newConsole, newNetwork }. Use during active development to inspect what is happening on the current page without running a full audit. Pass tabId to inspect a specific tab (get IDs from argus_get_context or list_pages). Without tabId, reads the active tab. Requires Chrome on --remote-debugging-port=9222 with a page already open.',
    inputSchema: {
      type: 'object',
      properties: {
        url:   { type: 'string', description: 'Optional base URL to attribute findings to (default: TARGET_DEV_URL env var). Does not navigate — reads the currently open Chrome tab.' },
        tabId: { type: 'string', description: 'Optional Chrome page/tab ID (e.g. from a prior argus_get_context response). When provided, switches focus to that tab before snapshotting — useful for SPAs that spawn new windows or multi-tab flows.' },
      },
    },
  },
  {
    name: 'argus_get_context',
    description: 'Captures everything currently broken on the open Chrome tab and formats it as a diagnostic context for Claude to read and suggest fixes. Does NOT navigate — reads the live tab state after user interactions, in authenticated sessions, or mid-flow. Returns { snapshot_id, summary, url, timestamp, critical_issues, warnings, js_errors, network_failures, console_errors, recent_requests, open_tabs }. Fix loop: pass the snapshot_id from a previous call as snapshot_id to get a diff — the response will include resolved (cleared since last snapshot), new_issues (appeared since last snapshot), and persisting (unchanged). Multi-tab: pass tabId to inspect a specific tab, or omit to read the active tab. The open_tabs array always lists all currently open Chrome tabs. Workflow: call argus_get_context → Claude suggests fix → apply fix → call argus_get_context with snapshot_id → verify resolved array is non-empty. Requires Chrome on --remote-debugging-port=9222.',
    inputSchema: {
      type: 'object',
      properties: {
        url:         { type: 'string', description: 'Optional base URL to attribute findings to (default: TARGET_DEV_URL env var). Does not navigate — inspects the currently open Chrome tab.' },
        snapshot_id: { type: 'string', description: 'Optional snapshot_id from a previous argus_get_context call. When provided, the response includes resolved/new_issues/persisting arrays showing what changed since that snapshot.' },
        tabId:       { type: 'string', description: 'Optional Chrome page/tab ID. When provided, switches focus to that specific tab before capturing context — useful for SPAs that spawn new windows (e.g. OAuth popups, checkout flows). Get tab IDs from the open_tabs array in a prior argus_get_context response.' },
      },
    },
  },
  {
    name: 'argus_visual_diff',
    description: 'Screenshot baseline comparison for a URL — captures a PNG screenshot and compares it pixel-by-pixel against a stored baseline using pixelmatch. First call: saves baseline, returns visual_baseline_created (info). Subsequent calls: returns visual_regression (warning ≥0.1% / critical ≥5% pixels changed) + visual_diff_summary (always). Baseline stored in reports/baselines/screenshots/. Use in CI or fix loops to detect unintended visual regressions without a full audit. Pass updateBaseline: true to force-refresh the stored baseline (e.g. after intentional UI changes). Requires Chrome on --remote-debugging-port=9222.',
    inputSchema: {
      type: 'object',
      properties: {
        url:           { type: 'string',  description: 'Full URL to capture and compare (e.g. http://localhost:3000/dashboard). Must be reachable by the running Chrome instance.' },
        updateBaseline: { type: 'boolean', description: 'When true, deletes the existing baseline PNG and saves a fresh one from the current screenshot. Use after intentional UI changes to reset the reference.', default: false },
        baselineDir:   { type: 'string',  description: 'Optional override for the baseline storage directory. Defaults to reports/baselines/screenshots/.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'argus_design_audit',
    description: 'Full design-to-implementation fidelity audit against a Figma frame. 13 mismatch finding types: CSS token values, component presence, fill/text color (RGB delta), typography (fontSize/fontWeight/lineHeight/fontFamily/letterSpacing), Auto Layout padding and gap, border-radius (per-corner), bounding-box overflow, absolute position drift (scroll-corrected x/y, 20px threshold), border stroke (color+weight), box-shadow (offset+blur+spread+color), opacity, and text content. Selector fallback: tries [data-testid], [aria-label], #id, .class per node. Requires FIGMA_API_TOKEN env var and Chrome on --remote-debugging-port=9222. Returns { findings, summary } where summary includes 13 mismatch-type counts.',
    inputSchema: {
      type: 'object',
      properties: {
        url:           { type: 'string', description: 'Full URL of the page to audit (e.g. http://localhost:3000/dashboard). Must be reachable by the running Chrome instance.' },
        figmaFrameUrl: { type: 'string', description: 'Figma frame URL to fetch design tokens from (e.g. https://www.figma.com/file/ABC123/Name?node-id=42%3A0). Must include the node-id query parameter pointing to the specific frame.' },
      },
      required: ['url', 'figmaFrameUrl'],
    },
  },
  {
    name: 'argus_pr_validate',
    description: 'Runs a targeted Argus audit on the routes affected by a GitHub pull request. Fetches the PR diff, maps changed files to routes in your target config using path-slug heuristics (infrastructure changes trigger a full audit; targeted otherwise), and audits only those routes — faster than a full scan and focused on what the PR actually touched. Returns { findings, affectedRoutes, changedFiles, perRoute, summary, blocked, blockOn }. Use in CI to gate merges: check blocked:true or pipe findings to an AI verdict step. Requires Chrome on --remote-debugging-port=9222. GITHUB_TOKEN env var recommended for private repos.',
    inputSchema: {
      type: 'object',
      properties: {
        prUrl:       { type: 'string',  description: 'Full GitHub PR URL (e.g. https://github.com/owner/repo/pull/42). Used to fetch the list of changed files via the GitHub REST API.' },
        targetUrl:   { type: 'string',  description: 'Base URL to audit (e.g. https://staging.example.com). Overrides TARGET_DEV_URL env var.' },
        githubToken: { type: 'string',  description: 'GitHub Personal Access Token or workflow GITHUB_TOKEN. Optional for public repos. Falls back to GITHUB_TOKEN env var.' },
        blockOn:     { type: 'string',  enum: ['none', 'warning', 'critical'], description: '"critical" = block only when critical findings exist. "warning" = block on any warning or critical. "none" = never block. Defaults to ARGUS_BLOCK_ON env var, then "critical".', default: 'critical' },
      },
      required: ['prUrl'],
    },
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function withMcp(fn) {
  const mcp = await createMcpClient();
  try {
    return await fn(mcp);
  } catch (err) {
    logger.error('[ARGUS] MCP tool handler error:', err.message);
    throw err;
  } finally {
    try { mcp.close(); } catch (e) { logger.debug({ err: e }, 'mcp close (ignored)'); }
  }
}

// ── Tool handlers ─────────────────────────────────────────────────────────────

async function handleAudit({ url, critical = false, cache = false }) {
  if (cache && auditCache.has(url)) {
    const { result, ts } = auditCache.get(url);
    return { content: [{ type: 'text', text: JSON.stringify({ ...result, _cached: true, _cachedAt: new Date(ts).toISOString() }, null, 2) }] };
  }
  return withMcp(async (mcp) => {
    const parsed = new URL(url);
    const route  = { path: parsed.pathname + parsed.search + parsed.hash, name: 'audit', critical };
    const raw    = await crawlRouteCheap(route, parsed.origin, mcp);
    const findings = Array.isArray(raw.errors) ? raw.errors : [];
    const result = {
      findings,
      summary: {
        critical: findings.filter(f => f.severity === 'critical').length,
        warning:  findings.filter(f => f.severity === 'warning').length,
        info:     findings.filter(f => f.severity === 'info').length,
      },
      url:        raw.url,
      pageTitle:  raw.pageTitle,
      screenshot: raw.screenshot,
    };
    if (cache) cacheAudit(url, result);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });
}

async function handleAuditFull({ url, critical = false }) {
  return withMcp(async (mcp) => {
    const parsed = new URL(url);
    const report = await runCrawl(
      mcp,
      [{ path: parsed.pathname + parsed.search + parsed.hash, name: 'audit', critical }],
      parsed.origin,
    );
    return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
  });
}

async function handleCompare() {
  return withMcp(async (mcp) => {
    const report = await runComparison(mcp);
    return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
  });
}

async function handleWatchSnapshot({ url, tabId } = {}) {
  return withMcp(async (mcp) => {
    const browser = new CdpBrowserAdapter(mcp);
    if (tabId) await browser.selectPage(tabId);
    const baseUrl = url ?? process.env.TARGET_DEV_URL ?? 'http://localhost:3000';
    const session = new WatchSession(browser, baseUrl);
    const result  = await session.poll();
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });
}

async function handleGetContext({ url, snapshot_id: prevId, tabId } = {}) {
  return withMcp(async (mcp) => {
    const browser = new CdpBrowserAdapter(mcp);
    if (tabId) await browser.selectPage(tabId);
    const baseUrl = url ?? process.env.TARGET_DEV_URL ?? 'http://localhost:3000';
    const session = new WatchSession(browser, baseUrl);
    const { findings, newConsole, newNetwork } = await session.poll();

    // List all open tabs so the caller can target a specific tab on the next call.
    let open_tabs = [];
    try {
      const pages = await browser.listPages();
      if (Array.isArray(pages)) {
        open_tabs = pages.map(p => ({ id: p.id ?? p.pageId, url: p.url, title: p.title }));
      }
    } catch { /* list_pages not available in all Chrome configs — degrade gracefully */ }

    const newId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    storeSnapshot(newId, findings);

    const critical = findings.filter(f => f.severity === 'critical');
    const warnings  = findings.filter(f => f.severity === 'warning');

    const findingKey = (f) => `${f.type}::${(f.message ?? '').slice(0, 120)}`;

    let resolved = [];
    let persisting = [];
    let new_issues = findings;
    const isDiff = prevId && snapshotStore.has(prevId);

    if (isDiff) {
      const prev     = snapshotStore.get(prevId);
      const prevKeys = new Set(prev.map(findingKey));
      const curKeys  = new Set(findings.map(findingKey));
      resolved   = prev.filter(f => !curKeys.has(findingKey(f)));
      persisting = findings.filter(f => prevKeys.has(findingKey(f)));
      new_issues = findings.filter(f => !prevKeys.has(findingKey(f)));
    }

    let summary;
    if (isDiff) {
      if (resolved.length > 0 && critical.length === 0 && warnings.length === 0) {
        summary = `All issues resolved on ${baseUrl}. ${resolved.length} finding${resolved.length > 1 ? 's' : ''} cleared since last snapshot.`;
      } else if (resolved.length > 0) {
        summary = `${resolved.length} issue${resolved.length > 1 ? 's' : ''} resolved on ${baseUrl}. ${new_issues.length} new + ${persisting.length} persisting (${critical.length} critical). Pass the new snapshot_id to continue the fix loop.`;
      } else if (critical.length === 0 && warnings.length === 0) {
        summary = `No issues on ${baseUrl} — console and network are clean.`;
      } else {
        summary = `No change on ${baseUrl}: ${critical.length} critical + ${warnings.length} warning${warnings.length !== 1 ? 's' : ''} still present. Check the persisting array for what hasn't been fixed.`;
      }
    } else if (critical.length === 0 && warnings.length === 0) {
      summary = `No issues detected on ${baseUrl} — console and network are clean.`;
    } else if (critical.length > 0) {
      summary = `${critical.length} critical issue${critical.length > 1 ? 's' : ''} + ${warnings.length} warning${warnings.length !== 1 ? 's' : ''} detected on ${baseUrl}. Focus on critical issues first. Pass snapshot_id to the next argus_get_context call after applying a fix to see what changed.`;
    } else {
      summary = `${warnings.length} warning${warnings.length !== 1 ? 's' : ''} detected on ${baseUrl}. No critical errors. Pass snapshot_id to the next call to verify fixes.`;
    }

    const context = {
      snapshot_id:      newId,
      summary,
      url:              baseUrl,
      timestamp:        new Date().toISOString(),
      critical_issues:  critical,
      warnings,
      js_errors:        findings.filter(f => f.type === 'js-error' || f.type === 'unhandled-rejection'),
      network_failures: findings.filter(f => f.type === 'network-error' || f.type === 'cors-error' || f.type === 'auth-error'),
      console_errors:   newConsole.filter(m => m.level === 'error' || m.level === 'warning'),
      recent_requests:  newNetwork.slice(-20),
      open_tabs,
      ...(isDiff ? { resolved, new_issues, persisting } : {}),
    };

    return { content: [{ type: 'text', text: JSON.stringify(context, null, 2) }] };
  });
}

async function handleVisualDiff({ url, updateBaseline = false, baselineDir }) {
  if (!url) throw new Error('argus_visual_diff: url is required');

  return withMcp(async (mcp) => {
    const browser = new CdpBrowserAdapter(mcp);
    const opts    = baselineDir ? { baselineDir } : {};

    if (updateBaseline) {
      // Delete existing baseline so analyzeVisualRegression treats it as first run
      const path_   = await import('path');
      const fs_     = await import('fs');
      const { slugify } = await import('./utils/slug.js');
      const { config }  = await import('./config/targets.js');
      const dir  = baselineDir ?? path_.default.join(config.outputDir, 'baselines', 'screenshots');
      const file = path_.default.join(dir, `${slugify(url)}.png`);
      try { fs_.default.unlinkSync(file); } catch {}
    }

    const findings = await analyzeVisualRegression(browser, url, opts);
    const regression = findings.find(f => f.type === 'visual_regression');
    const baseline   = findings.find(f => f.type === 'visual_baseline_created');
    const summary    = findings.find(f => f.type === 'visual_diff_summary');

    return { content: [{ type: 'text', text: JSON.stringify({
      findings,
      summary: {
        status:      regression ? 'regression' : baseline ? 'baseline_created' : 'no_change',
        diffPercent: summary?.diffPercent ?? 0,
        diffPixels:  summary?.diffPixels  ?? 0,
        totalPixels: summary?.totalPixels ?? 0,
        severity:    regression?.severity ?? 'info',
      },
    }, null, 2) }] };
  });
}

async function handleDesignAudit({ url, figmaFrameUrl }) {
  if (!url)           throw new Error('argus_design_audit: url is required');
  if (!figmaFrameUrl) throw new Error('argus_design_audit: figmaFrameUrl is required');

  const figmaData = await getFigmaFrame(figmaFrameUrl);
  if (!figmaData) {
    return { content: [{ type: 'text', text: JSON.stringify({
      error: 'Could not fetch Figma data. Ensure FIGMA_API_TOKEN is set and the figmaFrameUrl is valid.',
      findings: [],
      summary: { tokenMismatches: 0, missingComponents: 0, colorMismatches: 0, typographyMismatches: 0, spacingMismatches: 0, radiusMismatches: 0, boundsOverflows: 0, positionDrifts: 0, strokeMismatches: 0, shadowMismatches: 0, opacityMismatches: 0, gapMismatches: 0, textMismatches: 0 },
    }) }] };
  }

  return withMcp(async (mcp) => {
    const browser  = new CdpBrowserAdapter(mcp);
    const findings = await analyzeDesignFidelity(browser, url, figmaData);
    const count    = (type) => findings.filter(f => f.type === type).length;
    const summary  = {
      tokenMismatches:      count('design_token_mismatch'),
      missingComponents:    count('design_component_missing'),
      colorMismatches:      count('design_color_mismatch'),
      typographyMismatches: count('design_typography_mismatch'),
      spacingMismatches:    count('design_spacing_mismatch'),
      radiusMismatches:     count('design_radius_mismatch'),
      boundsOverflows:      count('design_bounds_overflow'),
      positionDrifts:       count('design_position_drift'),
      strokeMismatches:     count('design_stroke_mismatch'),
      shadowMismatches:     count('design_shadow_mismatch'),
      opacityMismatches:    count('design_opacity_mismatch'),
      gapMismatches:        count('design_gap_mismatch'),
      textMismatches:       count('design_text_mismatch'),
    };
    return { content: [{ type: 'text', text: JSON.stringify({ findings, summary }, null, 2) }] };
  });
}

async function handlePrValidate({ prUrl, targetUrl, githubToken, blockOn } = {}) {
  if (!prUrl) throw new Error('argus_pr_validate: prUrl is required');

  const { routes } = await import('./config/targets.js');
  const token  = githubToken ?? process.env.GITHUB_TOKEN;
  const base   = targetUrl  ?? process.env.TARGET_DEV_URL ?? 'http://localhost:3000';
  const policy = blockOn    ?? process.env.ARGUS_BLOCK_ON ?? 'critical';

  const changedFiles   = await fetchPrFiles(prUrl, token);
  const affectedRoutes = mapFilesToRoutes(changedFiles, routes ?? []);

  const allFindings = [];
  const perRoute    = [];

  for (const route of affectedRoutes) {
    const url = new URL(route.path, base).href;
    const res = await handleAudit({ url, critical: route.critical ?? false });
    const data = JSON.parse(res.content[0].text);
    allFindings.push(...(data.findings ?? []));
    perRoute.push({ route: route.path, ...data.summary });
  }

  const summary = {
    critical: allFindings.filter(f => f.severity === 'critical').length,
    warning:  allFindings.filter(f => f.severity === 'warning').length,
    info:     allFindings.filter(f => f.severity === 'info').length,
  };

  const blocked =
    policy === 'critical' ? summary.critical > 0 :
    policy === 'warning'  ? summary.critical + summary.warning > 0 :
    false;

  return { content: [{ type: 'text', text: JSON.stringify({
    prUrl,
    targetUrl: base,
    affectedRoutes: affectedRoutes.map(r => r.path),
    changedFiles,
    findings: allFindings,
    perRoute,
    summary,
    blocked,
    blockOn: policy,
  }, null, 2) }] };
}

async function handleLastReport() {
  if (!fs.existsSync(REPORTS_DIR)) {
    return { content: [{ type: 'text', text: '{"error":"No reports found in reports/"}' }] };
  }
  const files = fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    return { content: [{ type: 'text', text: '{"error":"No reports found in reports/"}' }] };
  }
  const latest = files
    .map(f => ({ f, mt: fs.statSync(path.join(REPORTS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mt - a.mt)[0].f;
  const json = fs.readFileSync(path.join(REPORTS_DIR, latest), 'utf8');
  return { content: [{ type: 'text', text: json }] };
}

// ── Server bootstrap ──────────────────────────────────────────────────────────

const server = new Server(
  { name: 'argus', version: '9.6.1' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    switch (req.params.name) {
      case 'argus_audit':       return await handleAudit(req.params.arguments ?? {});
      case 'argus_audit_full':  return await handleAuditFull(req.params.arguments ?? {});
      case 'argus_compare':     return await handleCompare();
      case 'argus_last_report':     return await handleLastReport();
      case 'argus_watch_snapshot':  return await handleWatchSnapshot(req.params.arguments ?? {});
      case 'argus_get_context':     return await handleGetContext(req.params.arguments ?? {});
      case 'argus_visual_diff':     return await handleVisualDiff(req.params.arguments ?? {});
      case 'argus_design_audit':    return await handleDesignAudit(req.params.arguments ?? {});
      case 'argus_pr_validate':     return await handlePrValidate(req.params.arguments ?? {});
      default: throw new Error(`Unknown tool: ${req.params.name}`);
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
