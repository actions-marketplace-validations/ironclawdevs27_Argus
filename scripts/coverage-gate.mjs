#!/usr/bin/env node
/**
 * Argus coverage gate.
 *
 * Merges the two coverage sources Argus produces with different tools —
 *   - unit suite   → Vitest v8 provider  → coverage/unit/coverage-final.json
 *   - test harness → c8 (plain node)     → coverage/harness/coverage-final.json
 * — into one Istanbul coverage map, then enforces two thresholds:
 *
 *   1. --min-lines <pct>        global line-coverage floor (conservative; ratchet up).
 *   2. --allow-uncovered <csv>  the ONLY src/ files permitted to have ZERO covered lines.
 *                               This is the "zero-coverage module" guard: a new module
 *                               that ships with no unit test AND no harness block is a
 *                               fully-uncovered file NOT on the allowlist → fails CI —
 *                               the exact blind spot the 2026-06-12 audit found
 *                               (screen-recorder, pdf-exporter shipped untested).
 *                               The allowlist holds entry points whose ONLY tests run in
 *                               a spawned subprocess (mcp-server stdio blocks, the Express
 *                               server, env-comparison via argus_compare/staging): c8
 *                               measures the harness IN-PROCESS, so subprocess execution
 *                               is invisible to it and these read as 0% even though they
 *                               are tested. Listing them explicitly is OS-robust — on a
 *                               runner where subprocess coverage DOES propagate they fall
 *                               off the uncovered set and the allowlist is simply unused.
 *   (--max-uncovered <n> is also accepted as a coarser count cap.)
 *
 * Why a merge (not c8 alone): Vitest runs unit tests in worker processes that do not
 * propagate NODE_V8_COVERAGE to c8's temp dir, so c8 cannot see unit coverage. Each
 * tool measures the half it can; this script unions them. Paths are normalised to
 * repo-relative POSIX form so the same file from both tools merges (Windows-safe).
 *
 * Usage:
 *   node scripts/coverage-gate.mjs --min-lines 60 \
 *        --allow-uncovered src/mcp-server.js,src/orchestration/env-comparison.js,src/server/index.js
 *   node scripts/coverage-gate.mjs --report-only          # print, never exit non-zero
 *
 * Inputs may be overridden with --unit <path> / --harness <path>.
 */

import fs   from 'fs';
import path from 'path';
import url  from 'url';
import libCoverage from 'istanbul-lib-coverage';

const { createCoverageMap } = libCoverage;
const ROOT = path.resolve(url.fileURLToPath(new URL('..', import.meta.url)));

// ── arg parsing ───────────────────────────────────────────────────────────────
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const hasFlag      = (name) => process.argv.includes(`--${name}`);
const minLines     = Number(arg('min-lines', process.env.COVERAGE_MIN_LINES ?? '0'));
const maxUncovered = Number(arg('max-uncovered', process.env.COVERAGE_MAX_UNCOVERED ?? 'Infinity'));
const allowUncov   = (arg('allow-uncovered', process.env.COVERAGE_ALLOW_UNCOVERED ?? '') || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const allowSet     = new Set(allowUncov.map(s => s.split(path.sep).join('/')));
const useAllowlist = process.argv.includes('--allow-uncovered') || allowUncov.length > 0;
const reportOnly   = hasFlag('report-only');
const unitPath     = path.resolve(ROOT, arg('unit',    'coverage/unit/coverage-final.json'));
const harnessPath  = path.resolve(ROOT, arg('harness', 'coverage/harness/coverage-final.json'));

// ── normalise + merge ───────────────────────────────────────────────────────────
function loadNormalized(file, label) {
  if (!fs.existsSync(file)) {
    console.warn(`⚠  ${label} coverage not found at ${path.relative(ROOT, file)} — skipping that half.`);
    return {};
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = {};
  for (const [key, val] of Object.entries(raw)) {
    const abs = val.path || key;
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    if (!rel.startsWith('src/')) continue;          // gate src/ only
    out[rel] = { ...val, path: rel };
  }
  return out;
}

const map = createCoverageMap({});
map.merge(createCoverageMap(loadNormalized(unitPath, 'unit')));
map.merge(createCoverageMap(loadNormalized(harnessPath, 'harness')));

const files = map.files().sort();
if (files.length === 0) {
  console.error('✗ No src/ coverage data found in either input. Did the coverage runs produce JSON?');
  process.exit(reportOnly ? 0 : 1);
}

// ── aggregate ───────────────────────────────────────────────────────────────────
let totalLines = 0, coveredLines = 0;
const perFile = [];
for (const f of files) {
  const s = map.fileCoverageFor(f).toSummary();
  totalLines   += s.lines.total;
  coveredLines += s.lines.covered;
  perFile.push({ file: f, pct: s.lines.pct, covered: s.lines.covered, total: s.lines.total });
}
const linesPct   = totalLines ? (coveredLines / totalLines) * 100 : 100;
const uncovered  = perFile.filter(f => f.covered === 0 && f.total > 0);

// ── report ────────────────────────────────────────────────────────────────────
const pct = (n) => `${n.toFixed(2)}%`;
console.log('\n══════════════════ Argus merged coverage (unit + harness) ══════════════════');
console.log(`Files (src/):        ${files.length}`);
console.log(`Lines:               ${coveredLines}/${totalLines}  (${pct(linesPct)})`);
console.log(`Fully-uncovered:     ${uncovered.length} file(s) with 0 covered lines`);

const worst = [...perFile].sort((a, b) => a.pct - b.pct).slice(0, 12);
console.log('\nLowest-covered files:');
for (const f of worst) {
  console.log(`  ${pct(f.pct).padStart(7)}  ${f.file}  (${f.covered}/${f.total})`);
}
const unexpected = uncovered.filter(f => !allowSet.has(f.file));
if (uncovered.length) {
  console.log('\nZero-coverage files:');
  for (const f of uncovered) {
    const ok = allowSet.has(f.file);
    console.log(`  0.00%  ${f.file}${ok ? '  (allowlisted: subprocess/integration-tested)' : '  ◄ NOT allowlisted'}`);
  }
}

// ── gate ────────────────────────────────────────────────────────────────────────
const failures = [];
if (Number.isFinite(minLines) && linesPct < minLines) {
  failures.push(`line coverage ${pct(linesPct)} < --min-lines ${minLines}%`);
}
if (useAllowlist) {
  if (unexpected.length > 0) {
    failures.push(`${unexpected.length} fully-uncovered file(s) not on the allowlist: ${unexpected.map(f => f.file).join(', ')}`);
  }
} else if (Number.isFinite(maxUncovered) && uncovered.length > maxUncovered) {
  failures.push(`${uncovered.length} fully-uncovered files > --max-uncovered ${maxUncovered}`);
}

console.log('\n────────────────────────────────────────────────────────────────────────────');
if (failures.length === 0) {
  const guard = useAllowlist ? `allow-uncovered=[${allowUncov.join(', ') || 'none'}]` : `max-uncovered=${maxUncovered}`;
  console.log(`✅ Coverage gate passed  (min-lines=${minLines}%, ${guard}).`);
  process.exit(0);
}
console.log('✗ Coverage gate FAILED:');
for (const m of failures) console.log(`  • ${m}`);
if (reportOnly) {
  console.log('(--report-only: not failing the build)');
  process.exit(0);
}
process.exit(1);
