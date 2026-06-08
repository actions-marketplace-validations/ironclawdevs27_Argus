#!/usr/bin/env node
/**
 * Argus PR Validator — headless CI entry point for GitHub Actions.
 *
 * Environment variables (set by action.yml):
 *   ARGUS_PR_URL         Full GitHub PR URL, e.g. https://github.com/owner/repo/pull/42 (required)
 *   TARGET_DEV_URL       Base URL of the running application, e.g. https://staging.example.com (required)
 *   ARGUS_BLOCK_ON       critical | warning | none  (default: critical)
 *   GITHUB_TOKEN         GitHub PAT or workflow GITHUB_TOKEN — optional for public repos
 *   ARGUS_ROUTES_FILE    Path to a JSON routes array [{path,name}] — optional, see loadRoutes()
 *   GITHUB_OUTPUT        Set by GitHub runner — path for step output key=value pairs
 *   GITHUB_STEP_SUMMARY  Set by GitHub runner — path for markdown step summary
 *
 * Exit codes:
 *   0 — audit passed (blocked=false) or no routes to audit
 *   1 — audit blocked (findings at or above ARGUS_BLOCK_ON threshold) OR startup error
 *
 * Exports (used by test harness — no Chrome required):
 *   buildStepSummary(opts)     → markdown string
 *   writeGithubOutputs(opts)   → void (writes to GITHUB_OUTPUT file)
 *   writeStepSummary(markdown) → void (writes to GITHUB_STEP_SUMMARY file)
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath }                              from 'url';
import { createMcpClient }                            from '../utils/mcp-client.js';
import { crawlRouteCheap }                            from '../orchestration/crawl-and-report.js';
import { parsePrUrl, fetchPrFiles, mapFilesToRoutes } from '../utils/pr-diff-analyzer.js';

// ── Exported helpers (testable without Chrome) ────────────────────────────────

/**
 * Build a GitHub-flavoured markdown step summary.
 *
 * @param {object} opts
 * @param {boolean} opts.blocked
 * @param {{ critical: number, warning: number, info: number }} opts.summary
 * @param {Array<{ path: string }>} opts.affectedRoutes
 * @param {Array<{ route: string, critical: number, warning: number, info: number, error?: string }>} opts.perRoute
 * @param {Array<object>} opts.findings
 * @param {string[]} opts.changedFiles
 * @param {string} opts.blockOn   critical | warning | none
 * @param {string} [opts.error]   top-level error message (startup / fetch failure)
 * @returns {string}
 */
export function buildStepSummary({ blocked, summary, affectedRoutes, perRoute, findings, changedFiles, blockOn, error }) {
  const icon   = blocked ? '🔴' : summary.critical + summary.warning === 0 ? '✅' : '⚠️';
  const status = blocked ? 'BLOCKED — merge prevented' : 'PASSED';

  let md = `## ${icon} Argus PR Validator — ${status}\n\n`;

  if (error) {
    md += `> **Error:** ${String(error).replace(/`/g, "'")}\n\n`;
  }

  md += `| Metric | Value |\n|--------|-------|\n`;
  md += `| Block threshold | \`${blockOn}\` |\n`;
  md += `| Critical findings | **${summary.critical}** |\n`;
  md += `| Warning findings | ${summary.warning} |\n`;
  md += `| Info findings | ${summary.info} |\n`;
  md += `| Routes audited | ${affectedRoutes.length} |\n`;
  md += `| Files changed | ${changedFiles.length} |\n\n`;

  if (perRoute.length > 0) {
    md += `### Route Breakdown\n\n`;
    md += `| Route | 🔴 Critical | ⚠️ Warning | ℹ️ Info |\n|-------|------------|-----------|--------|\n`;
    for (const r of perRoute) {
      const errNote = r.error ? ` _(error: ${String(r.error).slice(0, 60)})_` : '';
      md += `| \`${r.route}\` | ${r.critical} | ${r.warning} | ${r.info}${errNote} |\n`;
    }
    md += '\n';
  }

  if (findings.length > 0) {
    md += `### Findings\n\n`;
    md += `| Severity | Type | Message | URL |\n|----------|------|---------|-----|\n`;
    const shown = findings.slice(0, 50);
    for (const f of shown) {
      const sev = f.severity === 'critical' ? '🔴 critical'
               : f.severity === 'warning'  ? '⚠️ warning'
               : 'ℹ️ info';
      const msg = String(f.message ?? '').replace(/\|/g, '\\|').slice(0, 100);
      const url = String(f.url     ?? '').replace(/\|/g, '\\|').slice(0, 80);
      md += `| ${sev} | \`${f.type ?? ''}\` | ${msg} | ${url} |\n`;
    }
    if (findings.length > 50) {
      md += `\n_…and ${findings.length - 50} more findings._\n`;
    }
    md += '\n';
  }

  md += `---\n_Powered by [Argus QA](https://argus-qa.com)_\n`;
  return md;
}

/**
 * Write step outputs to $GITHUB_OUTPUT (key=value pairs).
 * No-ops when GITHUB_OUTPUT is not set (local / non-Actions environments).
 */
export function writeGithubOutputs({ blocked, summary, affectedRoutes }) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  const routes = Array.isArray(affectedRoutes)
    ? affectedRoutes.map(r => (typeof r === 'string' ? r : r.path)).join(',')
    : '';
  const lines = [
    `blocked=${blocked}`,
    `critical_count=${summary.critical}`,
    `warning_count=${summary.warning}`,
    `affected_routes=${routes}`,
  ].join('\n') + '\n';
  fs.appendFileSync(outputPath, lines);
}

/**
 * Append markdown to $GITHUB_STEP_SUMMARY.
 * No-ops when GITHUB_STEP_SUMMARY is not set.
 */
export function writeStepSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  fs.appendFileSync(summaryPath, markdown);
}

// ── Route loader ──────────────────────────────────────────────────────────────

async function loadRoutes() {
  // 1. ARGUS_ROUTES_FILE env var
  const routesFile = process.env.ARGUS_ROUTES_FILE;
  if (routesFile) {
    try {
      const raw = JSON.parse(fs.readFileSync(routesFile, 'utf8'));
      if (Array.isArray(raw) && raw.length > 0) {
        console.log(`[argus] Loaded ${raw.length} route(s) from ${routesFile}`);
        return raw;
      }
    } catch (err) {
      console.error(`::warning::Could not parse ARGUS_ROUTES_FILE (${routesFile}): ${err.message}`);
    }
  }

  // 2. argus.routes.json in working directory
  const localFile = path.join(process.cwd(), 'argus.routes.json');
  if (fs.existsSync(localFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(localFile, 'utf8'));
      if (Array.isArray(raw) && raw.length > 0) {
        console.log(`[argus] Loaded ${raw.length} route(s) from argus.routes.json`);
        return raw;
      }
    } catch (err) {
      console.error(`::warning::Could not parse argus.routes.json: ${err.message}`);
    }
  }

  // 3. Default routes from the package's targets.js
  try {
    const { routes } = await import('../config/targets.js');
    if (Array.isArray(routes) && routes.length > 0) {
      return routes;
    }
  } catch { /* targets.js may not export routes in all environments */ }

  // 4. Final fallback — audit root path only
  console.log('[argus] No routes configured — falling back to root path audit');
  return [{ path: '/', name: 'home' }];
}

// ── Main ──────────────────────────────────────────────────────────────────────

// Guard: run main() only when this script is executed directly, not when imported.
const _thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] === _thisFile) {
  await main();
}

async function main() {
  const prUrl     = process.env.ARGUS_PR_URL;
  const targetUrl = process.env.TARGET_DEV_URL ?? 'http://localhost:3000';
  const blockOn   = (process.env.ARGUS_BLOCK_ON ?? 'critical').toLowerCase().trim();
  const token     = process.env.GITHUB_TOKEN;

  // Input validation
  if (!prUrl) {
    console.error('::error::ARGUS_PR_URL is not set. Set it to the full GitHub PR URL (e.g. https://github.com/owner/repo/pull/42).');
    process.exit(1);
  }
  if (!['none', 'warning', 'critical'].includes(blockOn)) {
    console.error(`::error::ARGUS_BLOCK_ON must be none | warning | critical, got: "${blockOn}"`);
    process.exit(1);
  }

  let mcp;
  const changedFiles   = [];
  const affectedRoutes = [];
  const allFindings    = [];
  const perRoute       = [];

  try {
    // Step 1: Fetch the PR file list from GitHub
    console.log(`[argus] Fetching PR diff: ${prUrl}`);
    const files = await fetchPrFiles(prUrl, token);
    changedFiles.push(...files);
    console.log(`[argus] ${files.length} changed file(s)`);

    // Step 2: Map changed files to affected routes
    const routes   = await loadRoutes();
    const affected = mapFilesToRoutes(files, routes);
    affectedRoutes.push(...affected);

    if (affected.length === 0) {
      console.log('[argus] No affected routes resolved — skipping audit');
      const summary = { critical: 0, warning: 0, info: 0 };
      writeGithubOutputs({ blocked: false, summary, affectedRoutes: [] });
      writeStepSummary(buildStepSummary({ blocked: false, summary, affectedRoutes: [], perRoute: [], findings: [], changedFiles: files, blockOn }));
      process.exit(0);
    }

    console.log(`[argus] Auditing ${affected.length} route(s): ${affected.map(r => r.path).join(', ')}`);

    // Step 3: Connect to Chrome via the chrome-devtools MCP client
    console.log('[argus] Connecting to Chrome on port 9222...');
    mcp = await createMcpClient();
    console.log('[argus] Chrome connected.');

    const baseOrigin = new URL(targetUrl).origin;

    // Step 4: Audit each affected route via crawlRouteCheap
    for (const route of affected) {
      const url = new URL(route.path, targetUrl).href;
      console.log(`[argus] → Auditing ${url}`);

      try {
        const raw      = await crawlRouteCheap(route, baseOrigin, mcp);
        const findings = Array.isArray(raw.errors) ? raw.errors : [];
        allFindings.push(...findings);

        const critical = findings.filter(f => f.severity === 'critical').length;
        const warning  = findings.filter(f => f.severity === 'warning').length;
        const info     = findings.filter(f => f.severity === 'info').length;
        perRoute.push({ route: route.path, critical, warning, info });

        console.log(`[argus]   ${url}: ${critical} critical, ${warning} warning, ${info} info`);

        // Emit inline GitHub Actions annotations for visible CI feedback
        for (const f of findings.filter(g => g.severity === 'critical')) {
          console.log(`::error::${String(f.message ?? '').replace(/\n/g, ' ')} [${f.type}] on ${url}`);
        }
        for (const f of findings.filter(g => g.severity === 'warning')) {
          console.log(`::warning::${String(f.message ?? '').replace(/\n/g, ' ')} [${f.type}] on ${url}`);
        }

      } catch (routeErr) {
        console.error(`::warning::Audit failed for ${url}: ${routeErr.message}`);
        perRoute.push({ route: route.path, critical: 0, warning: 0, info: 0, error: routeErr.message });
      }
    }

    // Step 5: Compute aggregate summary and merge-block decision
    const summary = {
      critical: allFindings.filter(f => f.severity === 'critical').length,
      warning:  allFindings.filter(f => f.severity === 'warning').length,
      info:     allFindings.filter(f => f.severity === 'info').length,
    };

    const blocked =
      blockOn === 'critical' ? summary.critical > 0 :
      blockOn === 'warning'  ? summary.critical + summary.warning > 0 :
      false;

    // Step 6: Write GitHub Actions outputs and step summary
    writeGithubOutputs({ blocked, summary, affectedRoutes: affected });
    writeStepSummary(buildStepSummary({ blocked, summary, affectedRoutes: affected, perRoute, findings: allFindings, changedFiles: files, blockOn }));

    // Step 7: Emit JSON result to stdout for downstream pipeline steps
    const result = {
      prUrl, targetUrl,
      affectedRoutes: affected.map(r => r.path),
      changedFiles: files,
      findings: allFindings,
      perRoute,
      summary,
      blocked,
      blockOn,
    };
    console.log(JSON.stringify(result, null, 2));

    if (blocked) {
      console.error(`::error::Argus PR Validator: ${summary.critical} critical finding(s) found. Merge blocked (block-on=${blockOn}).`);
      process.exit(1);
    }

    console.log(`[argus] ✓ Audit passed — ${summary.critical} critical, ${summary.warning} warning, ${summary.info} info.`);
    process.exit(0);

  } catch (err) {
    const summary = { critical: 0, warning: 0, info: 0 };
    console.error(`::error::Argus PR validation failed: ${err.message}`);
    writeGithubOutputs({ blocked: false, summary, affectedRoutes: [] });
    writeStepSummary(buildStepSummary({ blocked: false, summary, affectedRoutes: [], perRoute: [], findings: [], changedFiles, blockOn, error: err.message }));
    process.exit(1);

  } finally {
    if (mcp) {
      try { mcp.close(); } catch { /* ignore teardown errors */ }
    }
  }
}
