/**
 * ARGUS HAR Network Baseline Recorder (N1)
 *
 * Records all network requests made during a page load as a HAR-style
 * baseline. On first run, saves the baseline. On subsequent runs, diffs
 * the current requests against the baseline and surfaces regressions:
 * new requests, missing requests, and status-code changes.
 *
 * This isolates frontend bugs from backend noise: if a finding appears
 * only when the request set has changed, it is likely environment-specific.
 *
 * Findings emitted:
 *   har_baseline_created   — info, first run: baseline saved
 *   har_new_request        — warning: request not in baseline
 *   har_missing_request    — warning: baseline request no longer made
 *   har_status_changed     — warning/critical: HTTP status differs from baseline
 *   har_comparison_summary — info, always emitted
 *
 * Baseline stored at: {REPORT_OUTPUT_DIR}/baselines/har/{slug}.json
 */

import fs                    from 'fs';
import path                  from 'path';
import { registerExpensive } from '../registry.js';
import { childLogger }       from './logger.js';
import { slugify }           from './slug.js';
import { config }            from '../config/targets.js';

const logger  = childLogger('har-recorder');
const HAR_DIR = path.join(config.outputDir, 'baselines', 'har');

// Normalise a URL for baseline keying — strip query strings that vary per run
// (cache-busters, tokens) to reduce false-positive "new request" findings.
function normaliseUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    // Keep only stable query params — drop ones that look like cache-busters
    const stable = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      if (/^(v|ver|version|_|cb|bust|ts|t)$/i.test(k)) continue;
      stable.set(k, v);
    }
    u.search = stable.toString();
    return u.toString();
  } catch {
    return rawUrl;
  }
}

function toBaselineEntry(req) {
  return {
    request:  { method: req.method ?? 'GET', url: normaliseUrl(req.url) },
    response: { status: req.status ?? 0 },
  };
}

export async function analyzeHar(browser, url, opts = {}) {
  const harDir = opts.baselineDir ?? HAR_DIR;
  const findings = [];

  try {
    await browser.navigate(url);
    await browser.waitFor({ state: 'networkidle' }).catch(() => {});
    await new Promise(r => setTimeout(r, 600));
  } catch {
    return findings;
  }

  // ── Capture current network requests ─────────────────────────────────────
  let requests = [];
  try {
    requests = await browser.listNetwork();
  } catch (err) {
    logger.warn(`[ARGUS] har-recorder: listNetwork failed for ${url}: ${err.message}`);
    return findings;
  }

  const slug    = slugify(url);
  const harFile = path.join(harDir, `${slug}.json`);

  // ── First run: save baseline ──────────────────────────────────────────────
  // Use flag:'wx' for atomic create — throws EEXIST if baseline already exists (TOCTOU-safe).
  fs.mkdirSync(harDir, { recursive: true });
  const baseline = {
    version: '1.2',
    createdAt: new Date().toISOString(),
    url,
    entries: requests.map(toBaselineEntry),
  };
  let harIsNew = false;
  try {
    fs.writeFileSync(harFile, JSON.stringify(baseline, null, 2), { flag: 'wx' });
    harIsNew = true;
  } catch (err) {
    if (err.code !== 'EEXIST') {
      logger.warn(`[ARGUS] har-recorder: failed to write baseline: ${err.message}`);
      return findings;
    }
  }
  if (harIsNew) {

    findings.push({
      type:         'har_baseline_created',
      message:      `HAR baseline saved for ${url} (${requests.length} requests recorded)`,
      requestCount: requests.length,
      baselineFile: harFile,
      severity:     'info',
      url,
    });
    return findings;
  }

  // ── Subsequent runs: compare against baseline ─────────────────────────────
  let existingBaseline;
  try {
    existingBaseline = JSON.parse(fs.readFileSync(harFile, 'utf8'));
  } catch (err) {
    logger.warn(`[ARGUS] har-recorder: failed to read baseline: ${err.message}`);
    return findings;
  }

  const baselineEntries = existingBaseline.entries ?? [];
  const baselineMap     = new Map(baselineEntries.map(e => [normaliseUrl(e.request.url), e]));
  const currentMap      = new Map(requests.map(r => [normaliseUrl(r.url), r]));

  let newCount = 0, missingCount = 0, changedCount = 0;

  // New requests not in baseline
  for (const [normUrl, req] of currentMap) {
    if (!baselineMap.has(normUrl)) {
      newCount++;
      findings.push({
        type:       'har_new_request',
        message:    `New network request not in baseline: ${req.method ?? 'GET'} ${normUrl}`,
        method:     req.method ?? 'GET',
        requestUrl: normUrl,
        status:     req.status ?? 0,
        severity:   'warning',
        url,
      });
    }
  }

  // Baseline requests no longer made
  for (const [normUrl, entry] of baselineMap) {
    if (!currentMap.has(normUrl)) {
      missingCount++;
      findings.push({
        type:       'har_missing_request',
        message:    `Baseline request no longer made: ${entry.request.method} ${normUrl}`,
        method:     entry.request.method,
        requestUrl: normUrl,
        severity:   'warning',
        url,
      });
    }
  }

  // Status code regressions
  for (const [normUrl, req] of currentMap) {
    const base = baselineMap.get(normUrl);
    if (!base) continue;
    const baseStatus = base.response.status;
    const currStatus = req.status ?? 0;
    if (baseStatus !== currStatus && currStatus > 0 && baseStatus > 0) {
      changedCount++;
      findings.push({
        type:           'har_status_changed',
        message:        `HTTP status changed for ${normUrl}: ${baseStatus} → ${currStatus}`,
        requestUrl:     normUrl,
        baselineStatus: baseStatus,
        currentStatus:  currStatus,
        severity:       currStatus >= 400 ? 'critical' : 'warning',
        url,
      });
    }
  }

  findings.push({
    type:            'har_comparison_summary',
    message:         `HAR diff: ${newCount} new, ${missingCount} missing, ${changedCount} status-changed (${requests.length} total vs ${baselineEntries.length} baseline)`,
    newRequests:     newCount,
    missingRequests: missingCount,
    statusChanges:   changedCount,
    totalCurrent:    requests.length,
    totalBaseline:   baselineEntries.length,
    severity:        'info',
    url,
  });

  return findings;
}

registerExpensive({
  name:    'har-recorder',
  analyze: (browser, url) => analyzeHar(browser, url),
});
