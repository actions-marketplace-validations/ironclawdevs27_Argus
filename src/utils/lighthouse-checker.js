/**
 * Argus Lighthouse Checker (extracted D2.5)
 *
 * Extracted from crawl-and-report.js so test-harness/validate.js can import
 * checkLighthouse directly without pulling in the Slack-initialised orchestrator.
 */

import fs from 'node:fs';
import { registerExpensive } from '../registry.js';
import { thresholds }        from '../config/targets.js';
import { childLogger }       from './logger.js';

const logger = childLogger('lighthouse-checker');

/**
 * Parse a chrome-devtools-mcp `lighthouse_audit` response into the Lighthouse
 * result shape this module consumes: `{ categories, audits }` (category scores 0–1,
 * `audits` keyed by id). The tool returns markdown with a "### Reports" section that
 * points at a full `report.json`; we read that for complete category scores +
 * per-audit detail (`auditRefs`, `title`, `description`). If the file is unavailable
 * we fall back to the markdown "### Category Scores" block (scores only, no audits).
 * Returns `{ categories: {}, audits: {} }` when nothing parses — never throws.
 *
 * @param {string} responseText - raw lighthouse_audit response (markdown text)
 * @returns {{ categories: object, audits: object }}
 */
export function parseLighthouseReport(responseText) {
  const text = String(responseText ?? '');
  // Prefer the authoritative report.json (categories + auditRefs + per-audit detail).
  const pathMatch = text.match(/([A-Za-z]:\\[^\r\n]*?report\.json|\/[^\r\n]*?report\.json)/);
  if (pathMatch) {
    try {
      const json = JSON.parse(fs.readFileSync(pathMatch[1].trim(), 'utf8'));
      if (json && typeof json === 'object' && json.categories) {
        return { categories: json.categories, audits: json.audits ?? {} };
      }
    } catch { /* fall through to the markdown scores */ }
  }
  // Fallback: synthesize categories from the "### Category Scores" markdown block,
  // e.g. "- Accessibility: 96 (accessibility)". Scores normalised to 0–1 to match report.json.
  const categories = {};
  const block = text.match(/### Category Scores\s*\n([\s\S]*?)(?:\n###|\s*$)/);
  if (block) {
    for (const m of block[1].matchAll(/^\s*-\s+.+?:\s*([\d.]+)\s*\(([\w-]+)\)\s*$/gm)) {
      categories[m[2]] = { id: m[2], score: Number(m[1]) / 100 };
    }
  }
  return { categories, audits: {} };
}

const LIGHTHOUSE_LABELS = {
  accessibility:    'Accessibility',
  performance:      'Performance',
  seo:              'SEO',
  'best-practices': 'Best Practices',
};

/**
 * Run a full Lighthouse audit (accessibility, performance, SEO, best-practices).
 *
 * Each category is scored:
 *   score < threshold.critical → 'critical' violation
 *   score < threshold.warning  → 'warning'  violation
 *
 * Individual failing audit items (score === 0) are also surfaced.
 *
 * @param {object} browser - CdpBrowserAdapter
 * @param {string} url     - URL being tested
 * @returns {Promise<object[]>} Lighthouse violation findings
 */
export async function checkLighthouse(browser, url) {
  const violations = [];

  // Lighthouse can hang indefinitely on heavy SPAs or when Chrome is under load.
  // 120 s is generous — a real Lighthouse run completes in 15–30 s on most pages.
  const LIGHTHOUSE_TIMEOUT_MS = parseInt(process.env.ARGUS_LIGHTHOUSE_TIMEOUT ?? '120000', 10);

  try {
    // browser.lighthouse navigates to url + audits the current page. lighthouse_audit
    // returns markdown referencing a full report.json — parseLighthouseReport reads that
    // back into the { categories, audits } shape this function consumes. Performance is
    // excluded by the tool (covered by web-vitals); thresholds.lighthouse.performance is
    // simply skipped below when its category is absent.
    const auditPromise = browser.lighthouse(url);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Lighthouse timed out after ${LIGHTHOUSE_TIMEOUT_MS / 1000}s`)), LIGHTHOUSE_TIMEOUT_MS)
    );
    const result = parseLighthouseReport(await Promise.race([auditPromise, timeoutPromise]));

    const categories = result?.categories ?? {};
    const audits     = result?.audits     ?? {};

    for (const [catKey, catThresholds] of Object.entries(thresholds.lighthouse)) {
      const catData = categories[catKey]
        ?? categories[catKey.replace('-', '_')]
        ?? categories[catKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase())];
      const score   = catData?.score ?? result?.[catKey]?.score ?? null;
      if (score == null) continue;

      const pct   = Math.round(score * 100);
      const label = LIGHTHOUSE_LABELS[catKey];

      if (pct < catThresholds.critical) {
        violations.push({
          type:      'lighthouse_score',
          category:  catKey,
          score:     pct,
          threshold: catThresholds.critical,
          message:   `Lighthouse ${label} score ${pct}/100 — critical (threshold: ${catThresholds.critical})`,
          severity:  'critical',
          url,
        });
      } else if (pct < catThresholds.warning) {
        violations.push({
          type:      'lighthouse_score',
          category:  catKey,
          score:     pct,
          threshold: catThresholds.warning,
          message:   `Lighthouse ${label} score ${pct}/100 — needs improvement (threshold: ${catThresholds.warning})`,
          severity:  'warning',
          url,
        });
      }
    }

    for (const [auditId, audit] of Object.entries(audits)) {
      if (audit.score == null || audit.score !== 0) continue;
      if (audit.details?.type === 'manual') continue;

      const auditCategory = Object.entries(categories).find(([, cat]) =>
        cat?.auditRefs?.some?.(ref => ref.id === auditId)
      )?.[0] ?? 'unknown';

      const label = LIGHTHOUSE_LABELS[auditCategory] ?? auditCategory;

      violations.push({
        type:     'lighthouse_audit',
        category: auditCategory,
        auditId,
        title:    audit.title,
        message:  `[${label}] ${audit.title}${audit.description ? ' — ' + audit.description.slice(0, 120) : ''}`,
        severity: 'warning',
        url,
      });
    }

  } catch (err) {
    logger.warn(`[ARGUS] Lighthouse audit skipped for ${url}: ${err.message}`);
  }

  return violations;
}

// ── Self-registration ─────────────────────────────────────────────────────────
registerExpensive({
  name: 'lighthouse',
  async analyze(browser, url) {
    return checkLighthouse(browser, url);
  },
});
