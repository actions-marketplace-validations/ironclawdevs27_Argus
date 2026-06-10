/**
 * ARGUS Security Analyzer (v3 Phase A4)
 *
 * Three detection surfaces:
 *   1. DOM / browser context  — SECURITY_ANALYSIS_SCRIPT via evaluate_script
 *      • localStorage keys with token/auth names or JWT-shaped values
 *      • eval() in inline <script> tags
 *      • JS-accessible cookies (no HttpOnly flag)
 *      • Missing Content-Security-Policy and X-Frame-Options response headers
 *        (checked via a same-origin fetch HEAD request)
 *
 *   2. Console messages       — analyzeSecurityConsole
 *      • Mixed content (D6.9): "blocked" in message → critical; passive (image/audio) → warning
 *      • Sensitive data patterns (email address, JWT, Bearer token, param=value)
 *
 *   3. Network request URLs   — analyzeSecurityNetwork
 *      • Sensitive query parameters (?token=, ?key=, ?auth=, …)
 *      • HTTP resource on HTTPS page (D6.9) — skips loopback; only fires on real HTTPS origins
 */

import { execFile }    from 'child_process';
import { thresholds }  from '../config/targets.js';
import { childLogger } from './logger.js';

const logger = childLogger('security-analyzer');

/**
 * Async arrow function injected into the page via mcp.evaluate_script.
 * Uses a fetch HEAD request to check response headers on the same origin.
 * Returns a JSON string consumed by parseSecurityAnalysisResult().
 * Timeout value is interpolated from thresholds.security.headTimeoutMs at module load.
 */
export const SECURITY_ANALYSIS_SCRIPT = `async () => {
  // 1. localStorage — token-shaped key names or JWT-shaped values
  const storageTokenKeys = [];
  try {
    var kPat = /token|jwt|auth|secret|apikey|api_key|password|credential|session/i;
    var jwtPat = /^ey[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]+/;
    var keys = Object.keys(localStorage || {});
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = (localStorage.getItem(k) || '').slice(0, 500);
      if (kPat.test(k) || jwtPat.test(v)) storageTokenKeys.push(k);
    }
  } catch (e) {}

  // 2. eval() in inline <script> tags
  var evalUsage = false;
  try {
    var scripts = Array.prototype.slice.call(document.querySelectorAll('script:not([src])'));
    evalUsage = scripts.some(function(s) { return /\\beval\\s*\\(/.test(s.textContent || ''); });
  } catch (e) {}

  // 3. JS-accessible cookies (visible to JS = no HttpOnly flag)
  // Limitation: document.cookie only exposes cookies WITHOUT HttpOnly. HttpOnly cookies
  // (most sensitive session tokens) are completely invisible here. The Secure flag also
  // cannot be detected via JS — Secure-only cookies still appear in document.cookie.
  // For HttpOnly detection, the only path is response headers (Set-Cookie inspection),
  // which requires network-layer interception outside this DOM script.
  var jsCookies = [];
  try {
    jsCookies = document.cookie.split(';')
      .map(function(c) { return c.trim(); })
      .filter(function(c) { return c.length > 0; })
      .map(function(c) { return c.split('=')[0].trim(); });
  } catch (e) {}

  // 4. Response headers — CSP + X-Frame-Options via fetch HEAD (same-origin)
  // Timeout is configurable via ARGUS_SECURITY_TIMEOUT (ms); defaults to 3000.
  // Hardcoded 3s caused false negatives on staging servers behind VPNs/proxies.
  var hasCSP = null, hasXFrame = null;
  try {
    var ctrl    = new AbortController();
    var timeout = (typeof ARGUS_SECURITY_TIMEOUT !== 'undefined' ? ARGUS_SECURITY_TIMEOUT : ${thresholds.security.headTimeoutMs});
    var tid     = setTimeout(function() { ctrl.abort(); }, timeout);
    try {
      // clearTimeout must run even if fetch rejects — use inner try/finally.
      var r = await fetch(location.href, { method: 'HEAD', cache: 'no-store', signal: ctrl.signal });
      hasCSP    = r.headers.has('Content-Security-Policy');
      hasXFrame = r.headers.has('X-Frame-Options');
    } finally {
      clearTimeout(tid);
    }
  } catch (e) {}

  // 5. iframe sandbox check
  // Cross-origin iframes without the sandbox attribute can execute scripts,
  // access top-level navigation, and exfiltrate cookies — significant security risk.
  var unsandboxedIframes = [];
  try {
    var iframes = Array.prototype.slice.call(document.querySelectorAll('iframe[src]'));
    for (var fi = 0; fi < iframes.length && fi < 20; fi++) {
      var iframe = iframes[fi];
      var iframeSrc = iframe.getAttribute('src') || '';
      if (!iframe.hasAttribute('sandbox') && iframeSrc && !iframeSrc.startsWith('javascript:') && !iframeSrc.startsWith('about:') && !iframeSrc.startsWith('blob:')) {
        unsandboxedIframes.push({ src: iframeSrc.slice(0, 100) });
      }
    }
  } catch (e) {}

  // 6. Links opening in new tabs without rel="noopener noreferrer"
  // window.opener on the opened page allows it to navigate the opener — phishing vector.
  var unsafeBlankLinks = [];
  try {
    var blankLinks = Array.prototype.slice.call(document.querySelectorAll('a[target="_blank"]'));
    for (var li = 0; li < blankLinks.length && li < 30; li++) {
      var link = blankLinks[li];
      var rel = (link.getAttribute('rel') || '').toLowerCase();
      if (!rel.includes('noopener') && !rel.includes('noreferrer')) {
        unsafeBlankLinks.push({ href: (link.href || link.getAttribute('href') || '').slice(0, 100) });
      }
    }
  } catch (e) {}

  // 7. SRI check — external scripts and stylesheets without integrity attribute
  var sriViolations = [];
  try {
    var pageOrigin = location.origin;
    var extScripts = Array.prototype.slice.call(document.querySelectorAll('script[src]:not([integrity])'));
    for (var sri_i = 0; sri_i < extScripts.length && sri_i < 20; sri_i++) {
      var scriptSrc = extScripts[sri_i].src || '';
      if (scriptSrc && !scriptSrc.startsWith(pageOrigin) && !scriptSrc.startsWith('/') && !scriptSrc.startsWith('blob:') && !scriptSrc.startsWith('data:')) {
        sriViolations.push({ tag: 'script', src: scriptSrc.slice(0, 200) });
      }
    }
    var extLinks = Array.prototype.slice.call(document.querySelectorAll('link[rel="stylesheet"][href]:not([integrity])'));
    for (var sri_j = 0; sri_j < extLinks.length && sri_j < 20; sri_j++) {
      var linkHref = extLinks[sri_j].href || '';
      if (linkHref && !linkHref.startsWith(pageOrigin) && !linkHref.startsWith('/') && !linkHref.startsWith('blob:') && !linkHref.startsWith('data:')) {
        sriViolations.push({ tag: 'link', src: linkHref.slice(0, 200) });
      }
    }
  } catch (e) {}

  return JSON.stringify({ storageTokenKeys: storageTokenKeys, evalUsage: evalUsage, jsCookies: jsCookies, hasCSP: hasCSP, hasXFrame: hasXFrame, unsandboxedIframes: unsandboxedIframes, unsafeBlankLinks: unsafeBlankLinks, sriViolations: sriViolations });
}`;

/**
 * Convert the raw evaluate_script result from SECURITY_ANALYSIS_SCRIPT into
 * structured bug entries for the Argus report.
 *
 * @param {object|string|null} rawResult
 * @param {string} url - Page URL for context
 * @returns {object[]}
 */
export function parseSecurityAnalysisResult(rawResult, url) {
  if (rawResult == null) return [];

  let data;
  try {
    // Unwrap MCP { result: '...' } wrapper before parsing. Without this,
    // JSON.stringify({ result: '{"key":"val"}' }) → parse → { result: '...' } and
    // all field lookups (storageTokenKeys, evalUsage, etc.) return undefined — zero findings.
    // JSON.stringify on a circular object throws; catch logs and returns [].
    let raw = rawResult;
    if (typeof raw === 'object' && !Array.isArray(raw) && raw !== null && raw.result !== undefined) { // lgtm[js/comparison-of-unconvertible-types] — typeof null === 'object', so raw !== null is required after the typeof check
      raw = raw.result;
    }
    const str = typeof raw === 'string' ? raw : JSON.stringify(raw);
    data = JSON.parse(str);
  } catch (e) {
    logger.warn('[ARGUS] parseSecurityAnalysisResult: parse failed —', e.message);
    return [];
  }

  if (!data || typeof data !== 'object') return [];

  const bugs = [];

  if (Array.isArray(data.storageTokenKeys) && data.storageTokenKeys.length > 0) {
    bugs.push({
      type:     'security_token_in_storage',
      keys:     data.storageTokenKeys,
      message:  `Auth token stored in localStorage (keys: ${data.storageTokenKeys.join(', ')}) — XSS-accessible`,
      severity: 'critical',
      url,
    });
  }

  if (data.evalUsage) {
    bugs.push({
      type:     'security_eval_usage',
      message:  'eval() usage detected in inline script — security and performance risk',
      severity: 'warning',
      url,
    });
  }

  if (Array.isArray(data.jsCookies) && data.jsCookies.length > 0) {
    bugs.push({
      type:     'security_cookie_no_httponly',
      cookies:  data.jsCookies,
      message:  `${data.jsCookies.length} cookie(s) readable by JavaScript (no HttpOnly flag): ${data.jsCookies.join(', ')}`,
      severity: 'warning',
      url,
    });
  }

  if (data.hasCSP === false) {
    bugs.push({
      type:     'security_missing_csp',
      message:  'Missing Content-Security-Policy response header — XSS risk',
      severity: 'warning',
      url,
    });
  }

  if (data.hasXFrame === false) {
    bugs.push({
      type:     'security_missing_xframe',
      message:  'Missing X-Frame-Options response header — clickjacking risk',
      severity: 'warning',
      url,
    });
  }

  // unsandboxed cross-origin iframes
  if (Array.isArray(data.unsandboxedIframes) && data.unsandboxedIframes.length > 0) {
    for (const frame of data.unsandboxedIframes) {
      bugs.push({
        type:    'security_iframe_no_sandbox',
        src:     frame.src,
        message: `<iframe> with src="${String(frame.src).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').slice(0, 200)}" has no sandbox attribute — add sandbox="allow-scripts allow-same-origin" to restrict capabilities`,
        severity: 'warning',
        url,
      });
    }
  }

  // target="_blank" links without rel="noopener noreferrer"
  // The opened page can access window.opener and redirect the parent tab — phishing vector.
  if (Array.isArray(data.unsafeBlankLinks) && data.unsafeBlankLinks.length > 0) {
    bugs.push({
      type:    'security_unsafe_blank_link',
      count:   data.unsafeBlankLinks.length,
      hrefs:   data.unsafeBlankLinks.map(l => l.href),
      message: `${data.unsafeBlankLinks.length} link(s) with target="_blank" missing rel="noopener noreferrer" — add rel="noopener noreferrer" to prevent opener hijacking`,
      severity: 'warning',
      url,
    });
  }

  // SRI violations — external scripts/stylesheets without integrity attribute
  if (Array.isArray(data.sriViolations) && data.sriViolations.length > 0) {
    for (const v of data.sriViolations) {
      bugs.push({
        type:    'security_missing_sri',
        tag:     v.tag,
        src:     v.src,
        message: `External <${v.tag}> without integrity attribute: "${String(v.src).slice(0, 200)}" — add integrity="sha384-..." to prevent supply-chain attacks`,
        severity: 'warning',
        url,
      });
    }
  }

  return bugs;
}

/**
 * Scan console messages for mixed content warnings and sensitive data patterns.
 * Targeted pattern avoids false positives on common error strings.
 *
 * @param {object[]} consoleMsgs - Raw console message objects ({ level, text })
 * @param {string}   url
 * @returns {object[]}
 */
export function analyzeSecurityConsole(consoleMsgs, url) {
  const bugs = [];
  // Targeted: require delimiter after keyword (password=, secret:) OR structural patterns
  const sensitivePattern = /password[:=]|secret[:=]|api[_-]?key[:=]|credential[:=]|eyJ[A-Za-z0-9_-]{10,}|Bearer\s+\S{6,}|\b[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9.\-]{1,253}\.[A-Za-z]{2,63}\b/i;
  const mixedContentPattern = /mixed content/i;

  for (const msg of (Array.isArray(consoleMsgs) ? consoleMsgs : [])) {
    const text = String(msg.text ?? msg.message ?? msg ?? '');
    if (!text) continue;
    if (mixedContentPattern.test(text)) {
      // D6.9: "blocked" in the message → active content, browser refuses to load → critical.
      // No "blocked" → passive content (image/audio/video), browser loads with a warning → warning.
      const isBlocked = /\bblocked\b/i.test(text);
      bugs.push({
        type:     'security_mixed_content',
        message:  `Mixed content ${isBlocked ? 'blocked' : 'warning'}: ${text.slice(0, 200)}`,
        severity: isBlocked ? 'critical' : 'warning',
        url,
      });
    } else if (sensitivePattern.test(text)) {
      bugs.push({
        type:     'security_sensitive_console',
        message:  `Sensitive data in console output: ${text.slice(0, 200)}`,
        severity: 'warning',
        url,
      });
    }
  }
  return bugs;
}

/**
 * Scan network request URLs for sensitive query parameters.
 *
 * @param {object[]} networkReqs - Network request entries ({ url })
 * @param {string}   url - Page URL for context
 * @returns {object[]}
 */
export function analyzeSecurityNetwork(networkReqs, url) {
  const bugs = [];
  const sensitiveParams = /[?&](token|key|auth|password|secret|apikey|api_key|credential|jwt)=/i;
  // D6.9: flag HTTP resources on HTTPS pages; skip loopback addresses (not mixed content).
  const pageIsHttps = (url ?? '').startsWith('https://');
  const isLoopback  = /^http:\/\/(localhost|127\.|0\.0\.0\.0)/i;

  for (const req of (Array.isArray(networkReqs) ? networkReqs : [])) {
    const reqUrl = req.url ?? req.requestUrl ?? '';
    if (!reqUrl) continue;

    if (pageIsHttps && reqUrl.startsWith('http://') && !isLoopback.test(reqUrl)) {
      bugs.push({
        type:       'security_mixed_content',
        requestUrl: reqUrl,
        message:    `Mixed content: HTTP resource "${reqUrl.slice(0, 200)}" on HTTPS page — request may be blocked`,
        severity:   'critical',
        url,
      });
    }

    if (!sensitiveParams.test(reqUrl)) continue;
    bugs.push({
      type:       'security_token_in_url',
      requestUrl: reqUrl,
      message:    `Sensitive parameter in request URL: ${reqUrl.slice(0, 300)}`,
      severity:   'critical',
      url,
    });
  }
  return bugs;
}

/**
 * Detect source map files being served in production.
 * Source maps expose original unminified source code to anyone with DevTools open.
 *
 * @param {object[]} networkReqs - Network request entries ({ url })
 * @param {string}   url - Page URL for context
 * @returns {object[]}
 */
export function checkSourceMapExposure(networkReqs, url) {
  const bugs = [];
  for (const req of (Array.isArray(networkReqs) ? networkReqs : [])) {
    const reqUrl = req.url ?? req.requestUrl ?? '';
    if (!reqUrl) continue;
    if (/\.(js|css)\.map(\?|$)/i.test(reqUrl) || /\/[^/]+\.map(\?|$)/.test(reqUrl)) {
      bugs.push({
        type:       'security_sourcemap_exposed',
        requestUrl: reqUrl,
        message:    `Source map publicly accessible: "${reqUrl.slice(0, 200)}" — remove or restrict .map files in production to protect original source code`,
        severity:   'warning',
        url,
      });
    }
  }
  return bugs;
}

/**
 * Detect open redirect parameters in network request URLs.
 * Open redirects allow attackers to craft phishing URLs that appear to come from
 * the legitimate domain.
 *
 * @param {object[]} networkReqs - Network request entries ({ url })
 * @param {string}   url - Page URL for context
 * @returns {object[]}
 */
export function checkOpenRedirects(networkReqs, url) {
  // 'to', 'target', 'url' excluded — too common in non-redirect contexts (CDN proxies, nav params).
  const redirectParams = /[?&](redirect|return|next|dest|destination|goto|redir|forward)=/i;
  const bugs = [];
  for (const req of (Array.isArray(networkReqs) ? networkReqs : [])) {
    const reqUrl = req.url ?? req.requestUrl ?? '';
    if (!reqUrl || !redirectParams.test(reqUrl)) continue;
    bugs.push({
      type:       'security_open_redirect',
      requestUrl: reqUrl,
      message:    `Potential open redirect parameter in URL: "${reqUrl.slice(0, 200)}" — validate redirect targets server-side against an allowlist`,
      severity:   'warning',
      url,
    });
  }
  return bugs;
}

/**
 * Run `npm audit --json` in the given project directory and convert CVEs to findings.
 * Skips silently if projectDir is falsy, npm is not available, or the project has
 * no package.json (not a Node project).
 *
 * @param {string|null} projectDir - Absolute path to the project root
 * @returns {Promise<object[]>}
 */
export async function auditNpmDependencies(projectDir) {
  if (!projectDir) return [];

  return new Promise(resolve => {
    // shell: true resolves npm.cmd on Windows; harmless on macOS/Linux.
    execFile('npm', ['audit', '--json'], { cwd: projectDir, maxBuffer: 4 * 1024 * 1024, shell: true }, (err, stdout) => {
      // npm audit exits non-zero when vulnerabilities exist — we still want stdout.
      if (!stdout) return resolve([]);
      let report;
      try { report = JSON.parse(stdout); } catch { return resolve([]); }

      const bugs = [];
      const vulns = report?.vulnerabilities ?? report?.advisories ?? {};

      for (const [name, info] of Object.entries(vulns)) {
        const sev = String(info.severity ?? 'moderate').toLowerCase();
        const via = Array.isArray(info.via)
          ? info.via.filter(v => typeof v === 'string').join(', ')
          : '';
        bugs.push({
          type:     'security_npm_vulnerability',
          package:  name,
          severity: sev === 'critical' || sev === 'high' ? 'critical' : 'warning',
          message:  `npm vulnerability in "${name}"${via ? ` via ${via}` : ''} (${sev}) — run \`npm audit fix\` to resolve`,
          via,
        });
      }

      // Deduplicate by package name (advisories-style reports can have duplicates).
      const seen = new Set();
      resolve(bugs.filter(b => { if (seen.has(b.package)) return false; seen.add(b.package); return true; }));
    });
  });
}
