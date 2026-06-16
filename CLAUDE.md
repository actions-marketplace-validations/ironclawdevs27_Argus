# Argus — Project Context for Claude Code

## What This Project Is

Argus is an AI-driven automated QA harness that audits web pages using Chrome DevTools Protocol (CDP) via the `chrome-devtools` MCP server. It catches bugs, compares dev vs staging environments, and reports to Slack with screenshots.

## Skill Reference

**CRITICAL**: Read `SKILL.md` before starting any Argus task. It is the canonical reference for:

- All MCP tool signatures and parameters
- Flow Runner DSL step actions
- Assertion patterns for `test-harness/validate.js`
- Common failure modes and fixes
- Harness statistics (149 blocks, 846 hard assertions, 67 detection categories)

## Project Structure

```text
src/
  argus.js                    — single-page audit entry point
  batch-runner.js             — multi-page batch audit
  mcp-server.js               — Argus MCP server; exposes argus_audit / argus_audit_full / argus_compare / argus_last_report / argus_watch_snapshot / argus_get_context / argus_design_audit / argus_visual_diff / argus_pr_validate
  adapters/
    browser.js                — CdpBrowserAdapter — wraps all mcp.* calls
    figma.js                  — Figma REST adapter — getFigmaFrame() + parseFigmaUrl()
  domain/
    finding.js                — createFinding() factory
  registry.js                 — analyzer plugin registry (registerCheap/registerExpensive/getCheap/getExpensive/clearAll)
  orchestration/
    crawl-and-report.js       — backward-compat re-export shell
    orchestrator.js           — crawl loop + runCrawl
    report-processor.js       — dedup → baseline → JSON write
    dispatcher.js             — Slack / GitHub / HTML dispatch
    slack-notifier.js         — Slack Block Kit message builder
    env-comparison.js         — dev vs staging diff
    watch-mode.js             — passive browser monitoring (npm run watch)
  server/
    index.js                  — Express server (port 3001) for Slack slash commands + interactions
    slash-command-handler.js  — /argus-retest slash command handler
    interaction-handler.js    — Acknowledge + Retest button handler
  cli/
    init.js                   — C4: argus init interactive setup wizard
    chrome-launcher.js        — findChrome()/launchChrome() cross-platform binary detection; npm run chrome / argus-chrome bin
    doctor.js                 — checkChrome/checkMcpConfig/checkEnvKeys pre-flight checks; npm run doctor / argus-doctor bin
    pr-validate.js            — headless CI entry point for GitHub Actions; exports buildStepSummary / writeGithubOutputs / writeStepSummary / checkTargetReachable / normalizeRoutePaths
  utils/
    logger.js                 — Pino structured logger; childLogger(module)
    retry.js                  — withRetry() exponential-backoff wrapper
    telemetry.js              — OTel tracing + metrics; startSpan() / recordFinding() / recordFlaky() / recordNewFindings(); no-op default
    flow-runner.js            — DSL step executor (D8 flow steps)
    mcp-parsers.js            — text-format parsers for list_console_messages / list_network_requests
    mcp-client.js             — headless JSON-RPC MCP client
    seo-analyzer.js           — A3: SEO checks
    security-analyzer.js      — A4: security checks
    content-analyzer.js       — A5: content quality
    responsive-analyzer.js    — A6: viewport emulation + overflow
    memory-analyzer.js        — B1: heap snapshot + detached DOM
    session-manager.js        — B2: backward-compat re-export barrel
    session-persistence.js    — B2: saveSession / restoreSession / hasSession / clearSession
    login-orchestrator.js     — B2: runLoginFlow / refreshSession + lock file
    baseline-manager.js       — B3: historical baselines + trend tracking
    flakiness-detector.js     — B4: double-crawl, confirm vs flaky
    noise-filter.js           — MIT post-processors: cross-run flip-flop noise classifier; downgrades noisy findings to info; <branch>-history.json
    root-cause-linker.js      — MIT post-processors: recent git commits → suspect files per new finding (slug heuristic, no API)
    hover-analyzer.js         — D8.1: hover-state bug detection
    snapshot-analyzer.js      — D8.2: accessibility tree analysis
    keyboard-analyzer.js      — keyboard Tab-walk focus analysis
    issues-analyzer.js        — Chrome DevTools Issues panel (CSP/CORS/deprecated)
    network-timing-analyzer.js — HAR timing analysis for slow third-party detection
    lighthouse-checker.js     — Lighthouse soft assertions
    codebase-analyzer.js      — C1: static source analysis
    github-reporter.js        — C2: PR comment + commit status + Check Runs
    route-discoverer.js       — C3: sitemap + Next.js + React Router discovery
    contract-validator.js     — D7.4: API response schema validation
    parallel-crawler.js       — D7.3: parallel route crawling
    html-reporter.js          — D7.1: HTML dashboard bundler
    severity-overrides.js     — D7.5: post-process severity policy
    slack-guard.js            — D7.7: Slack-optional guard
    api-frequency.js          — request frequency tracking
    css-analyzer.js           — CSS rule analysis
    theme-analyzer.js         — A7: Theme & Dark Mode detection
    design-fidelity-analyzer.js — D9: Figma design token vs DOM comparison
    web-vitals-analyzer.js    — Web Vitals: LCP/CLS/FCP/TTI/TTFB via Performance API + bundle size regression
    visual-diff-analyzer.js   — A8: Visual regression — pixelmatch screenshot baseline comparison
    a11y-deep-analyzer.js     — A12: Deep Accessibility — axe-core 4.12 injection (80+ WCAG rules) + protanopia/deuteranopia CVD color blind simulation
    har-recorder.js           — N1: HAR Network Baseline — record + diff network requests per route
    motion-analyzer.js        — A9: Motion & Animation — prefers-reduced-motion + autoplay detection
    font-analyzer.js          — A10: Font Loading — FOIT/FOUT/fallback/slow/suboptimal-format detection
    form-analyzer.js          — A11: Form Validation — required/autocomplete/aria/validation gaps
    pr-diff-analyzer.js       — parsePrUrl() / fetchPrFiles() / mapFilesToRoutes() — PR diff → affected routes
    diff.js                   — finding diff utilities
    slug.js                   — URL slug helpers
    pdf-exporter.js           — exportReportToPdf / exportPageToPdf via puppeteer (optional peer dep); npm run report:pdf
    screen-recorder.js        — PollingRecorder (zero-dep screenshot intervals) + CdpScreenRecorder (ws dep, Page.startScreencast, auto-ffmpeg)
  config/
    targets.js                — URL targets + auth steps + centralized thresholds
    schema.js                 — Zod validation schema for targets.js; validateConfig() called inside runCrawl()
action.yml                    — composite GitHub Action (Argus PR Validator); inputs: target-url, github-token, block-on, pr-url, routes-file, chrome-flags, node-version
.mcp.json                     — MCP server registration — npx argusqa-os entry; argus server for Claude / MCP clients
landing/
  src/
    App.jsx                   — single-page React app (hero, features, comparison, waitlist modal, enterprise modal)
    supabase.js               — Supabase client factory; exports null if VITE_SUPABASE_* env vars missing
  public/
    favicon.svg               — SVG favicon replicating Logo() component (#5E0ED7 ring + dot)
    argus-poster.png          — video poster fallback (1918×1078; source for OG card)
    og-image-v2.jpg           — branded OG social card (1200×630, cover-mode scaled, black-outlined stat numbers)
    robots.txt                — allows all crawlers; Sitemap reference
    sitemap.xml               — canonical URL for argus-qa.com/
  index.html                  — Vite entry; OG/Twitter/JSON-LD SEO tags; canonical; favicon link
  package.json                — React 19, Vite 8, Tailwind, Framer Motion 12, @supabase/supabase-js
  .env.example                — committed template: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
  .env.local                  — gitignored — real Supabase credentials (copy from .env.example)
test-harness/
  validate.js                 — 149-block correctness harness (blocks [80]–[84] MCP/createFinding/withRetry/watch/init; [85]–[93] Tier 3; [94]–[126] gap-close; [127] A7 theme; [128] D9 design fidelity; [129] Web Vitals; [130] A8 Visual Regression; [131] A12 Axe-core; [132] N1 HAR; [133] A9 Motion; [134] A10 Font; [135] A11 Form; [136] GitHub Check Runs; [137] PR Diff Analyzer + EXCLUDED_PATTERNS [137i–k]; [138] GitHub Action CLI + preflight/normalize/guard [138k–p]; [139] Chrome launcher + doctor + security extensions [139a–k]; [140] noise filter [140a–g]; [141] root cause linker [141a–h]; [142] MCP wire-contract regressions [142a–i]; [143] CdpBrowserAdapter wire-contract conformance [143a–zz]; [144] MCP tool error-path matrix [144a–p]; [145] multi-tab end-to-end [145a–f]; [146] anti-vacuous self-lint [146a–e]; [147] golden MCP response schemas [147a–n] via contracts/mcp-tool-schemas.js; [148] upstream canary [148a–e] via contracts/chrome-devtools-mcp@1.1.1.json; [149] per-category negative controls [149a–e] — 65-category over-fire sweep driving the real pipeline against negative-controls.html; [150] verification-gap closure [150a–m] — positive firing fixtures for the previously-untriggered focus_lost / security_no_https / cors_violation / cookie_attribute_missing detectors)
  harness-config.js           — fixture page routing table
  contracts/
    mcp-tool-schemas.js       — golden Zod response schemas for the 9 MCP tools (block [147]; exported for E2E)
  .env.harness                — ARGUS_LOG_LEVEL=warn — suppresses Pino INFO flood during harness runs (auto-loaded by test:harness)
  run-with-log.mjs            — tee wrapper: streams output live to terminal AND saves full output to harness-results.txt
  pages/                      — 63 fixture HTML pages
  server.js                   — fixture HTTP server
  nextjs-fixture/             — Next.js pages/+app/ structure for C3 route discovery tests
  source-fixture/             — JS source + .env fixture for C1 codebase analysis tests
test/
  unit/                       — 9 Vitest unit test files (94 tests); run with npm run test:unit
scripts/
  dispatch-report.js          — standalone Slack re-dispatch for an existing JSON report
  coverage-gate.mjs           — merges unit (vitest-v8) + harness (c8) coverage; gates --min-lines + --allow-uncovered
.c8rc.json                    — c8 config for the harness coverage half (all src/**, json report → coverage/harness/)
vitest.config.js              — Vitest config; coverage block (v8) drives the unit half → coverage/unit/
reports/
  baselines/                  — baseline.json + trends.json (gitignored)
```

## Running the Test Harness

Chrome must be running with remote debugging before starting the harness:

```bash
# Windows (PowerShell) — start Chrome first:
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --headless=new --no-sandbox --disable-gpu --user-data-dir="$env:TEMP\chrome-argus"

# Then run the harness:
npm run test:unit          # 94 Vitest unit tests — no Chrome required
npm run test:harness       # Expected: 846/846 (no permanent failures); INFO logs suppressed via .env.harness
npm run test:harness:log   # Same as above, but tees full output to harness-results.txt at repo root
npm run test:coverage      # merged unit+harness coverage gate (requires Chrome): coverage:harness → coverage:unit → coverage:gate
```

Soft assertions (Lighthouse, perf traces) require non-headless Chrome — they are expected to be skipped in headless CI.

## Key Rules

- **Never use `window.innerWidth`** for overflow checks after `emulate` — use `document.documentElement.clientWidth`.
- **`evaluate_script` parameter is `function`**, not `script`. Value must be `'() => expr'`.
- MCP tool responses are markdown-wrapped — extract via regex in `mcp-client.js tool()`.
- **Fixture pages must be served via HTTP** (`npm run harness`), never via `file://`.
- Security headers middleware: apply permissive CSP/XFrame to ALL fixture pages EXCEPT `security-issues.html`.
- `clean.html` must have `og:image` — all three OG tags are `severity: warning`.
- **All analyzers use `browser.*` (not `mcp.*` directly)** — every analyzer takes a `CdpBrowserAdapter` as its first argument. Import from `src/adapters/browser.js`. Public orchestration functions keep `mcp` in their signature and construct `new CdpBrowserAdapter(mcp)` internally.
- **`list_network_requests` text format includes `requestId`** — `parseNetworkReqResponse` emits `{ requestId, method, url, status }`. Use `req.requestId` for `browser.getNetworkRequest()` lookups. Watch-mode dedup uses content-based keys (`method::url::status`), never `requestId` (resets after navigation).

## Adding a New Detection Phase

Follow the pattern in SKILL.md §9. Quick checklist:

1. `src/utils/<name>-analyzer.js` — returns `findings[]` array; call `registerExpensive({ name, analyze })` at the bottom
2. Import the analyzer as a side-effect in `src/orchestration/orchestrator.js` (controls registration order)
3. Add fixture page to `test-harness/pages/`
4. Register in `test-harness/harness-config.js`
5. Add test block to `test-harness/validate.js` (next sequential number, ≥3 hard assertions)
6. Update §14 (Harness Statistics) in `SKILL.md`

## Environment Variables (.env)

```bash
# Slack (all optional — omit to use HTML report mode)
SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=
SLACK_CHANNEL_CRITICAL=            # channel ID for critical bug reports
SLACK_CHANNEL_WARNINGS=            # channel ID for warnings
SLACK_CHANNEL_DIGEST=              # channel ID for daily digest
PORT=3001                          # Slack slash-command server port

# Target URLs
TARGET_DEV_URL=http://localhost:3000
TARGET_STAGING_URL=

# OTel (optional)
OTEL_EXPORTER_OTLP_ENDPOINT=       # ship spans/metrics to Jaeger/Grafana Tempo
ARGUS_OTEL_CONSOLE=                # set to 1 for dev-mode span printing to stdout

# Logging + retry (optional)
ARGUS_LOG_LEVEL=                   # info (default), debug, warn, error
ARGUS_LOG_PRETTY=                  # 1 = force pino-pretty, 0 = force JSON, unset = auto TTY
ARGUS_RETRY_ATTEMPTS=              # max retries on navigate/fill (default: 3; set 1 to disable in CI)

# Intelligent baseline filtering + root cause linking (optional)
ARGUS_NOISE_FILTER=                # 0 = disable cross-run noise classifier (default: on)
ARGUS_ROOT_CAUSE=                  # 0 = disable git-diff root cause linking (default: on)

# Runtime (optional)
ARGUS_CONCURRENCY=                 # parallel MCP clients (default: 1)
ARGUS_WATCH_INTERVAL_MS=           # watch mode poll interval ms (default: 1000)
ARGUS_WATCH_UI_PORT=               # watch mode web dashboard port (default: 3002)
SCREENSHOT_DIFF_THRESHOLD=0.5      # pixel diff % threshold for env comparison
REPORT_OUTPUT_DIR=./reports

# A12: Deep Accessibility (optional)
A11Y_CONTRAST_AA=                  # WCAG AA min contrast ratio for CVD simulation (default: 4.5)
A11Y_MAX_AXE=                      # max axe-core violations per page (default: 50)

# GitHub PR rich comments + Check Runs (optional)
ARGUS_CRITICAL_THRESHOLD=          # new criticals before blocking merge (default: 1; 0 = never block)
ARGUS_DIFF_IMAGE_URL=              # visual diff image URL to embed in PR comment
GITHUB_CHECK_NAME=                 # GitHub Check Run name (default: argus-qa)

# A9: Motion & Animation (optional)
MOTION_ANIM_COUNT=                 # interactive animation count threshold (default: 1)

# A10: Font Loading (optional)
FONT_SLOW_MS=                      # slow web font load threshold ms (default: 1000)

# D9: Figma design fidelity (optional)
FIGMA_API_TOKEN=                   # figma.com PAT — enables argus_design_audit + design-fidelity analyzer

# A8: Visual regression thresholds (optional)
VISUAL_WARN_PERCENT=               # % pixels changed → warning (default: 0.1)
VISUAL_CRIT_PERCENT=               # % pixels changed → critical (default: 5.0)

# MCP client + Chrome tooling (optional)
MCP_BROWSER_URL=                   # Chrome remote-debug URL (default: http://127.0.0.1:9222)
MCP_TOOL_TIMEOUT_MS=               # headless client per-tool timeout ms (default: 30000)
ARGUS_CHROME_PATH=                 # explicit Chrome binary for npm run chrome / doctor
ARGUS_CHROME_PORT=                 # CDP port for doctor/chrome (default: 9222)

# Auth flow credentials (referenced from targets.js auth steps)
ARGUS_AUTH_EMAIL=
ARGUS_AUTH_PASSWORD=

# Timeouts (optional)
ARGUS_CRAWL_TIMEOUT_MS=            # Slack slash-command crawl timeout ms (default: 120000)
ARGUS_LIGHTHOUSE_TIMEOUT=          # Lighthouse audit timeout ms (default: 120000)

# C1: Codebase analysis (optional)
ARGUS_SOURCE_DIR=                  # path to app source directory
ARGUS_ENV_FILE=                    # path to app .env file for env var audit

# C2: GitHub PR integration (optional)
GITHUB_TOKEN=
GITHUB_REPOSITORY=                 # owner/repo
GITHUB_PR_NUMBER=                  # set in CI: ${{ github.event.pull_request.number }}
ARGUS_REPORT_URL=                  # URL linked from commit status check
```

### Landing Page (`landing/.env.local`)

```bash
VITE_SUPABASE_URL=https://<project-ref>.supabase.co    # bare project URL — no /rest/v1 suffix
VITE_SUPABASE_ANON_KEY=eyJ...                          # anon public key from Supabase dashboard
```

Tables required in Supabase (RLS on, plus `GRANT INSERT ON <table> TO anon`):
- `waitlist (id, email, plan, created_at, source)`
- `enterprise_contacts (id, name, email, company, team_size, region, use_case, workflow, message, created_at)`

`TARGET_DEV_URL` and `TARGET_STAGING_URL` are also read by `argus_compare` when running via `npm run mcp-server` — they are the only configuration inputs for comparison targets (cannot be overridden per-call).

## Phases Complete

D1–D8.5 (all code phases complete). Watch mode (passive browser monitoring — `npm run watch`; polls every 1 s by default; live web dashboard at `http://localhost:3002`, configurable via `ARGUS_WATCH_UI_PORT`). Adapter layer: `CdpBrowserAdapter` (`src/adapters/browser.js`), `createFinding()` factory (`src/domain/finding.js`), `mcp-parsers.js`, all analyzer/orchestration/harness files use `browser.*`. Plugin registry (`src/registry.js`), god object split (`orchestrator.js` + `report-processor.js` + `dispatcher.js`), `crawl-and-report.js` reduced to 16-line re-export shell, 6 analyzers self-register. Threshold centralization in `src/config/targets.js`; `src/config/schema.js` (Zod) validates config at startup. Session split into `session-persistence.js` + `login-orchestrator.js`; Pino structured logging via `logger.js`; `withRetry()` exponential backoff on `navigate` and `fill` — `click` intentionally excluded (not idempotent). Vitest unit test suite: 6 files, 61 tests, zero Chrome dependency (`npm run test:unit`); harness blocks [81] (createFinding) + [82] (withRetry). Argus MCP server (`src/mcp-server.js`): 9 tools — `argus_audit` (+ `cache:true` option, `auditCache` Map), `argus_audit_full`, `argus_compare`, `argus_last_report`, `argus_watch_snapshot` (+ `tabId` for multi-tab), `argus_get_context` (+ `tabId` + `open_tabs` response field; fix loop: `snapshot_id` diff `resolved / new_issues / persisting`), `argus_design_audit` (Figma fidelity audit, 13 finding types + selector fallback chain), `argus_visual_diff` (visual regression baseline comparison, `updateBaseline` flag), `argus_pr_validate` (PR diff → affected routes → targeted audit → `{ findings, affectedRoutes, blocked, blockOn }`); `snapshotStore` + `auditCache` Maps (max 20 entries, LRU eviction); `CdpBrowserAdapter` now has `listPages()` + `selectPage(tabId)`; published to npm as `argusqa-os@9.6.1`; CI harness gate via `.github/workflows/harness-ci.yml` (exits 0 on known permanent failures only); `glama.json` expanded with name + description + tools; harness block [84] (7 assertions, `cli/init.js` smoke test); permanent-failure exit logic in `validate.js` (exits 0 when only [49b]/[67b]/[68b] fail). Tier 1 complete: `browser.heapSnapshot` → `take_heapsnapshot`; `browser.emulateCpu` → `emulate({ cpuThrottlingRate })`; stale `emulate_cpu` entry removed from `mcp-client.js`. Tier 2 complete (v9.4.6): GAP-002 path traversal fix (`path.relative()`), GAP-003 `withMcp()` error logging, GAP-008 Slack `WebClient` lazy-init, GAP-009 401/403 gated on `routeIsCritical`, GAP-010 broken-link 15 s outer timeout, GAP-001 late JSON-RPC response logging, GAP-006 CI harness KNOWN_PERMANENT documented. Also: all 10 Dependabot PRs applied (v9.4.3); phantom `chrome` dep + unused `sharp` removed; Socket.dev URL fixes — `y.com`/`yourapp.com` → `example.com` (v9.4.5); OTel `service.version` corrected to current; MCP Registry description updated; published to registry.modelcontextprotocol.io + listed on awesome-mcp-servers (PR #7022). Tier 3 complete (v9.5.0): 9 new harness blocks [85]–[93] — production-code-path regression tests for GAP-009 (401/403 severity via `crawlRouteCheap`), GAP-022–GAP-030; `diffNetworkRequests`/`diffConsoleMessages` utility unit tests; `checkLighthouse` contract (soft); 27 new hard assertions. Harness: 525/528 (126 blocks). Gap-close complete (Sections 1–6 of `test-harness-gaps.md`): 33 new blocks [94]–[126] added across 6 sections, covering zero-coverage modules, partial-coverage edge cases, MCP stdio transport, npm scripts, unhappy paths, and CLI end-to-end file write. Tier 4 complete (2026-05-31): 14 code-quality gaps resolved — `snapshot(opts)` forwarding (GAP-014), stale version comments removed from 4 files (GAP-016), shell metacharacter check removed from `mcp-client.js` (GAP-017), `LIGHTHOUSE_TIMEOUT_MS` promoted to module level and applied to `checkLighthouse()` (GAP-018), click no-retry documented in `flow-runner.js` (GAP-019), `saveSession()` file-write wrapped in try/catch (GAP-020), `ARGUS_WATCH_UI_PORT` added to `.env.example` (GAP-021), `createFinding()` canonical optional fields documented (GAP-033), CSS analysis moved to `registerExpensive` plugin (GAP-034), retry log includes error constructor name (GAP-036), Slack retry adds jitter (GAP-037), `mcp.close()` error logged at debug level (GAP-038), route path added to orchestrator log lines (GAP-039), `restoreSession()` navigate wrapped with 10 s timeout (GAP-040). Milestone 1 complete (v9.5.2, 2026-06-01): `theme-analyzer.js` — A7 Theme & Dark Mode detection; `emulateColorScheme(scheme)` added to `CdpBrowserAdapter`; fixture `theme-issues.html`; harness block [127] (7 assertions). Milestone 2 complete (v9.5.3, 2026-06-04): `src/adapters/figma.js` — `inferSelectors()` generates 4 selector candidates per node (`[data-testid="slug"]`, `[aria-label="name"]`, `#slug`, `.slug`; explicit selectors like `#hero` honoured verbatim); per-corner radii extracted as `{topLeft,topRight,bottomRight,bottomLeft}` object when non-uniform; shadow includes spread + r/g/b/a; text content (`characters`); `design-fidelity-analyzer.js` — `findElementWithSelector()` tries each candidate, reports matched selector in finding; 13 mismatch finding types: `design_token_mismatch`, `design_component_missing`, `design_color_mismatch` (RGB Euclidean, threshold 22), `design_typography_mismatch` (fontSize/fontWeight/lineHeight/fontFamily/letterSpacing), `design_spacing_mismatch` (padding, 2px), `design_radius_mismatch` (per-corner, 1px each), `design_bounds_overflow` (5px), `design_position_drift` (scroll-corrected absolute x/y vs Figma bounds, 20px), `design_stroke_mismatch` (border color+weight), `design_shadow_mismatch` (offsetX/Y 1px + blur 2px + spread 2px + color RGB), `design_opacity_mismatch` (10%, when Figma < 100%), `design_gap_mismatch` (columnGap/rowGap by layoutMode, 2px), `design_text_mismatch` (textContent vs Figma characters); 12 threshold constants; `design_fidelity_summary` aggregates all 13 counts; `argus_design_audit` summary returns all 13 + positionDrifts counts; fixture `design-fidelity.html` has 11 elements; block [128] has 30 assertions [128a]–[128ad]; 56 detection categories; 128 blocks / 565 assertions (pre-Milestone-9). Milestone 9 complete (v9.5.4, 2026-06-05): `web-vitals-analyzer.js` — per-run Core Web Vitals via browser Performance API (headless-compatible): LCP, CLS, FCP, TTI, TTFB; `perf_bundle_large` (JS ≥500KB warning / ≥2MB critical; CSS ≥150KB warning); `perf_vitals_summary` always emitted; fixture `perf-vitals.html`; harness block [129] (7 hard + 2 soft assertions); 57 detection categories; 57 fixture pages; 130 blocks / 581 assertions. Milestone 3 complete (v9.5.5, 2026-06-06): `visual-diff-analyzer.js` — A8 Visual Regression via pixelmatch screenshot baseline comparison; `visual_baseline_created` (info, first run), `visual_regression` (warning ≥0.1% / critical ≥5%), `visual_diff_summary` (always emitted); BFcache fix; fixture `visual-regression.html`; block [130] 9 assertions; 578/581 gate. Milestone 4 complete (v9.5.6, 2026-06-06): `a11y-deep-analyzer.js` — axe-core 4.12 injection (80+ WCAG 2.x rules, impact→severity mapping, dedup with existing analyzers) + protanopia/deuteranopia CVD color blind simulation; `a11y_axe_violation` (critical/warning/info), `a11y_colorblind_risk` (warning), `a11y_deep_summary` (info, always); fixture `a11y-deep-issues.html`; block [131] 9 assertions; 59 detection categories; 58 fixture pages; 131 blocks; 590 assertions; 587/590 gate. Extension complete (v9.5.7, 2026-06-06): `argus_visual_diff` 8th MCP tool; 592 assertions; 589/592 gate. Milestones 5/5b/5c/5d complete (v9.5.8, 2026-06-07): `har-recorder.js` (N1), `motion-analyzer.js` (A9), `font-analyzer.js` (A10), `form-analyzer.js` (A11); `emulateReducedMotion` on CdpBrowserAdapter; 63 detection categories; 62 fixture pages; blocks [132]–[135]; 616 assertions; 613/616 gate. Milestone 6 complete (v9.5.9, 2026-06-07): `github-reporter.js` — `createCheckRun`/`completeCheckRun` (GitHub Checks API), selector-linked findings column, visual regression section + `ARGUS_DIFF_IMAGE_URL` embed, `generateReleaseNotes()` pure function, `ARGUS_CRITICAL_THRESHOLD` configurable gate, `GITHUB_CHECK_NAME`; block [136] 10 assertions; 626 assertions; 623/626 gate. Milestone 7 complete (v9.6.0, 2026-06-08): `src/utils/pr-diff-analyzer.js` — `parsePrUrl()`, `fetchPrFiles()`, `mapFilesToRoutes()` (infrastructure detection + slug heuristic + conservative fallback); `argus_pr_validate` 9th MCP tool (PR diff → affected routes → targeted `argus_audit` per route → `{ findings, affectedRoutes, blocked, blockOn }`); `action.yml` composite GitHub Action wrapper; `ARGUS_BLOCK_ON` env var (`none | warning | critical`); block [137] 8 assertions; 634 assertions; 631/634 gate. v9.6.1 (2026-06-08): `src/cli/pr-validate.js` — headless CI entry point that replicates `handlePrValidate` logic directly (no MCP round-trip); exports `buildStepSummary`, `writeGithubOutputs`, `writeStepSummary` for test-harness use without Chrome; `action.yml` rewritten with Chrome binary detection chain, `setup-node@v4`, `routes-file`/`node-version`/`pr-url` inputs, safe env-var injection, `$GITHUB_OUTPUT` + `$GITHUB_STEP_SUMMARY` writes; block [138] 10 assertions (CLI helper unit tests, no Chrome required); 644 assertions; 641/644 gate. v9.6.6 (2026-06-09): PR Validator hardening — `checkTargetReachable()` preflight (network-error-only, HTTP 4xx pass), `normalizeRoutePaths()` (prepends `/` to bare paths), all-routes-failed guard (throws when every route errors), `EXCLUDED_PATTERNS` CI-only/doc-only PR skip (`mapFilesToRoutes` returns `[]`), `notifications/initialized` MCP handshake after `initialize`, `baseUrl = targetUrl.replace(/\/$/, '')` path-prefix preservation (not `.origin`), block-on=warning annotation fix; `action.yml` description ≤125 chars, `argusqa-os@9.6.6` + `chrome-devtools-mcp@1.1.1` version-pinned; [137i–k] + [138k–p] 9 new assertions; 653 assertions; 650/653 gate. Milestone 8 complete (v9.7.0, 2026-06-10): `src/cli/chrome-launcher.js` — `findChrome()`/`launchChrome()` cross-platform (Windows/Mac/Linux, ARGUS_CHROME_PATH override) + `npm run chrome`/`argus-chrome` bin; `src/cli/doctor.js` — `checkChrome()`/`checkMcpConfig()`/`checkEnvKeys()` pre-flight checks + `npm run doctor`/`argus-doctor` bin; `security-analyzer.js` extended with 4 new finding types: `security_missing_sri` (DOM SRI on external scripts/links), `security_sourcemap_exposed` (network .map file detection), `security_open_redirect` (redirect param heuristic), `security_npm_vulnerability` (npm audit --json subprocess, shell:true Windows-safe); `pdf-exporter.js` — `exportReportToPdf`/`exportPageToPdf` via puppeteer (optional peer dep) + `npm run report:pdf`; `screen-recorder.js` — `PollingRecorder` (zero deps, screenshot intervals) + `CdpScreenRecorder` (ws dep, Page.startScreencast, auto-ffmpeg); 67 detection categories; block [139] 11 assertions [139a–k]; 664 assertions; 661/664 gate. v9.7.1 (2026-06-11): [49b] drag/drop root-caused as an Argus bug, not a Chrome/MCP limit — `resolveUidForSelector()` substring matching resolved `#drag-source` to the fixture's explanatory paragraph StaticText instead of the draggable div; fixed with exact-accessible-name-first matching (two-pass) in `flow-runner.js`; [49b] removed from `KNOWN_PERMANENT`; upstream chrome-devtools-mcp issue #2182 closure confirmed correct; 662/664 gate. v9.7.2 (2026-06-11): [67b]/[68b] Issues panel root-caused as Argus bugs too — MCP returns issues as markdown text (`msgid=N [issue] text`) but `normalizeArray()` returns `[]` for strings, so all issues were silently discarded (production Issues detection was dead); fixed with `parseConsoleMsgResponse()` in `issues-analyzer.js` (baseline/preserved-messages logic dropped — list resets per navigation) and `orchestrator.js` (mirrors D5 console guard); `issues-deprecated.html` fixture updated to `unload` listener (Mutation Events removed in Chrome 127, same-value `document.domain` is a no-op); `KNOWN_PERMANENT` now empty; **664/664 gate — no permanent failures**. MIT items complete (v9.7.3, 2026-06-11): `noise-filter.js` — intelligent baseline filtering: cross-run flip-flop classifier over `reports/baselines/<branch>-history.json` (last 20 runs); findings with presence-flip ratio ≥0.4 across ≥4 runs get `noisy: true` + `noiseScore` + `originalSeverity` and are downgraded to info (never suppressed); `ARGUS_NOISE_FILTER=0` disables. `root-cause-linker.js` — `getRecentChanges()` (`git log --name-only`, last 10 commits) + `matchFilesToRoutePath()` (slug heuristic, `INFRA_PATTERNS` now exported from `pr-diff-analyzer.js`) + `linkRootCauses()` annotates NEW findings with `rootCause: { files, commits, global }`; `ARGUS_ROOT_CAUSE=0` disables. Both integrated into `report-processor.js` after `applyBaseline` (fail-safe try/catch); run history recorded alongside `saveBaseline`. Blocks [140] (7 assertions) + [141] (8 assertions); 141 blocks; 679/679 gate. Pre-E2E audit complete (v9.7.4, 2026-06-12): same-bug-class sweep found and fixed three more dead markdown-vs-structured consumers — `browser.getNetworkRequest` sent `requestId` but chrome-devtools-mcp expects `reqid` (every call errored), `contract-validator.js` read `raw.responseBody` off markdown text (D7.4 API contract validation was dead in production; now parses the `### Response Body` section via exported `extractResponseBody()`), and `argus_get_context.open_tabs` did `Array.isArray()` on markdown (always `[]`; now parsed via `parseListPagesResponse()` in `mcp-parsers.js`); `selectPage(tabId)` coerces to Number (select_page Zod-validates pageId as number); `mcp-server.js` missing `logger` import fixed (every withMcp error path threw ReferenceError, masking real errors); Server version now read from package.json (was hardcoded '9.6.6'); `handlePrValidate` preserves target path prefixes (mirrors CLI); `pr-diff-analyzer.js` 300+-file warning moved to stderr logger (stdout reserved for JSON-RPC; CLI emits the `::warning::` annotation); `action.yml` pin bumped 9.6.6→9.7.3; `WatchSession` dedup sets + findings capped (5000 keys / 2000 findings); `harness:staging` now uses cross-platform `--port=3101 --staging` flags (env-prefix form was POSIX-only); doctor `.mcp.json` remediation text shows the actual JSON to add; root-cause-linker handles empty commit subjects (raw-tab detection); block [142] (9 assertions [142a–i]); 142 blocks; **688/688 gate**. HARNESS_MAX_PLAN Phase 1 — contract armor (2026-06-13; test-harness + browser.js/mcp-client.js only — npm publish pending, NOT yet released): block [143] CdpBrowserAdapter wire-contract conformance (28 hard + 5 soft + meta [143zz]; live-Chrome prototyping found + fixed 4 dead wire features — `handleDialog` `{action}`, `wait_for` `text:[]` + `#waitForNetworkIdle`, mcp-client `take_screenshot` image-item scan, `emulateReducedMotion` throws-on-unsupported); block [144] MCP tool error-path matrix (16 hard [144a–p]: structured `{error}` + `isError` + server-survives + no masked `"is not defined"`; pins the `navigate()` throw-on-failure + the v9.7.4 logger-import regressions); block [145] multi-tab end-to-end (6 hard [145a–f]: `new_page` auto-select, `argus_get_context.open_tabs`, `selectPage` page-switch, `close_page` cleanup); +50 hard assertions; 145 blocks; **738/738 gate**. Post-Phase-1 cleanup (2026-06-13): removed dead+redundant `checkPerformanceBudgets` (orchestrator.js — broken trace/insight wiring, never produced a finding) plus the superseded perf-budget harness block [11] + `measurePerf` helper + 3 perf fixtures (`perf-issues`/`perf-lcp`/`perf-fid.html`) + 2 dead server endpoints — Core Web Vitals are covered by the web-vitals analyzer (block [129]); `perf-cls.html` retained for block [92]; block id [11] retired (deliberate [10]→[12] gap); **144 blocks / 60 fixtures / 738/738 gate**. HARNESS_MAX_PLAN Phase 2 — assertion quality (2026-06-13/14; test-harness + contracts only — npm publish pending): 2.1 vacuous-assertion sweep (upgraded the sole vacuous-upgradeable hit [119c] `open_tabs` to a content assertion in place); 2.2 block [146] anti-vacuous self-lint (5 hard [146a–e]: the harness reads its own source and gates bare `Array.isArray` / `typeof x==='object'` / `.length>=0` assertions against reviewed allowlists, each family carrying a positive control); 2.3 block [147] golden response schemas for all 9 MCP tools (`test-harness/contracts/mcp-tool-schemas.js`, exported for E2E; 14 hard [147a–n]: live safeParse ×8 + `argus_pr_validate` handler↔schema source cross-check + tool→schema coverage ratchet + 3 anti-vacuous negative controls + completion guard) — shook out + fixed the `argus_compare` two-mode contract (env-comparison vs css-analysis) via a discriminated union. +19 hard; **146 blocks / 60 fixtures / 757/757 gate**. HARNESS_MAX_PLAN Phase 3 — drift defense (2026-06-14; test-harness + contracts only — npm publish pending): 3.1 upstream canary + 3.4 Chrome-rot watch — block [148] (5 hard [148a–e]): a freshly spawned `chrome-devtools-mcp@1.1.1` `tools/list` is diffed (tool set + required params + property names/types) against the new golden snapshot `test-harness/contracts/chrome-devtools-mcp@1.1.1.json` so the next `reqid→requestId`-class param rename fails at a version bump, not silently in production; [148d] keeps the `mcp-client.js` pin and the snapshot filename in lockstep; [148e] is a Chrome-rot watch asserting `issues-deprecated.html` still emits a DeprecationIssue in the live Chrome (attributes a Chrome-upgrade regression to Chrome, not to block [68]). New harness helper `listChromeDevtoolsMcpTools()` (raw JSON-RPC spawn). No src/ change. **148 blocks / 61 fixtures / 832/832 gate**. 3.2 — block [149] per-category negative controls (70 hard): the real production pipeline run against the new `negative-controls.html` fixture asserts ZERO over-fire across 65 detection categories. 3.3 complete (2026-06-14): block [150] verification-gap closure (13 hard [150a–m]) — positive firing fixtures for the previously-untriggered `focus_lost` (new `keyboard-focus-lost.html`), `security_no_https` (exported `checkHttpsRequired()` rule in `orchestrator.js`), `cors_violation` and `cookie_attribute_missing` (new `issues-cookie.html` + reused `cors-error.html`). The latter two shook out a REAL production bug: Chrome 149's CORS/cookie Issues-panel titles ("Ensure CORS response header values are valid" / "Mark cross-site cookies as Secure…") matched none of the `issues-analyzer.js` classifier patterns, so every real CORS/cookie Issue fell through to `unclassified_devtools_issue` — fixed and pinned by [150i]/[150k]/[150m]. `mixed_content` (needs HTTPS), `low_contrast_native` (DevTools-audit-only) and `permission_policy_violation` (needs a secure context) remain environment-limited, covered as [149] negative controls. **149 blocks / 63 fixtures / 845/845 gate.** HARNESS_MAX_PLAN Phase 4.1 — coverage gate (2026-06-15; test/CI/config only — no src change, npm publish unaffected): new `scripts/coverage-gate.mjs` merges the unit half (Vitest v8, `coverage/unit/`) and the harness half (c8 over `npm run test:harness`, in-process src/ → `coverage/harness/`) — two tools because Vitest workers don't propagate `NODE_V8_COVERAGE` to c8 — and gates `--min-lines 60` (observed merged **75.00% lines**, conservative floor, ratchet later) + `--allow-uncovered` (the zero-coverage-module guard: fails if any non-allowlisted src/ file has 0 covered lines; allowlist = the 3 subprocess-only entry points `mcp-server.js`/`server/index.js`/`env-comparison.js`). The 2 audit-flagged zero-coverage modules are now unit-tested without Chrome (`screen-recorder` 0→46.6%, `pdf-exporter` 0→39.0%; **unit suite 61→72 tests, 6→8 files**); `harness-ci.yml` runs the harness once under c8 (exit code still gates the 845) + unit-under-coverage + a `coverage:gate` step; new devDeps `c8` + `@vitest/coverage-v8` + `istanbul-lib-coverage`, configs `.c8rc.json` + `vitest.config.js`. HARNESS_MAX_PLAN Phase 4.2 complete (2026-06-15, test/unit only): `test/unit/parser-fuzz.test.js` (fast-check, Chrome-free; 22 property tests over the wire/parser fns, each encoding the function's real source contract) takes the unit suite to **94 tests / 9 files**; harness unchanged (149/845). HARNESS_MAX_PLAN Phase 4.3 complete (test-harness + CI only, no src change): `ARGUS_HARNESS_STRICT_SOFT` in `validate.js` promotes every `soft()` to a counted hard assertion (the ~23 Lighthouse / perf-trace / heap-growth checks that return null or skip in headless); the default per-PR run is unchanged at 845. New weekly workflow `.github/workflows/harness-headful.yml` runs the harness under Xvfb + non-headless Chrome with the flag set, so those soft checks move from "never verified" to "verified weekly" outside the per-PR gate (headless wiring proof: flag on → 868 = 845 + 23 promoted, flag off → 845). **Phase 4 (and HARNESS_MAX_PLAN) complete.** Follow-up Lighthouse fix (post-4.3): the headful-lane verification surfaced that `lighthouse_audit` was being called with an unsupported `url`/`categories` argument (chrome-devtools-mcp rejects it), so **Lighthouse had never actually run in Argus** — production `checkLighthouse` (orchestrator.js:789) always caught the error and skipped, and the harness Lighthouse softs were perpetually N/A. Fixed across `src/adapters/browser.js` (navigate-first, drop url/categories), `src/utils/lighthouse-checker.js` (new exported `parseLighthouseReport()` reads the response's report.json → `{categories, audits}`), and the harness `measureLighthouse`; Lighthouse now returns real scores (accessibility / best-practices / seo — performance is excluded by the tool by design, covered by web-vitals [129]). A previously-dead `checkLighthouse` field-shape assertion now fires (made unconditional for a deterministic count) → **default gate 845 → 846**; the strict-soft lane is now 869/869 (846 + 23 promoted softs all green). `browser.js` + `lighthouse-checker.js` are src changes → next npm publish. See `SKILL.md` §14 for the full feature list.

**Landing page** (`landing/`): React 19 + Vite 8 + Tailwind + Framer Motion SPA with Supabase-backed waitlist and enterprise contact forms. Deployed to `argus-qa.com` via Cloudflare Pages (`npx wrangler pages deploy dist --project-name argus-qa`); video served from Cloudflare R2. Milestone 0 complete (2026-05-26): 44px touch targets, `MotionConfig reducedMotion="user"`, modal `100dvh` keyboard fix, `@supports (height: 100dvh)` CSS. Hero stats row stacks on mobile (`flex-col sm:flex-row`); slide widget reduced to 6 slides; `clamp()`-based fluid typography throughout. SEO: full OG tags, `summary_large_image` Twitter card, canonical, JSON-LD `SoftwareApplication`, `robots.txt`, `sitemap.xml`. OG social card: `landing/public/og-image-v2.jpg` — 1200×630 JPEG, cover-mode scaled from `argus-poster.png`, branded overlay with black-outlined purple stat numbers. Video poster: `landing/public/argus-poster.png`; `poster="/argus-poster.png"` on `<video>` tag. `landing/public/og-image.jpg` gitignored.
