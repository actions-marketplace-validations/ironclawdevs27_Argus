/**
 * ARGUS Font Loading Analyzer (Sprint 5c — A10)
 *
 * Detects web font performance and reliability issues that cause invisible
 * text (FOIT), layout shifts (FOUT/CLS), or deliver fonts in suboptimal formats.
 *
 * Findings emitted:
 *   font_foit_risk         — @font-face with no font-display (defaults to auto = FOIT)
 *   font_fout_risk         — font-display: swap or fallback (layout shift risk)
 *   font_no_fallback       — font-family with web font but no system font fallback
 *   font_slow_load         — web font resource took > threshold ms (PerformanceResourceTiming)
 *   font_suboptimal_format — font served as .ttf or .eot (not .woff2)
 *   font_summary           — info, always emitted
 */

import { registerExpensive } from '../registry.js';
import { unwrapEval }        from './mcp-client.js';
import { childLogger }       from './logger.js';
import { thresholds }        from '../config/targets.js';

const logger         = childLogger('font-analyzer');
const SLOW_FONT_MS   = thresholds.font?.slowLoadMs ?? 1000;

// System font families that serve as valid fallbacks
const SYSTEM_FONTS = /serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|arial|helvetica|verdana|georgia|times|courier|trebuchet|impact|comic sans/i;

const FONT_SCRIPT = `() => {
  var result = {
    fontFaceRules:    [],
    fontFamilyUsages: [],
    slowFonts:        [],
    suboptimalFonts:  [],
  };

  // ── Inspect @font-face rules ───────────────────────────────────────────
  var sheets = Array.from(document.styleSheets);
  for (var i = 0; i < sheets.length; i++) {
    var rules;
    try { rules = Array.from(sheets[i].cssRules || []); } catch { continue; }
    for (var j = 0; j < rules.length; j++) {
      var rule = rules[j];
      if (rule.type !== CSSRule.FONT_FACE_RULE) continue;
      var style       = rule.style;
      var family      = (style.getPropertyValue('font-family') || '').replace(/['"]/g, '').trim();
      var display     = style.getPropertyValue('font-display') || '';
      var src         = style.getPropertyValue('src') || '';

      result.fontFaceRules.push({
        family:  family,
        display: display || 'auto',
        src:     src.slice(0, 200),
        hasDisplay: display !== '',
      });

      // Suboptimal format: .ttf or .eot in src
      if (/\\.ttf|format\\(('|")truetype('|")\\)|format\\(('|")embedded-opentype('|")\\)/.test(src)) {
        result.suboptimalFonts.push({ family: family, src: src.slice(0, 100) });
      }
    }
  }

  // ── Inspect font-family declarations for fallback stacks ──────────────
  for (var si = 0; si < sheets.length; si++) {
    var rules2;
    try { rules2 = Array.from(sheets[si].cssRules || []); } catch { continue; }
    for (var sj = 0; sj < rules2.length; sj++) {
      var r = rules2[sj];
      if (r.type !== CSSRule.STYLE_RULE) continue;
      var ff = r.style && r.style.fontFamily;
      if (!ff) continue;
      // Only flag declarations that reference a custom font (quoted name = web font)
      if (!/'|"/.test(ff)) continue;
      result.fontFamilyUsages.push({
        selector: (r.selectorText || '').slice(0, 80),
        fontFamily: ff.slice(0, 150),
      });
    }
  }

  // ── PerformanceResourceTiming: slow + suboptimal format fonts ─────────
  var fontEntries = performance.getEntriesByType('resource').filter(function(e) {
    return /\\.(woff2?|ttf|otf|eot)(\\?.*)?$/i.test(e.name);
  });
  for (var fi = 0; fi < fontEntries.length; fi++) {
    var fe = fontEntries[fi];
    var duration = Math.round(fe.duration);
    result.slowFonts.push({
      url:      fe.name.slice(0, 150),
      duration: duration,
      format:   /\\.ttf/.test(fe.name) ? 'ttf' : /\\.eot/.test(fe.name) ? 'eot' :
                /\\.woff2/.test(fe.name) ? 'woff2' : 'woff',
    });
  }

  return JSON.stringify(result);
}`;

export async function analyzeFont(browser, url) {
  const findings = [];

  try {
    await browser.navigate(url);
    await browser.waitFor({ state: 'networkidle' }).catch(() => {});
    await new Promise(r => setTimeout(r, 500));
  } catch {
    return findings;
  }

  let data = null;
  try {
    const raw = await browser.evaluate(FONT_SCRIPT);
    const s   = unwrapEval(raw);
    data = typeof s === 'object' ? s : JSON.parse(s);
  } catch (err) {
    logger.warn(`[ARGUS] font-analyzer: failed for ${url}: ${err.message}`);
    data = { fontFaceRules: [], fontFamilyUsages: [], slowFonts: [], suboptimalFonts: [] };
  }

  const fontFaceRules    = data.fontFaceRules    ?? [];
  const fontFamilyUsages = data.fontFamilyUsages ?? [];
  const slowFonts        = data.slowFonts        ?? [];
  const suboptimalFonts  = data.suboptimalFonts  ?? [];

  let foitCount = 0, foutCount = 0, noFallbackCount = 0, slowCount = 0, suboptCount = 0;

  // FOIT risk: @font-face without font-display
  for (const rule of fontFaceRules) {
    if (!rule.hasDisplay) {
      foitCount++;
      findings.push({
        type:       'font_foit_risk',
        message:    `@font-face for '${rule.family}' has no font-display — defaults to 'auto' (FOIT risk in Chrome)`,
        fontFamily: rule.family,
        severity:   'warning',
        url,
      });
    } else if (rule.display === 'swap' || rule.display === 'fallback') {
      // FOUT risk: swap/fallback causes layout shift on font load
      foutCount++;
      findings.push({
        type:        'font_fout_risk',
        message:     `@font-face for '${rule.family}' uses font-display: ${rule.display} — layout shift (CLS) risk if fallback metrics differ`,
        fontFamily:  rule.family,
        fontDisplay: rule.display,
        severity:    'info',
        url,
      });
    }
  }

  // No system fallback: quoted font-family with no generic fallback
  for (const usage of fontFamilyUsages) {
    const hasFallback = SYSTEM_FONTS.test(usage.fontFamily);
    if (!hasFallback) {
      noFallbackCount++;
      findings.push({
        type:       'font_no_fallback',
        message:    `font-family '${usage.fontFamily}' on '${usage.selector}' has no system font fallback — invisible text if web font fails to load`,
        selector:   usage.selector,
        fontFamily: usage.fontFamily,
        severity:   'warning',
        url,
      });
    }
  }

  // Slow font loads (from PerformanceResourceTiming)
  for (const f of slowFonts) {
    if (f.duration > SLOW_FONT_MS) {
      slowCount++;
      findings.push({
        type:     'font_slow_load',
        message:  `Web font took ${f.duration}ms to load (threshold: ${SLOW_FONT_MS}ms): ${f.url}`,
        fontUrl:  f.url,
        duration: f.duration,
        severity: 'warning',
        url,
      });
    }
  }

  // Suboptimal font format (.ttf/.eot in @font-face src)
  for (const f of suboptimalFonts) {
    suboptCount++;
    findings.push({
      type:       'font_suboptimal_format',
      message:    `Font '${f.family}' served in suboptimal format (TTF/EOT) — use WOFF2 for production`,
      fontFamily: f.family,
      severity:   'info',
      url,
    });
  }

  // Summary — always emitted
  findings.push({
    type:           'font_summary',
    foitRisks:      foitCount,
    foutRisks:      foutCount,
    noFallbacks:    noFallbackCount,
    slowLoads:      slowCount,
    suboptimalFmts: suboptCount,
    message:        `Font: ${foitCount} FOIT, ${foutCount} FOUT, ${noFallbackCount} no-fallback, ${slowCount} slow, ${suboptCount} suboptimal-format`,
    severity:       'info',
    url,
  });

  return findings;
}

registerExpensive({
  name:    'font',
  analyze: (browser, url) => analyzeFont(browser, url),
});
