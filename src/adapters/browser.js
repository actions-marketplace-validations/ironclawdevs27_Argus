/**
 * CdpBrowserAdapter — facade over chrome-devtools-mcp.
 *
 * All analyzer modules call browser.* methods instead of mcp.* directly.
 * This single file is the only place that knows the chrome-devtools-mcp
 * API shape, so any future API change (parameter renames, new tool versions)
 * requires editing exactly one file.
 *
 * listConsole() and listNetwork() parse the markdown-text format that
 * chrome-devtools-mcp@latest returns, so callers always receive structured
 * arrays rather than raw text.
 *
 * listConsoleRaw(args) passes arbitrary args through unparsed — used by
 * issues-analyzer.js which calls list_console_messages({ types: ['issue'] }).
 */

import { parseConsoleMsgResponse, parseNetworkReqResponse } from '../utils/mcp-parsers.js';
import { withRetry } from '../utils/retry.js';

export class CdpBrowserAdapter {
  constructor(mcp) { this._mcp = mcp; }

  // ── Navigation ──────────────────────────────────────────────────────────────
  // navigate_page reports failures as RESOLVED text ("Unable to navigate ...
  // net::ERR_CONNECTION_REFUSED", "Could not connect to Chrome ..."), never as a
  // thrown error. Unchecked, a dead target or dead browser produced a "clean"
  // audit: analyzers ran against chrome-error://chromewebdata and emitted bogus
  // findings (or none), and CI gates passed with Chrome down. Throw so failures
  // propagate through the existing crawl error path.
  navigate(url) {
    return withRetry(async () => {
      const resp = await this._mcp.navigate_page({ url });
      if (typeof resp === 'string' &&
          (resp.includes('Unable to navigate') ||
           resp.includes('Could not connect to Chrome') ||
           resp.includes('A dialog is open'))) {
        throw new Error(`navigate(${url}) failed: ${resp.split('\n')[0].slice(0, 200)}`);
      }
      return resp;
    }, { label: `navigate(${url})` });
  }

  // ── Evaluation & snapshots ──────────────────────────────────────────────────
  evaluate(fn)             { return this._mcp.evaluate_script({ function: fn }); }
  snapshot(opts = {})      { return this._mcp.take_snapshot(opts); }
  screenshot(opts = {})    { return this._mcp.take_screenshot(opts); }
  heapSnapshot(opts = {})  { return this._mcp.take_heapsnapshot(opts); }

  // ── Interactions ────────────────────────────────────────────────────────────
  // click is intentionally NOT retried — it is not idempotent (submits forms,
  // toggles state, triggers deletions). A retry after an ambiguous MCP timeout
  // cannot distinguish "Chrome never received the click" from "Chrome processed
  // it but the pipe dropped the response" — firing twice causes duplicate actions.
  click(uid)               { return this._mcp.click({ uid }); }
  fill(uid, value)         { return withRetry(() => this._mcp.fill({ uid, value }), { label: `fill(${uid})` }); }
  type(text)               { return this._mcp.type_text({ text }); }
  pressKey(key)            { return this._mcp.press_key({ key }); }
  hover(uid)               { return this._mcp.hover({ uid }); }
  drag(src, tgt)           { return this._mcp.drag({ from_uid: src, to_uid: tgt }); }
  uploadFile(uid, filePath) { return this._mcp.upload_file({ uid, filePath }); }
  // handle_dialog wire schema is { action: 'accept'|'dismiss', promptText? } — sending
  // { accept: bool } is rejected by the tool's input validation (and the rejection comes
  // back as a resolved error-text response, so the failure was silent in production).
  handleDialog(accept, promptText = '') {
    const args = { action: accept ? 'accept' : 'dismiss' };
    if (promptText) args.promptText = promptText;
    return this._mcp.handle_dialog(args);
  }
  // wait_for requires text as a non-empty string ARRAY. A bare string is rejected by
  // input validation, and { state: 'networkidle' } is not part of the tool's schema at
  // all — both shapes used to resolve to error text and silently wait for nothing.
  waitFor(opts = {})       {
    if (typeof opts.text === 'string') opts = { ...opts, text: [opts.text] };
    if (opts.state === 'networkidle') return this.#waitForNetworkIdle();
    return this._mcp.wait_for(opts);
  }

  // Bounded network-quiet poll: resolves once the page's resource-timing entry count
  // is stable across two consecutive 250 ms polls, or after 3 s — whichever is first.
  async #waitForNetworkIdle() {
    let prev = -1;
    for (let i = 0; i < 12; i++) {
      const raw = await this.evaluate(`() => performance.getEntriesByType('resource').length`);
      const count = Number(typeof raw === 'object' ? raw?.result ?? 0 : raw) || 0;
      if (count === prev) return;
      prev = count;
      await new Promise(r => setTimeout(r, 250));
    }
  }

  // ── Viewport ────────────────────────────────────────────────────────────────
  emulate(viewport)              { return this._mcp.emulate({ viewport }); }
  emulateCpu(rate)               { return this._mcp.emulate({ cpuThrottlingRate: rate }); }
  emulateColorScheme(scheme)     { return this._mcp.emulate({ colorScheme: scheme }); }
  // chrome-devtools-mcp@1.1.1's emulate tool has no reduced-motion capability — the
  // unsupported argument comes back as RESOLVED error text ("Unknown argument"), not a
  // thrown error, so callers' graceful-skip catch paths (motion-analyzer) never ran and
  // analysis proceeded unemulated. Surface it as a real error; if a future upstream
  // version adds the argument, the call succeeds and emulation lights up automatically.
  async emulateReducedMotion(pref) {
    const resp = await this._mcp.emulate({ reducedMotion: pref });
    if (typeof resp === 'string' && resp.includes('Unknown argument')) {
      throw new Error(`emulate does not support reducedMotion in this chrome-devtools-mcp version: ${resp.slice(0, 120)}`);
    }
    return resp;
  }
  resize(w, h)                   { return this._mcp.resize_page({ width: w, height: h }); }

  // ── Network & performance ───────────────────────────────────────────────────
  // chrome-devtools-mcp expects the wire parameter "reqid" (sending "requestId"
  // is rejected with an Unknown-argument error). Callers still pass the numeric
  // requestId parsed from list_network_requests.
  getNetworkRequest(reqId) { return this._mcp.get_network_request({ reqid: reqId }); }
  // lighthouse_audit audits the CURRENTLY-NAVIGATED page and accepts only
  // mode/device/outputDirPath. Passing `url` (or `categories`) is REJECTED with an
  // "Unknown argument" error that comes back as RESOLVED text — so every Argus Lighthouse
  // run silently no-op'd (caught upstream as "Lighthouse skipped", scores perpetually N/A).
  // Navigate to the target first, then audit; strip url/categories defensively so legacy
  // callers cannot reintroduce the rejected args. mode 'navigation' (the tool default)
  // reloads + audits. Performance is intentionally excluded by lighthouse_audit (covered by
  // the web-vitals analyzer) — it returns accessibility/best-practices/seo/agentic-browsing.
  async lighthouse(url, opts = {}) {
    if (url) await this.navigate(url);
    const { url: _ignoredUrl, categories: _ignoredCats, ...valid } = opts;
    return this._mcp.lighthouse_audit(valid);
  }
  startTrace()             { return this._mcp.performance_start_trace({}); }
  stopTrace()              { return this._mcp.performance_stop_trace({}); }
  analyzeInsight(opts)     { return this._mcp.performance_analyze_insight(opts); }

  // ── Tab management ─────────────────────────────────────────────────────────
  // list_pages returns markdown text ("## Pages\n1: <url> [selected]") like all
  // MCP responses — callers parse with parseListPagesResponse (mcp-parsers.js).
  listPages()              { return this._mcp.list_pages({}); }
  // select_page validates pageId as a number — coerce so callers may pass the
  // string tabId they received from an MCP tool argument.
  selectPage(tabId)        { return this._mcp.select_page({ pageId: Number(tabId) }); }

  // ── Lifecycle ───────────────────────────────────────────────────────────────
  close()                  { return this._mcp.close(); }

  // ── Console & network lists (text-parsed) ───────────────────────────────────

  /** Returns structured array from list_console_messages (parses markdown text). */
  async listConsole() {
    const raw = await this._mcp.list_console_messages({});
    return parseConsoleMsgResponse(raw);
  }

  /** Returns structured array from list_network_requests (parses markdown text). */
  async listNetwork() {
    const raw = await this._mcp.list_network_requests({});
    return parseNetworkReqResponse(raw);
  }

  /**
   * Raw pass-through to list_console_messages with custom args.
   * Used by issues-analyzer.js for the DevTools Issues panel
   * (types: ['issue']). Like all MCP responses, the result is markdown
   * text ("msgid=N [issue] text") — parse with parseConsoleMsgResponse.
   */
  listConsoleRaw(args = {}) { return this._mcp.list_console_messages(args); }
}
