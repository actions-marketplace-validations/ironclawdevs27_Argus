/**
 * Intelligent Baseline Filtering — cross-run noise classifier.
 *
 * Pure algorithmic false-positive filter: no external API, no per-run cost.
 * Tracks which finding keys appeared on which routes across the last N runs
 * (reports/baselines/<branch>-history.json) and flags findings that flip-flop
 * between present and absent as "noisy". Noisy findings are downgraded to
 * severity "info" (never suppressed — visibility is kept) and annotated with
 * `noisy: true`, `noiseScore`, and `originalSeverity`.
 *
 * Distinct from flakiness-detector.js (B4), which compares two crawls WITHIN
 * one run. This module classifies across run HISTORY, catching findings that
 * are stable within a run but unstable between runs (timing-dependent ads,
 * third-party scripts, A/B-tested content).
 *
 * Disable with ARGUS_NOISE_FILTER=0.
 */

import fs   from 'fs';
import path from 'path';
import { findingKey }  from './flakiness-detector.js';
import { childLogger } from './logger.js';

const logger = childLogger('noise-filter');

/** Minimum recorded runs for a route before its findings can be classified noisy. */
export const NOISE_MIN_RUNS = 4;
/** Presence-flip ratio (transitions / (runs - 1)) at or above which a finding is noisy. */
export const NOISE_FLIP_THRESHOLD = 0.4;
/** Maximum run entries kept in the history file. */
export const MAX_HISTORY_RUNS = 20;

/**
 * Load run history from disk. Returns [] when the file is absent or corrupt.
 *
 * @param {string} historyFile
 * @returns {Array<{ runAt: string, routes: Record<string, string[]> }>}
 */
export function loadRunHistory(historyFile) {
  if (!fs.existsSync(historyFile)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Append the current report's finding keys as one run entry, capped at maxRuns.
 * Atomic write (tmp + rename) — same pattern as baseline-manager.
 *
 * @param {string} historyFile
 * @param {object} report  - { generatedAt, routes: [{ url, errors }] }
 * @param {number} [maxRuns]
 */
export function recordRunHistory(historyFile, report, maxRuns = MAX_HISTORY_RUNS) {
  const dir = path.dirname(historyFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const entry = { runAt: report.generatedAt ?? new Date().toISOString(), routes: {} };
  for (const routeResult of (report.routes ?? [])) {
    entry.routes[routeResult.url] = (routeResult.errors ?? []).map(findingKey);
  }

  let history = loadRunHistory(historyFile);
  history.push(entry);
  if (history.length > maxRuns) history = history.slice(-maxRuns);

  const tmp = `${historyFile}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(history, null, 2)); // lgtm[js/network-data-to-file] — intentional: Argus persists crawl history to a local baseline file by design
  fs.renameSync(tmp, historyFile);
}

/**
 * Compute per-finding noise scores from run history.
 *
 * For every route, builds a presence series per finding key across the runs in
 * which that route was crawled, then scores `transitions / (runs - 1)` — 0 for
 * a finding that is always present (or always absent), 1 for one that flips on
 * every consecutive run pair.
 *
 * @param {Array<{ routes: Record<string, string[]> }>} history
 * @returns {Map<string, { score: number, runs: number, transitions: number }>}
 *          keyed by `${url}::${findingKey}`
 */
export function computeNoiseScores(history) {
  const scores = new Map();
  if (!Array.isArray(history) || history.length < 2) return scores;

  // url → array of Set(keys), one per run that crawled the url (run order preserved)
  const routeSeries = new Map();
  for (const run of history) {
    for (const [url, keys] of Object.entries(run.routes ?? {})) {
      if (!routeSeries.has(url)) routeSeries.set(url, []);
      routeSeries.get(url).push(new Set(keys));
    }
  }

  for (const [url, series] of routeSeries) {
    if (series.length < 2) continue;
    const allKeys = new Set();
    for (const runKeys of series) for (const k of runKeys) allKeys.add(k);

    for (const key of allKeys) {
      let transitions = 0;
      for (let i = 1; i < series.length; i++) {
        if (series[i].has(key) !== series[i - 1].has(key)) transitions++;
      }
      scores.set(`${url}::${key}`, {
        score: transitions / (series.length - 1),
        runs: series.length,
        transitions,
      });
    }
  }
  return scores;
}

/**
 * Annotate and downgrade noisy findings in the report (mutates in place).
 *
 * A finding is noisy when its route has ≥ minRuns of history AND its presence
 * flip ratio ≥ flipThreshold. Noisy findings get `noisy: true`, `noiseScore`,
 * `originalSeverity`, and severity downgraded to "info". Caller is responsible
 * for rebuilding report.summary afterwards.
 *
 * @param {object} report
 * @param {Array}  history  - From loadRunHistory()
 * @param {object} [opts]
 * @param {number} [opts.minRuns]
 * @param {number} [opts.flipThreshold]
 * @returns {{ noisyCount: number }}
 */
export function applyNoiseFilter(report, history, { minRuns = NOISE_MIN_RUNS, flipThreshold = NOISE_FLIP_THRESHOLD } = {}) {
  const scores = computeNoiseScores(history);
  let noisyCount = 0;
  if (scores.size === 0) return { noisyCount };

  for (const routeResult of (report.routes ?? [])) {
    for (const finding of (routeResult.errors ?? [])) {
      const entry = scores.get(`${routeResult.url}::${findingKey(finding)}`);
      if (!entry || entry.runs < minRuns || entry.score < flipThreshold) continue;

      finding.noisy = true;
      finding.noiseScore = Math.round(entry.score * 100) / 100;
      if (finding.severity !== 'info') {
        finding.originalSeverity = finding.severity;
        finding.severity = 'info';
      }
      noisyCount++;
    }
  }

  if (noisyCount > 0) {
    logger.info(`[ARGUS] Noise filter: ${noisyCount} flip-flopping finding(s) downgraded to info`);
  }
  return { noisyCount };
}
