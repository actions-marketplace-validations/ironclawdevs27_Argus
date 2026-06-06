/**
 * ARGUS Motion & Animation Accessibility Analyzer (Sprint 5b — A9)
 *
 * Detects pages that trigger motion/animation without respecting the user's
 * `prefers-reduced-motion` OS preference — a WCAG 2.1 SC 2.3.3 (AAA) violation
 * that can trigger vestibular disorders in motion-sensitive users.
 *
 * Findings emitted:
 *   motion_no_reduced_motion_query — CSS animation/transition present but no
 *     @media (prefers-reduced-motion) query anywhere in page stylesheets
 *   motion_autoplay_no_pause       — <video autoplay> without visible pause control
 *     or animated <img> (GIF/APNG/WebP) without pause mechanism
 *   motion_interactive_animation   — transition/animation on interactive elements
 *     (button, a, input, [role=button]) without a reduced-motion override
 *   motion_reduced_not_honoured    — after emulating prefers-reduced-motion: reduce,
 *     animated properties are still applied (requires MCP emulate support)
 *   motion_summary                 — info, always emitted
 */

import { registerExpensive } from '../registry.js';
import { unwrapEval }        from './mcp-client.js';
import { childLogger }       from './logger.js';
import { thresholds }        from '../config/targets.js';

const logger = childLogger('motion-analyzer');

// Threshold: flag animated interactive elements even if count is 1
const ANIM_COUNT_THRESHOLD = thresholds.motion?.animationPropertyCount ?? 1;

// ── In-browser motion analysis script ────────────────────────────────────────
const MOTION_SCRIPT = `() => {
  var result = {
    hasAnimation:        false,
    hasReducedQuery:     false,
    interactiveAnimated: [],
    autoplayVideos:      [],
    animatedImages:      [],
  };

  var INTERACTIVE = ['button','a','input','select','textarea'];
  var ANIM_PROPS  = ['animation','animation-name','transition'];

  // Scan all accessible stylesheets
  var sheets = Array.from(document.styleSheets);
  for (var i = 0; i < sheets.length; i++) {
    var sheet = sheets[i];
    var rules;
    try { rules = Array.from(sheet.cssRules || []); } catch { continue; }
    for (var j = 0; j < rules.length; j++) {
      var rule = rules[j];
      // Check for @media (prefers-reduced-motion)
      if (rule.type === CSSRule.MEDIA_RULE) {
        var condText = rule.conditionText || rule.media && rule.media.mediaText || '';
        if (/prefers-reduced-motion/i.test(condText)) {
          result.hasReducedQuery = true;
        }
      }
      // Check style rules for animation/transition
      if (rule.type === CSSRule.STYLE_RULE && rule.style) {
        var anim = rule.style.animationName || rule.style.animation;
        var trans = rule.style.transition;
        if ((anim && anim !== 'none' && anim !== '') ||
            (trans && trans !== 'none' && trans !== '')) {
          result.hasAnimation = true;
          // Check if selector matches an interactive element
          var sel = rule.selectorText || '';
          var isInteractive = INTERACTIVE.some(function(tag) {
            return sel.indexOf(tag) !== -1 || sel.indexOf('[role="button"]') !== -1;
          });
          if (isInteractive) {
            result.interactiveAnimated.push({
              selector:  sel.slice(0, 120),
              animation: anim || '',
              transition: trans || '',
            });
          }
        }
      }
    }
  }

  // Check for autoplay video without pause control
  var videos = Array.from(document.querySelectorAll('video[autoplay]'));
  for (var v = 0; v < videos.length; v++) {
    var vid = videos[v];
    result.autoplayVideos.push({
      src:      (vid.src || vid.currentSrc || '').slice(0, 100),
      hasMuted: vid.muted || vid.hasAttribute('muted'),
      hasControls: vid.controls || vid.hasAttribute('controls'),
    });
  }

  // Check for animated images (GIF/APNG) without pause mechanism
  var imgs = Array.from(document.querySelectorAll('img'));
  for (var k = 0; k < imgs.length; k++) {
    var src = imgs[k].src || '';
    if (/\\.gif$/i.test(src) || /\\.apng$/i.test(src)) {
      result.animatedImages.push({ src: src.slice(0, 100) });
    }
  }

  return JSON.stringify(result);
}`;

// ── Post-emulation check: do animations still run under reduced motion? ───────
const REDUCED_MOTION_CHECK = `() => {
  var result = { stillAnimated: [] };
  var sheets = Array.from(document.styleSheets);
  for (var i = 0; i < sheets.length; i++) {
    var rules;
    try { rules = Array.from(sheets[i].cssRules || []); } catch { continue; }
    for (var j = 0; j < rules.length; j++) {
      var rule = rules[j];
      if (rule.type === CSSRule.STYLE_RULE && rule.style) {
        var anim  = rule.style.animationName || rule.style.animation;
        var trans = rule.style.transition;
        if ((anim && anim !== 'none') || (trans && trans !== 'none')) {
          result.stillAnimated.push({ selector: (rule.selectorText || '').slice(0, 80) });
        }
      }
    }
  }
  return JSON.stringify(result);
}`;

export async function analyzeMotion(browser, url) {
  const findings = [];

  try {
    await browser.navigate(url);
    await browser.waitFor({ state: 'networkidle' }).catch(() => {});
    await new Promise(r => setTimeout(r, 400));
  } catch {
    return findings;
  }

  // ── 1. Run CSS + DOM motion analysis ─────────────────────────────────────
  let data = null;
  try {
    const raw = await browser.evaluate(MOTION_SCRIPT);
    const s   = unwrapEval(raw);
    data = typeof s === 'object' ? s : JSON.parse(s);
  } catch (err) {
    logger.warn(`[ARGUS] motion-analyzer: analysis failed for ${url}: ${err.message}`);
    data = { hasAnimation: false, hasReducedQuery: false, interactiveAnimated: [], autoplayVideos: [], animatedImages: [] };
  }

  // Finding: animation without prefers-reduced-motion query
  if (data.hasAnimation && !data.hasReducedQuery) {
    findings.push({
      type:     'motion_no_reduced_motion_query',
      message:  'CSS animation/transition in use but no @media (prefers-reduced-motion) query found in any stylesheet',
      severity: 'warning',
      url,
    });
  }

  // Finding: autoplay video without pause control
  for (const vid of (data.autoplayVideos ?? [])) {
    if (!vid.hasControls) {
      findings.push({
        type:     'motion_autoplay_no_pause',
        message:  `<video autoplay> without visible pause controls: ${vid.src || '(no src)'}`,
        src:      vid.src,
        hasMuted: vid.hasMuted,
        severity: 'warning',
        url,
      });
    }
  }

  // Finding: animated GIFs without pause
  for (const img of (data.animatedImages ?? [])) {
    findings.push({
      type:     'motion_autoplay_no_pause',
      message:  `Animated image (GIF/APNG) without pause mechanism: ${img.src}`,
      src:      img.src,
      severity: 'info',
      url,
    });
  }

  // Finding: interactive elements with animation/transition
  const interactiveCount = (data.interactiveAnimated ?? []).length;
  if (interactiveCount >= ANIM_COUNT_THRESHOLD) {
    for (const el of data.interactiveAnimated.slice(0, 10)) {
      findings.push({
        type:       'motion_interactive_animation',
        message:    `Interactive element has animation/transition without prefers-reduced-motion override: ${el.selector}`,
        selector:   el.selector,
        animation:  el.animation,
        transition: el.transition,
        severity:   'warning',
        url,
      });
    }
  }

  // ── 2. Emulate prefers-reduced-motion: reduce and re-check ───────────────
  try {
    await browser.emulateReducedMotion('reduce');
    await new Promise(r => setTimeout(r, 300));
    const raw2 = await browser.evaluate(REDUCED_MOTION_CHECK);
    const s2   = unwrapEval(raw2);
    const d2   = typeof s2 === 'object' ? s2 : JSON.parse(s2);
    if (Array.isArray(d2.stillAnimated) && d2.stillAnimated.length > 0 && !data.hasReducedQuery) {
      findings.push({
        type:     'motion_reduced_not_honoured',
        message:  `${d2.stillAnimated.length} animated element(s) still animate after emulating prefers-reduced-motion: reduce`,
        count:    d2.stillAnimated.length,
        severity: 'warning',
        url,
      });
    }
    // Reset emulation
    await browser.emulateReducedMotion('no-preference').catch(() => {});
  } catch {
    // Emulation not supported in this Chrome/MCP build — skip gracefully
  }

  // ── 3. Summary — always emitted ──────────────────────────────────────────
  const animCount    = interactiveCount;
  const autoplayCount = (data.autoplayVideos ?? []).filter(v => !v.hasControls).length +
                        (data.animatedImages ?? []).length;

  findings.push({
    type:          'motion_summary',
    hasAnimation:  data.hasAnimation,
    hasReducedQuery: data.hasReducedQuery,
    animationCount: animCount,
    autoplayCount,
    message:       `Motion: animation=${data.hasAnimation}, reducedMotionQuery=${data.hasReducedQuery}, interactiveAnimated=${animCount}, autoplay=${autoplayCount}`,
    severity:      'info',
    url,
  });

  return findings;
}

registerExpensive({
  name:    'motion',
  analyze: (browser, url) => analyzeMotion(browser, url),
});
