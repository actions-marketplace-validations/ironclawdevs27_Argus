# Argus vX1 — Extended Vision & Maximum Potential Roadmap

> **Document scope**: Long-horizon product vision beyond the v9 sprint cadence. Defines a fresh sprint sequence ordered strictly by priority (highest value, lowest friction first), the Figma MCP integration plan, and the full feature roadmap. Sourced from a comprehensive analysis of the Argus codebase against Playwright, Puppeteer, Lighthouse, axe-core, Percy, Sentry, and others.

---

## Version Naming

| Label | Meaning |
| --- | --- |
| **Argus v9** | Current production — Sprints 1+2+3+9 complete (v9.5.5), 130 test blocks, 58 detection categories, OTel instrumentation, multi-tab watch mode, audit caching, CI harness gate, GitHub Security/Dependabot/CodeQL configured; published to npm as [`argusqa-os@9.5.4`](https://www.npmjs.com/package/argusqa-os) |
| **Argus vX** | Extended vision track — features beyond the original v9 sprint scope |
| **vX1** | First coherent release of the extended track — this document defines it |

The `vX` suffix distinguishes this roadmap from the `v9` sprint numbering. vX1 is not "version 10" — it is the first release of a broader product trajectory that may span many implementation sprints.

---

## Current Infrastructure Status (v9.5.5 — 2026-06-06)

| Area | Status | Detail |
| --- | --- | --- |
| npm package | ✅ Live | `argusqa-os@9.5.5` published — Sprints 1+2+3+9 complete |
| MCP Registry | ✅ Live | Auto-syncs from npm via `glama.json`; listing at glama.ai/mcp/servers/ironclawdevs27/Argus |
| Landing page | ✅ Current | [argus-qa.com](https://argus-qa.com) via Cloudflare Pages — stats: 58 types · 130 blocks · 581 assertions |
| GitHub releases | ✅ v9.5.5 | Release `v9.5.5` created on main; previous: v9.5.4 (unpublished to npm), v9.5.3 |
| CI harness gate | ✅ Active | `.github/workflows/harness-ci.yml` — 130 blocks, 578/581 pass, exits 0 on known failures |
| CodeQL scanning | ✅ Active | `.github/workflows/codeql.yml` — JS `security-and-quality` on every PR + weekly |
| Dependabot | ✅ Active | `.github/dependabot.yml` — npm (root + landing) + Actions, weekly |
| Security policy | ✅ Published | `.github/SECURITY.md` — responsible disclosure, scope, design notes |
| Publish workflow | ✅ Active | `.github/workflows/publish.yml` — auto-publish to npm + GitHub Packages on release |
| Test harness | ✅ 130 blocks | `test-harness/validate.js` — 581 hard assertions, 57 fixture pages, 58 detection categories |
| Unit tests | ✅ 61 tests | `test/unit/` — 6 Vitest files, zero Chrome dependency |
| Gap audit | ✅ Done | `argus-vX1-gaps.md` — 40 gaps identified (2026-05-30); Sprint 0.5 Tiers 1–4 complete |

---

## Pending External Actions

These items are not sprint work but must be tracked and resolved. They sit outside the codebase — in third-party repos, registries, and upstream projects.

### 1 — awesome-mcp-servers Listing

| Item | Status | Action |
| --- | --- | --- |
| PR #7022 on punkpeye/awesome-mcp-servers | ⏳ Open | Comment added (2026-06-06) nudging maintainer — `missing-glama` bot label is a false positive, Glama listing is live and A-rated. Waiting for maintainer merge. No code change needed. |

Once merged, Argus appears in the curated awesome-mcp-servers list and drives organic discovery from the MCP ecosystem.

---

### 2 — OSS Contribution: chrome-devtools-mcp

Three Argus harness blocks fail permanently due to MCP-layer limitations in `chrome-devtools-mcp`. These cannot be fixed in Argus code — they require upstream changes. Full implementation plan in `OSS-PR-STRATEGY.md`.

#### Current permanent failures (3 of 581 assertions)

| Block | Assertion | Root cause |
| --- | --- | --- |
| `[49b]` | `drag` tool: DOM `drop` event never fires | `Input.dispatchDragEvent` doesn't synthesise DOM `drop` in `--headless=new` |
| `[67b]` | `list_console_messages({ types: ['issue'] })` returns 0 CSP violations | `Audits.enable()` not called when MCP attaches to externally-launched Chrome |
| `[68b]` | `list_console_messages({ types: ['issue'] })` returns 0 deprecated API findings | Same root cause as `[67b]` |

Fixing all three brings the harness to **581/581 (100%)**.

#### Status

| Step | Status | Detail |
| --- | --- | --- |
| Sign Google CLA | ⬜ Pending | Required before any PR is accepted — `cla.developers.google.com` |
| File Issue #1 (CSP/deprecated API) | ✅ Done (2026-06-06) | Filed on ChromeDevTools/chrome-devtools-mcp — covers `[67b]` + `[68b]` |
| File Issue #2 (drag/drop) | ✅ Done (2026-06-06) | Filed on ChromeDevTools/chrome-devtools-mcp — covers `[49b]` |
| Wait for maintainer acknowledgement | ⏳ Pending | Get alignment on fix approach before writing PRs |
| PR 1 — Audits domain fix | ⬜ Pending | `src/PageCollector.ts` + `src/formatters/IssueFormatter.ts` + `src/tools/console.ts` — ~30 lines |
| PR 2 — Drag/drop JS fallback | ⬜ Pending | `src/tools/input.ts` — ~25 lines |
| Update Argus `validate.js` | ⬜ Pending | Remove `[49b]`/`[67b]`/`[68b]` from `KNOWN_PERMANENT` after PRs merge |

> See `OSS-PR-STRATEGY.md` for the complete TypeScript implementation plan, file-by-file changes, eval test scenarios, commit message format, and CLA process.

---

## Licensing Boundaries

> **Source**: `business-analysis.md §6 — MIT License as GTM Strategy`. Read that section before building any Sprint 7, 10, or cloud-infrastructure component.

The MIT license is the distribution engine — it drives adoption → stars → press → inbound → SaaS conversions. It must not be weakened. At the same time, certain components are the *business*, not the funnel. The rule is simple:

| Component | License | Tier | Rationale |
| --- | --- | --- | --- |
| Detection engine (`src/utils/*-analyzer.js`, `src/orchestration/`) | **MIT — open source forever** | Free | This is the funnel. Restricting it destroys community trust and is irreversible |
| CLI (`src/cli/`, `src/batch-runner.js`, `npm run *`) | **MIT — open source forever** | Free | The CLI is how developers discover and adopt Argus |
| MCP server (`src/mcp-server.js`) | **MIT — open source forever** | Free | Claude Code users must be able to self-host without restriction |
| Basic GitHub/Slack integrations (existing v9) | **MIT — open source forever** | Free | Already shipped and public |
| Sprints 1–6, 8–9 (per-run analysis), 11–14 | **MIT — open source forever** | Free | All detection features; self-hosters get the full audit engine |
| `severity-overrides.js` (D7.5 — already shipped) | **MIT — open source forever** | Free | Config-file mechanism: developers set `severityOverrides` in `targets.js` to suppress or downgrade specific finding types. This is a basic per-project developer option — fundamentally different from the Enterprise "Custom detection rules & policies" row (below), which will be a UI-driven central policy management system for organizations |
| Sprint 9 — per-run performance capture | **MIT** | Free | Capture LCP/CLS/etc. per run and write to local findings JSON |
| Intelligent baseline filtering (Sprint 17) | **MIT** | Free | Pure algorithmic — no external API, no per-run cost |
| Root cause linking (Sprint 17) | **MIT** | Free | Git diff heuristic mapping — no API call |
| **AI verdict engine** (Sprint 7 — `ai-verdict.js`, `github-pr-validator.js`, `azure-pr-validator.js`) | **Closed source** | Pro+ | First proprietary moat; ships as the SaaS merge-gate product |
| **SaaS Web Dashboard** (Sprint 10 — React app, auth, billing, scheduled audits, cloud storage) | **Closed source** | Pro+ / Team+ | The dashboard IS the SaaS product; open-sourcing it removes the business |
| **Cloud infrastructure** (Cloudflare R2, hosted runners, SSO, on-premises deployment) | **Closed source** | Pro+ / Enterprise | Infrastructure is not a feature users need to fork |
| **Sprint 9 — time-series storage API** (trend persistence layer) | **Closed source** | Team+ | Feeds "Trend charts & regression alerts"; self-hosted findings JSON is sufficient for free users |
| **Sprint 15 — Compliance & Legal Checks** (entire sprint) | **Closed source** | Enterprise | "Compliance & audit log reports" is an explicit Enterprise-only feature |
| **Sprint 16 — Third-Party Integrations** (entire sprint) | **Closed source** | Team+ / Enterprise | Jira, PagerDuty, LaunchDarkly, webhooks = Enterprise; Datadog, Sentry = Team+ |
| **Sprint 17 — Natural language summaries, recommended fixes, predictive analytics** | **Closed source** | Pro+ / Team+ | Calls Anthropic API per run (billed) or requires cloud history (Sprint 10); not viable self-hosted |

> **Nuance — `severity-overrides.js` vs Enterprise "Custom detection rules & policies"**: These are two distinct products at different sophistication levels. `severity-overrides.js` (D7.5) is a file-config developer option — edit `severityOverrides` in `targets.js` to suppress a noisy finding or downgrade its severity for your project. It is already MIT, already shipped, and stays MIT. The Enterprise "Custom detection rules & policies" (Sprint 16 pricing row) is a future UI-driven organization-wide policy engine: a dashboard where compliance leads define suppression rules across all projects and teams, with audit logs and role-based enforcement. When documentation or marketing references "Custom detection rules & policies," it refers exclusively to that dashboard engine — not the file-config option that self-hosters already have.

**What this means in practice:**
- Sprints 1–6 and 8–9: all output goes into the public MIT repo as normal.
- Sprint 7: `ai-verdict.js` and the two validator integrations ship in a **private repo** (e.g., `argus-qa/argus-pro`). The `action.yml` GitHub Action wrapper can be public (it calls the hosted API); the verdict logic itself stays private.
- Sprint 10: the dashboard ships in a **private repo**. The public repo gets no dashboard code.
- Do **not** add BSL, SSPL, or any Commons Clause variant to the MIT repo — Anthropic's ecosystem specifically values MIT-licensed tools and any restriction is very hard to reverse.

---

## Sprint Sequence — Priority Order

Sprints are numbered 0 → N. Sprint 0 is pre-launch landing page work. **Sprint 0.5** is the codebase gap-remediation sprint (must ship before Sprint 1). Sprints 1–17 are Argus tool features, ordered strictly by: **quick wins first → high value → medium priority → platform expansion**. No sprint should be started before the one above it is shipped.

---

### Sprint 0.5 — Codebase Gap Remediation *(Must ship before Sprint 1)*
**Effort: Medium | Value: Critical (correctness + security)**  
**Scope**: Fix all 40 gaps identified in `argus-vX1-gaps.md` (2026-05-30 deep audit). No new features — correctness and security only.

Full gap list: see `argus-vX1-gaps.md`.

#### Tier 1 — Broken functionality ✅ COMPLETE (v9.4.2, 2026-05-30) + security patches v9.4.3–9.4.5

| Gap | File | Status |
|-----|------|--------|
| GAP-004 | `src/adapters/browser.js:30` | ✅ Fixed — `take_memory_snapshot` → `take_heapsnapshot`; `mcp-client.js` + all docs updated |
| GAP-005 | `src/adapters/browser.js:49` | ✅ Fixed — `emulateCpu`: `emulate_cpu({ throttlingRate })` → `emulate({ cpuThrottlingRate })`; `emulate(viewport)` was correct (false partial) |
| GAP-011 | `src/orchestration/orchestrator.js:22` | ❌ FALSE POSITIVE — `session-manager.js` exists and re-exports both modules correctly |
| GAP-013 | `test-harness/validate.js:69` | ❌ FALSE POSITIVE — both `parseIssues` and `analyzeIssues` exported from `issues-analyzer.js` |
| GAP-015 | `test-harness/validate.js:50, 398` | ❌ FALSE POSITIVE — `normalizeArray` exported from `flow-runner.js` line 172 |
| GAP-032 | `src/mcp-server.js:208–227` | ❌ FALSE POSITIVE — `snapshotStore.has(prevId)` guard already in place before `.get()` |

#### Tier 2 — Security + stability (fix before next release)

| Gap | File | Fix |
|-----|------|-----|
| GAP-002 | `src/utils/contract-validator.js:108–125` | Path traversal: use `path.relative()` + reject `..` segments |
| GAP-003 | `src/mcp-server.js:124–131` | Explicit try/catch around `fn(mcp)` in `withMcp()` |
| GAP-006 | `.github/workflows/harness-ci.yml` | Document `KNOWN_PERMANENT` contract; print failing block IDs on exit 1 |
| GAP-008 | `src/orchestration/slack-notifier.js:25` | Lazy-init `WebClient` inside posting functions |
| GAP-009 | `src/orchestration/orchestrator.js:280–286` | Gate 401/403 → `critical` on `routeIsCritical` flag |
| GAP-010 | `src/orchestration/orchestrator.js:773–776` | Outer 15 s timeout on broken-link `Promise.all()` |
| GAP-001 | `src/utils/mcp-client.js:88–127` | Log unexpected JSON-RPC shapes; timeout-reject stale pending entries |

#### Tier 3 — Harness coverage ✅ COMPLETE (v9.5.0, 2026-05-30)

| Block | Gap | What it proves |
|-------|-----|----------------|
| [85] | GAP-022 / GAP-009 | 401/403 severity via `crawlRouteCheap`: `critical:true` → `critical`; `critical:false` → `warning` |
| [86] | GAP-023 | `console.error` severity: `critical:true` → `critical`; `critical:false` → `warning` |
| [87] | GAP-024 | `waitFor` selector timeout → `load_failure` finding with selector in message |
| [88] | GAP-025 | Repeated API calls → `api_call_summary` + `api_duplicate_call`; numeric `uniqueEndpoints` |
| [89] | GAP-028 | Missing `<meta name="description">` → `seo_missing_description` warning |
| [90] | GAP-027 | CSS source maps present → `css_summary.scssSourceFiles` non-empty |
| [91] | GAP-026 | CSS without `!important` → `severity: info`, `property` is string |
| [92] | GAP-029 | `checkLighthouse(browser, url)` contract: returns typed array (3 soft assertions) |
| [93] | GAP-030 | `diffNetworkRequests` + `diffConsoleMessages` pure unit tests — `added`/`removed`/`changed` correct |

**Gate: 391/394** — 3 permanent MCP-limited failures only (`[49b]` drag, `[67b]` Issues CSP, `[68b]` Issues CORS)

#### Tier 4 — Code quality / clean-up ✅ COMPLETE (v9.5.1, 2026-05-31)

14 gaps resolved — GAP-014 snapshot opts, GAP-016 stale version strings, GAP-017 shell-metachar check removed, GAP-018 LIGHTHOUSE_TIMEOUT_MS applied, GAP-019 click no-retry comment, GAP-020 saveSession try/catch, GAP-021 .env.example ARGUS_WATCH_UI_PORT, GAP-033 createFinding JSDoc, GAP-034 CSS analysis to registerExpensive, GAP-036 retry error type, GAP-037 Slack jitter, GAP-038 mcp.close debug log, GAP-039 route path in logs, GAP-040 restoreSession timeout.

**FALSE POSITIVES confirmed**: GAP-012 (login-orchestrator IS wired), GAP-031 (TOOL_TIMEOUT_MS IS applied), GAP-035 (discoverRoutes IS used).

**New harness blocks**: Tier 3 adds up to 9 new blocks ([85]–[93]) + assertions for each detected scenario.  
**Version**: Tier 4 ships as v9.5.1.

---

### Sprint 0 — Landing Page: Mobile & Responsive Fixes ✅ Complete (2026-05-26)
**Effort: Low | Value: Critical (pre-launch)**  
**Scope**: Landing page (`landing/src/App.jsx`) only — not the Argus tool.

All 6 issues identified pre-launch are resolved. Site is live at [argus-qa.com](https://argus-qa.com).

#### Sprint 0 Summary

| Issue | File | Status | Notes |
| --- | --- | --- | --- |
| Comparison table overflow | `App.jsx` | ✅ Already handled | `overflowX: 'auto'` was already on the inner wrapper — no change needed |
| Tap targets < 44px | `App.jsx` | ✅ Fixed (2026-05-26) | All 4 buttons raised to 44×44px: hamburger, mobile close, WaitlistModal close, EnterpriseModal close |
| Video poster fallback | `App.jsx` | ✅ Fixed (2026-05-26) | `Argus_bg.png` → `landing/public/argus-poster.png`; `poster="/argus-poster.png"` on `<video>` tag; also used as source for OG card |
| Modal soft keyboard (iOS) | `App.jsx` | ✅ Fixed (2026-05-26) | Both modal outer wrappers now have `overflowY: 'auto'`, `maxHeight: '100dvh'`, `WebkitOverflowScrolling: 'touch'` |
| `prefers-reduced-motion` | `App.jsx` | ✅ Fixed (2026-05-26) | `<MotionConfig reducedMotion="user">` wraps the entire App return — all 30+ Framer Motion blocks respect the OS setting automatically |
| Missing `@media` edge cases | `index.css` | ✅ Fixed (2026-05-26) | `@supports (height: 100dvh)` overrides `.h-screen` for iOS Safari; `@media (prefers-reduced-motion: reduce)` covers CSS transitions; stat row / detection grid / nav spacing handle narrow viewports natively via Tailwind and `clamp()` |

**SEO additions (2026-05-26)**: `index.html` updated with OG tags (`summary_large_image` Twitter card, `og-image-v2.jpg` 1200×630), canonical URL, JSON-LD `SoftwareApplication` schema. `robots.txt` and `sitemap.xml` added to `landing/public/`.

**OG social card (2026-05-26)**: `landing/public/og-image-v2.jpg` — 1200×630 JPEG, cover-mode scaled from `argus-poster.png` (no black borders), branded gradient overlay, "ARGUS" heading, "Every Bug Caught." tagline, black-outlined purple stat numbers (54 / 84 / 367), CTA pill, watermark. `landing/public/og-image.jpg` gitignored.

**Mobile layout (2026-05-26)**: Hero stats row stacks vertically on mobile (`flex-col sm:flex-row` — prevents overlap with slide card at 390px). Slide widget reduced from 8 → 6 slides (removed slides 3 and 8). Fluid typography via `clamp()` on stat numbers and slide text.

**Deployment (2026-05-26)**: Cloudflare Pages via wrangler CLI — `npx wrangler pages deploy dist --project-name argus-qa`. Custom domain `argus-qa.com` active. Background video served from Cloudflare R2.

**Sprint 0 complete — site live at [argus-qa.com](https://argus-qa.com).**

---

### Sprint 1 — Dark Mode & Theme Testing ✅ Complete (v9.5.2, 2026-06-01)
**Effort: Low | Value: High**

The lowest-friction new detection phase. Reuses existing emulation and screenshot infrastructure.

| Task | Detail | Status |
| --- | --- | --- |
| Emulate `prefers-color-scheme: dark` | `browser.emulateColorScheme('dark')` via new `CdpBrowserAdapter` method → `mcp.emulate({ colorScheme: 'dark' })` | ✅ |
| CSS variable extraction | Scan all `@media (prefers-color-scheme: dark)` rules; collect `:root` CSS custom properties in both modes | ✅ |
| Theme consistency finding | `theme_static_var` — flag color `--*` vars identical in both modes (only fires when dark mode query exists) | ✅ |
| Missing dark mode detection | `theme_no_dark_mode` info finding when page has no dark mode media query | ✅ |
| Summary finding | `theme_summary` info — hasDarkMode, rootVarCount, darkEmulated flags | ✅ |

**New file**: `src/utils/theme-analyzer.js` — `registerExpensive` plugin
**New fixture**: `test-harness/pages/theme-issues.html` — 54th fixture page
**New detection category**: `A7 — Theme & Dark Mode`
**Harness block**: `[127]` — 7 hard assertions
**Gate**: 532/535 (3 permanent MCP-limited failures)

---

### Sprint 2 — Figma MCP Integration *(Flagship)* ✅ Complete (v9.5.3, 2026-06-04)
**Effort: Medium | Value: Very High**

See the dedicated section below. This is the single most strategically differentiated feature in vX1 — closes the design → implementation gap automatically.

**Shipped**: 13 mismatch finding types; selector fallback chain (`[data-testid]` → `[aria-label]` → `#id` → `.class`); per-corner radius; shadow color+spread; absolute position drift; 30-assertion harness block [128]; 562/565 gate.

---

### Sprint 3 — Visual Regression Testing ✅ Complete (v9.5.5, 2026-06-06)
**Effort: Medium | Value: High**

| Task | Detail |
| --- | --- |
| Baseline screenshot capture | Full-page and viewport screenshots via `take_screenshot`; stored in `reports/baselines/screenshots/` |
| Pixel diff engine | Integrate [`pixelmatch`](https://github.com/mapbox/pixelmatch) — output diff PNG with changed regions highlighted |
| Diff threshold config | Configurable `visualDiffThreshold` per target in `src/config/targets.js` (e.g. `0.01` = 1% triggers finding) |
| Multi-viewport comparison | Run at 375px, 768px, 1280px automatically |
| Report integration | Embed diff images inline in HTML report; new finding category `A8: visual-regression` |
| Slack attachment | Upload diff PNG as Slack attachment when threshold exceeded |

**New files**: `src/utils/visual-diff-analyzer.js`, `reports/baselines/screenshots/`
**New detection category**: `A8 — Visual Regression`

> **Pricing milestone**: Once Sprint 3 ships **and** the SaaS dashboard (Sprint 10) is live, raise Pro pricing from $29 → **$59/month** and Team from $99 → **$189/month** for new signups. Founding-member accounts stay at their locked rate. Argus at this point competes directly with Chromatic ($149+) and Percy ($599+) on visual testing alone — while doing far more. See `business-analysis.md §3`.

### Sprint 3 Extension — `argus_visual_diff` MCP Tool ✅ COMPLETE (v9.5.7, 2026-06-06)
**Effort: Very Low | Value: High**

Expose the Visual Regression analyzer (`visual-diff-analyzer.js`) as a dedicated 8th MCP tool so Claude (or any MCP client) can call it directly from a conversation — no CLI, no targets.js config required.

| Task | Detail | Status |
| --- | --- | --- |
| New MCP tool `argus_visual_diff` | `argus_visual_diff(url)` — navigates, takes screenshot, compares against baseline, returns `visual_regression` / `visual_baseline_created` / `visual_diff_summary` findings | ✅ |
| Optional `baselineDir` param | Allow callers to specify a custom baseline directory | ✅ |
| Expose `updateBaseline` flag | `argus_visual_diff(url, { updateBaseline: true })` — force-updates the stored baseline | ✅ |
| Register in `src/mcp-server.js` | Add alongside `argus_audit`, `argus_design_audit`, etc. as the 8th tool | ✅ |

**Extends**: `src/mcp-server.js`, `src/utils/visual-diff-analyzer.js`
**No new analyzer** — wraps existing Sprint 3 code as a first-class MCP tool.
**Harness**: blocks [80m]+[80n] (tool registration assertions); [117c] threshold raised to ≥8 tools. Gate: **589/592**.

---

### Sprint 4 — Axe-Core + Deep Accessibility ✅ COMPLETE (v9.5.6, 2026-06-06)
**Effort: Low–Medium | Value: High**

| Task | Detail | Status |
| --- | --- | --- |
| axe-core integration | axe-core 4.12 injected into every page; runs 80+ WCAG A/AA rules; maps impact→severity; deduplicates with snapshot-analyzer | ✅ |
| Color blind simulation | CVD matrices (Machado 2009) for protanopia + deuteranopia; checks WCAG AA contrast (4.5:1) under each deficiency | ✅ |
| Keyboard Tab-walk | Existing `keyboard-analyzer.js` already covers this; not duplicated | ✅ |
| Screen reader simulation | Existing `snapshot-analyzer.js` already covers this; not duplicated | ✅ |

**New file**: `src/utils/a11y-deep-analyzer.js`
**New fixture**: `test-harness/pages/a11y-deep-issues.html` (58th fixture page)
**New finding types**: `a11y_axe_violation`, `a11y_colorblind_risk`, `a11y_deep_summary`
**New detection category**: A12 — Deep Accessibility (59 total)
**New env vars**: `A11Y_CONTRAST_AA` (default: 4.5), `A11Y_MAX_AXE` (default: 50)
**Harness**: block [131] — 9 hard assertions. Gate: **587/590**.

---

### Sprint 5 — HAR Recording & Replay ✅ COMPLETE (v9.5.8, 2026-06-07) & Replay
**Effort: Medium | Value: High**

| Task | Detail |
| --- | --- |
| HAR recording | Capture all network traffic as HAR on baseline runs; save to `reports/baselines/har/` |
| HAR replay | On comparison runs, replay baseline HAR as mock responses — isolates frontend bugs from backend noise |
| Flaky test reduction | Replaying mocked responses removes network variability from findings |

**New file**: `src/utils/har-recorder.js`

---

### Sprint 5b — Motion & Animation Accessibility (A9) ✅ COMPLETE (v9.5.8, 2026-06-07) & Animation Accessibility (A9)
**Effort: Low | Value: High**

Detects pages that use animations/transitions without respecting the user's `prefers-reduced-motion` OS setting — a WCAG 2.1 SC 2.3.3 (AAA) violation that can trigger vestibular disorders.

| Task | Finding | Detail |
| --- | --- | --- |
| `prefers-reduced-motion` violations | `motion_no_reduced_motion_query` | CSS `animation` or `transition` properties in use, but no `@media (prefers-reduced-motion)` query anywhere in the page stylesheets |
| Autoplay video/GIF misuse | `motion_autoplay_no_pause` | `<video autoplay>` without `muted` + a visible pause control, or animated `<img>` (GIF/APNG/WebP) with no pause mechanism |
| Interactive element animation | `motion_interactive_animation` | `transition` / `animation` on `button`, `a`, `input`, `[role="button"]` etc. without a `prefers-reduced-motion: reduce` override |
| Emulation cross-check | `motion_reduced_not_honoured` | Emulate `prefers-reduced-motion: reduce` via `browser.emulate({ reducedMotion: 'reduce' })`; flag elements that still animate |

**New file**: `src/utils/motion-analyzer.js` — `registerExpensive` plugin
**New detection category**: `A9 — Motion & Animation`
**New threshold**: `thresholds.motion.animationPropertyCount` (default: 1 — flag any animated interactive element)

---

### Sprint 5c — Font Loading (A10) ✅ COMPLETE (v9.5.8, 2026-06-07) Loading (A10)
**Effort: Low–Medium | Value: Medium–High**

Detects web font performance and reliability issues that cause invisible text (FOIT) or layout shifts (FOUT) — both affecting Core Web Vitals and user experience.

| Task | Finding | Detail |
| --- | --- | --- |
| FOIT detection | `font_foit_risk` | `@font-face` present with no `font-display` property (defaults to `auto` = FOIT risk in Chrome) |
| FOUT/CLS risk | `font_fout_risk` | `font-display: swap` or `fallback` — layout shift risk; flag when fallback metrics differ significantly from web font |
| Missing fallback | `font_no_fallback` | `font-family` declaration with a web font but no system font fallback (e.g. `font-family: 'MyFont'` with no `, sans-serif`) |
| Slow font load | `font_slow_load` | Web font resource takes > 1000ms to load (via PerformanceResourceTiming on `woff2`/`woff`/`ttf` entries) |
| Unoptimised format | `font_suboptimal_format` | Font served as `.ttf` or `.eot` — should be `.woff2` for production |

**New file**: `src/utils/font-analyzer.js` — `registerExpensive` plugin
**New detection category**: `A10 — Font Loading`

---

### Sprint 5d — Form Validation (A11) ✅ COMPLETE (v9.5.8, 2026-06-07) Validation (A11)
**Effort: Low | Value: High**

Detects accessibility and security gaps in HTML forms — one of the most commonly broken areas in web apps.

| Task | Finding | Detail |
| --- | --- | --- |
| Missing `required` attribute | `form_missing_required` | `<input>` fields with no `required` and no `aria-required="true"`, inside a `<form>` with a submit button |
| No client-side validation | `form_no_validation` | Form submitted (via `submit` event) with empty required fields — no `event.preventDefault()` fired |
| Inaccessible error messages | `form_inaccessible_error` | Error element not linked via `aria-describedby` or `aria-errormessage` to its input |
| Unmasked password field | `form_unmasked_password` | `<input type="text">` adjacent to a password label, or a visible password toggle that switches `type` to `text` without re-masking |
| Autocomplete missing | `form_no_autocomplete` | Personal data fields (name, email, address, CC) missing `autocomplete` attribute (WCAG 1.3.5) |

**New file**: `src/utils/form-analyzer.js` — `registerExpensive` plugin
**New detection category**: `A11 — Form Validation`

---

### Sprint 6 — GitHub PR Comments — Rich Inline Diffs
**Effort: Medium | Value: High**

| Task | Detail |
| --- | --- |
| Visual diff PR attachments | Post diff images directly as PR comment attachments |
| DOM-linked findings | Link each finding to the exact CSS selector in the comment (not just a line number) |
| Check runs with annotations | Per-finding annotations on the GitHub Check run (not just pass/fail at PR level) |
| Critical finding gate | Auto-block PRs when critical finding count exceeds configurable threshold |
| Release notes generation | Auto-generate changelog from Argus findings between tagged runs |

**Extends**: `src/orchestration/dispatcher.js`

---

### Sprint 7 — Azure & GitHub PR AI Validator
**Effort: Medium | Value: Very High**

Extends the basic PR comment integration (Sprint 6) into a full AI-powered merge gate. Claude analyses the git diff alongside Argus findings to produce an intelligent verdict — not just a list of errors, but a reasoned judgment on whether the PR is safe to ship.

Supports both **GitHub** (via GitHub Actions / Checks API) and **Azure DevOps** (via Azure Pipelines task + Azure Repos PR comments).

#### How It Works

```
PR opened / updated
       │
       ▼
argus-pr-validator.js
  1. Fetch git diff (changed files, lines)
  2. Map changed files → affected routes (via target config)
  3. Run argus_audit on affected routes
  4. Pass [diff + findings + baseline delta] to Claude
  5. Claude outputs: verdict + risk summary + per-finding attribution
       │
       ├── GitHub ──▶  PR comment + Check Run status (pass / warn / block)
       └── Azure  ──▶  PR comment + PR vote (Approved / Waiting / Rejected)
```

#### GitHub Integration

```yaml
# .github/workflows/argus-pr.yml
name: Argus PR Validator
on: [pull_request]
jobs:
  argus:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: argus-qa/pr-validator@v1
        with:
          target-url: ${{ env.STAGING_URL }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          block-on: critical         # none | warning | critical
```

**What gets posted to the PR:**

```
## Argus AI Review — ⚠️ 2 issues found

> AI verdict: Safe to merge with review. 1 new warning introduced by this PR;
> 1 pre-existing issue unrelated to changes.

| # | Severity | Finding | Introduced by this PR |
|---|---|---|---|
| 1 | ⚠️ warning | Missing alt text on /checkout hero image | ✅ Yes |
| 2 | 🔴 critical | CSP header missing on /api/* routes | ❌ Pre-existing |

Full report: [argus-report-abc123.html](...)
```

#### Azure DevOps Integration

```yaml
# azure-pipelines.yml
- task: ArgusValidator@1
  inputs:
    targetUrl: $(STAGING_URL)
    anthropicApiKey: $(ANTHROPIC_API_KEY)
    blockPolicy: 'critical'       # none | warning | critical
    postToPr: true
    prVote: true                  # sets Approved / Waiting for Author / Rejected
```

**PR vote mapping:**
| Argus verdict | Azure PR vote |
| --- | --- |
| All clear | Approved |
| Warnings only | Waiting for Author |
| Any critical | Rejected |

#### AI Analysis Detail

Claude receives a structured prompt containing:
- The git diff (file + line changes)
- The full findings list with selectors and severities
- The baseline delta (new findings vs pre-existing)
- The target URL and route config

Claude outputs:
- **Verdict**: `PASS` / `WARN` / `BLOCK`
- **Attribution**: which findings were likely introduced by this PR vs pre-existing
- **Risk summary**: 2–3 sentence plain-English explanation
- **Recommended action**: what to fix before merging

#### Implementation Plan

| Step | File | Detail |
| --- | --- | --- |
| 1 | `src/integrations/github-pr-validator.js` | GitHub Checks API + PR comment posting |
| 2 | `src/integrations/azure-pr-validator.js` | Azure DevOps REST API — PR comments + vote |
| 3 | `src/utils/pr-diff-analyzer.js` | Map changed files → affected routes; extract diff context |
| 4 | `src/utils/ai-verdict.js` | Build Claude prompt, call Anthropic API, parse structured output |
| 5 | `src/mcp-server.js` | Expose `argus_pr_validate(prUrl, targetUrl)` as a new MCP tool |
| 6 | `action.yml` | GitHub Action entrypoint (argus-qa/pr-validator) |
| 7 | `azure-task/task.json` | Azure Pipelines task manifest |

**New env vars:**
```bash
ANTHROPIC_API_KEY=          # for AI verdict generation
GITHUB_TOKEN=               # already optional; now used for Check Runs API
AZURE_DEVOPS_PAT=           # Personal Access Token for Azure Repos + Pipelines
AZURE_ORG_URL=              # https://dev.azure.com/your-org
ARGUS_BLOCK_ON=critical     # none | warning | critical
```

**Extends**: `src/orchestration/dispatcher.js`, `src/mcp-server.js`
**New files**: `src/integrations/github-pr-validator.js`, `src/integrations/azure-pr-validator.js`, `src/utils/pr-diff-analyzer.js`, `src/utils/ai-verdict.js`, `action.yml`, `azure-task/task.json`

> 🔒 **Licensing — CLOSED SOURCE**: `ai-verdict.js`, `github-pr-validator.js`, and `azure-pr-validator.js` ship in the **private `argus-qa/argus-pro` repo**, not the public MIT repo. These files contain the AI verdict logic and are the first proprietary moat. The `action.yml` wrapper (which calls the hosted verdict API) can be public — it contains no business logic. `pr-diff-analyzer.js` and `src/mcp-server.js` additions remain MIT. See `business-analysis.md §6`.

---

### Sprint 8 — Advanced Security Audits + PDF/Video Export + Chrome Launcher
**Effort: Medium | Value: High**

This sprint is combined per the business execution roadmap (business-analysis.md §7 Month 5). All three sub-areas are shipped together: security depth, output formats, and setup-friction elimination.

**Security Audits** — Extends `src/utils/security-analyzer.js`

| Task | Detail |
| --- | --- |
| Dependency vulnerability scan | `npm audit --json` → parse CVEs → create findings |
| Credential exposure detection | Regex scan of all network responses for tokens / API keys |
| Source map disclosure | Check if `.js.map` files are publicly accessible |
| OWASP Top 10 passive | XSS reflection, open redirects, mixed content |
| SRI validation | Verify `integrity` attribute on external scripts |

**PDF Report Export + Video Recording** — New files: `src/utils/pdf-exporter.js`, `src/utils/screen-recorder.js`

- Branded PDF of the HTML report via `puppeteer` PDF print mode (Chrome already available); embed trend charts, diff images, finding tables; use cases: client delivery, compliance sign-off, QA retrospectives
- Record browser session as MP4 using CDP's `Page.startScreencast`; attach video to report for any run where findings are detected; storage: `reports/recordings/` with configurable retention; Cloudflare R2 for SaaS tier

**One-Command Chrome Launcher** — Risk mitigation (business-analysis.md §9: "Setup friction (Chrome + Node + MCP config) drives users away — High probability")

- Ship a `npm run chrome` (or `argus chrome`) command that downloads Chromium via `playwright-chromium` and launches it with the correct `--remote-debugging-port=9222` flags — one command, zero manual Chrome install
- Bundle a pre-flight check: `argus doctor` verifies Chrome is reachable, MCP config is valid, and `.env` has required keys — prints a clear fix message for each failure
- This is the highest-leverage setup friction reduction before the hosted SaaS tier ships

---

### Sprint 9 — Advanced Performance Metrics ✅ Complete (v9.5.4, 2026-06-05)
**Effort: Medium | Value: High**

| Task | License | Detail |
| --- | --- | --- |
| Web Vitals per-run capture | MIT | Detect LCP, FID/INP, CLS on each audit run; include values in the findings JSON |
| Bundle size regression | MIT | Detect JS/CSS size regressions between runs |
| Third-party script cost | MIT | CPU/memory cost per domain (OTel traces already exist — surface per-domain) |
| TTI tracking | MIT | `performance.getEntriesByType('navigation')` |
| RUM simulation | MIT | Replay real session timings via CDP |
| Web Vitals time-series storage API | 🔒 Closed | Persistence layer that stores per-run values across audits and builds trend lines — this feeds the Team-tier "Trend charts & regression alerts" feature in Sprint 10 |

> 🔒 **Licensing — SPLIT**: Per-run performance capture (all five rows above) is MIT — it writes values to the local findings JSON and is fully useful to self-hosted users. The **time-series storage API** (the layer that accumulates historical readings, computes trends, and feeds Sprint 10's trend charts) ships in the **private `argus-qa/argus-pro` repo**. This separation means the self-hosted tool gets richer per-run data without giving away the SaaS trend infrastructure. "Trend charts & regression alerts" is a Team+ paid feature per `business-analysis.md §3`.

---

### Sprint 10 — Web Dashboard with Historical Trends
**Effort: High | Value: Very High**

This is the SaaS dashboard described in `deployment-strategy.md §3 (Pro/Team tier)`. Shipping this sprint unlocks the Pro price raise to **$59/month** (see pricing milestone after Sprint 3). It also enables the **freemium SaaS tier** (1 project, 100 audits/month, no team features) — consider launching it once the dashboard is live to capture users who won't self-host; see `business-analysis.md §3 (Freemium SaaS Option)` for thresholds.

| Task | Detail |
| --- | --- |
| React SPA dashboard | Separate app — time-series charts, filters, drill-downs |
| Anomaly detection | Flag unusual spikes in finding counts per category |
| Team reports | Aggregate stats per project, per team member |
| Finding aging | Track how long each critical issue has been open |
| Quality scorecards | Overall product quality score with week-over-week trend |
| BI export | Snowflake / DataDog / Grafana connectors |

> 🔒 **Licensing — CLOSED SOURCE**: The entire Sprint 10 dashboard ships in the **private `argus-qa/argus-pro` repo**. No dashboard code enters the public MIT repo. The hosted infrastructure (auth, billing, cloud storage, scheduled runners) is also closed. The public repo's `src/` detection and CLI code is unchanged — the dashboard only reads reports that the open-source tool already writes. See `business-analysis.md §6`.

---

### Sprint 11 — Advanced User Flow Enhancements
**Effort: Medium | Value: Medium–High**

| Enhancement | Detail |
| --- | --- |
| Conditional steps | `if: { selector: '.banner' }` → `then: [...]` / `else: [...]` |
| Loop steps | Iterate over table rows, list items |
| Variable capture | Store element text/count; reference in later steps |
| Parallel flows | Multiple user journeys concurrently in separate browser tabs |
| Flow composition | Import another flow as a sub-routine |
| Screenshot at each step | Build visual storyboard of the entire flow |

**Extends**: `src/utils/flow-runner.js`

---

### Sprint 12 — Multi-Environment Parallel Testing
**Effort: Medium | Value: Medium**

- Simultaneously audit dev, staging, and production
- Configuration drift detection: compare nginx headers, cache-control, security headers across envs
- DNS resolution validation per environment
- Results merged into a single three-column comparison report

---

### Sprint 13 — Advanced Accessibility
**Effort: Medium | Value: Medium**

- Landmark navigation: verify `<main>`, `<nav>`, `<aside>`, `<footer>` presence and correct use
- Heading hierarchy: detect skipped levels (`h1→h3`)
- Table structure: `<th scope>`, `<thead>`, `<caption>` presence
- WAI-ARIA pattern compliance: validate against authoring practice patterns
- `prefers-reduced-motion` audit: verify animations respect the media query
- Modal/dialog testing: focus trap, backdrop, Escape key (already partially implemented)

---

### Sprint 14 — Content Quality Enhancements
**Effort: Medium | Value: Medium**

- Spelling & grammar detection via `languagetool` API
- Readability score: Flesch-Kincaid grade level
- Duplicate content detection across routes
- Schema.org / JSON-LD structured data validation
- OpenGraph image download & dimension check
- i18n: detect untranslated strings (`[object Object]`, missing translation keys)

---

### Sprint 15 — Compliance & Legal Checks
**Effort: Low | Value: Medium**

- GDPR cookie consent banner detection and consent flow validation
- CCPA "Do Not Sell" link presence
- Privacy Policy and Terms of Service link reachability
- npm package license compatibility scan
- Accessibility statement link detection

> 🔒 **Licensing — CLOSED SOURCE (Enterprise only)**: "Compliance & audit log reports" is an Enterprise-only feature in the pricing tier (`business-analysis.md §3`). The entire sprint ships in the **private `argus-qa/argus-pro` repo**. This is a key enterprise upsell — compliance teams pay for auditability, and giving it away in the MIT repo removes the incentive. The open-source tool continues to detect individual findings (CSP headers, cookie flags) through existing analyzers; this sprint adds the *compliance report format and audit log* that enterprise buyers require.

---

### Sprint 16 — Third-Party Integrations
**Effort: Medium | Value: Medium**

| Integration | License | Detail |
| --- | --- | --- |
| Datadog | 🔒 Closed (Team+) | Send findings as custom events to Datadog RUM/APM |
| Sentry | 🔒 Closed (Team+) | Forward JS errors to an existing Sentry project |
| Jira | 🔒 Closed (Enterprise) | Auto-create tickets for critical findings, link to finding ID |
| PagerDuty | 🔒 Closed (Enterprise) | Page on-call when critical finding count exceeds threshold |
| LaunchDarkly | 🔒 Closed (Enterprise) | Detect active feature flags; include in report context |
| Webhooks | 🔒 Closed (Enterprise) | Generic configurable webhook on any event type |

> 🔒 **Licensing — CLOSED SOURCE**: Every integration in this sprint maps to "Custom detection rules & policies" (Enterprise) or premium workflow tooling (Team+). None ship in the public MIT repo. Jira, PagerDuty, LaunchDarkly, and webhooks are explicitly Enterprise-tier. Datadog and Sentry connectors are Team+ (they require a running paid subscription on the receiving end and are not useful to solo self-hosters). The entire sprint ships in the **private `argus-qa/argus-pro` repo**. See `business-analysis.md §3` pricing table.

---

### Sprint 17 — AI-Powered Enhancements
**Effort: High | Value: Very High (long-term)**

| Enhancement | License | Detail |
| --- | --- | --- |
| Intelligent baseline filtering | MIT | Lightweight algorithmic classifier to filter false positives from known-noisy pages — no external API, pure heuristics |
| Root cause linking | MIT | Finding + recent git diff → heuristic map of changed files to affected routes; no API call |
| Natural language summaries | 🔒 Closed (Pro+) | AI-generated executive summary per report — calls Anthropic API on every run; billed usage; included in SaaS subscription |
| Recommended fixes | 🔒 Closed (Pro+) | Per-finding AI fix suggestion — calls Anthropic API per finding; billed; included in SaaS subscription |
| Predictive analytics | 🔒 Closed (Team+) | Forecast highest-risk routes based on historical trend data — requires Sprint 10 cloud history; meaningless without multi-run storage |

> 🔒 **Licensing — SPLIT**: "Intelligent baseline filtering" and "Root cause linking" are purely algorithmic — no external API, no per-run cost — and ship in the **public MIT repo**. "Natural language summaries", "Recommended fixes", and "Predictive analytics" call the Anthropic API (billed per use) or require cloud historical data (Sprint 10 private infrastructure), making them SaaS-tier features. These three ship in the **private `argus-qa/argus-pro` repo**. Shipping the open items first gives the MIT repo meaningful AI improvements while protecting the paid AI features.

---

## Figma MCP Integration — Flagship Detail (Sprint 2)


### What This Is

Argus connects to Figma via the [Figma REST API](https://www.figma.com/developers/api) (or the [Figma Context MCP server](https://github.com/GLips/Figma-Context-MCP)) to pull design tokens and component specs, then compares rendered browser output against the design source of truth.

This makes Argus the only QA tool that closes the **design → implementation gap** automatically — no Chromatic subscription, no manual screenshot comparison.

### Why It Matters

| Without Figma integration | With Figma integration |
| --- | --- |
| QA only checks bugs in what was built | QA checks whether what was built matches what was designed |
| Designer reviews are manual and slow | Deviations are caught automatically on every PR |
| No traceability between design and test | Every finding links directly to the Figma frame it came from |

### Architecture

```
Figma File / Frame
       │
       ▼  (Figma MCP Server or REST API)
figma-adapter.js  ──── pulls:
  • design tokens (colors, spacing, typography)
  • component bounding boxes
  • expected text content
       │
       ▼
design-fidelity-analyzer.js  ──── compares:
  • rendered DOM vs. Figma bounding boxes (position/size)
  • computed CSS colors vs. Figma color tokens
  • font-size / line-height vs. Figma typography
       │
       ▼
findings[]  ──── new category: D9 — Design Fidelity
```

### MCP Server Option

The [Figma Context MCP server](https://github.com/GLips/Figma-Context-MCP) exposes a `get_figma_data` tool that returns structured layout data for any Figma frame URL. Argus registers it as a second MCP server alongside `chrome-devtools`:

```json
// .mcp.json addition
{
  "mcpServers": {
    "figma": {
      "command": "npx",
      "args": ["-y", "figma-developer-mcp", "--figma-api-key=<FIGMA_TOKEN>"]
    }
  }
}
```

Claude calls `figma.get_figma_data(url)` before `argus_audit`, giving Argus design context before the browser audit begins.

### Implementation Plan

| Step | File | Detail |
| --- | --- | --- |
| 1 | `src/adapters/figma.js` | Thin adapter — `getFrame(fileKey, nodeId)` → `{ tokens, layers, bounds }` |
| 2 | `src/utils/design-fidelity-analyzer.js` | Compare DOM computed styles vs. Figma tokens; emit `D9` findings |
| 3 | `src/config/targets.js` | Add optional `figmaFrameUrl` per target |
| 4 | `src/orchestration/orchestrator.js` | If `figmaFrameUrl` present, fetch Figma data before crawl, pass to analyzer |
| 5 | `test-harness/pages/design-fidelity.html` | Fixture page with intentional token deviations |
| 6 | `test-harness/validate.js` | Block [94] — D9 design fidelity harness ([83] = watch dashboard, [84] = cli/init.js, [85]–[93] = Sprint 0.5 coverage gaps) |
| 7 | `src/mcp-server.js` | Expose `argus_design_audit(url, figmaFrameUrl)` as a new MCP tool |

### Config Example

```js
// src/config/targets.js
{
  url: 'http://localhost:3000/dashboard',
  figmaFrameUrl: 'https://www.figma.com/file/ABC123/Argus-UI?node-id=42%3A0',
}
```

### New Findings This Unlocks

| Finding | Severity | Description |
| --- | --- | --- |
| `design/color-mismatch` | warning | Computed color deviates from Figma token by >5% |
| `design/spacing-mismatch` | warning | Element margin/padding deviates from Figma spec by >4px |
| `design/typography-mismatch` | warning | Font size or weight differs from Figma text layer |
| `design/component-missing` | error | Figma layer present but no matching DOM element found |
| `design/overflow-vs-spec` | error | Element overflows its Figma bounding box |

---

## Quick Wins Summary

| Feature | Effort | Value | Sprint | Status |
| --- | --- | --- | --- | --- |
| Landing page mobile + SEO | Low | Critical | 0 | ✅ Complete (2026-05-26) |
| Codebase gap remediation (40 gaps) | Medium | Critical | 0.5 | ✅ Complete (Tiers 1–4, v9.5.1) |
| Dark mode visual testing | Low | High | 1 | ✅ Complete (2026-06-01, v9.5.2) |
| Figma MCP integration | Medium | Very High | 2 | ✅ Complete (2026-06-04, v9.5.3) |
| Visual regression testing | Medium | High | 3 | ✅ Complete (2026-06-06, v9.5.5) |
| `argus_visual_diff` MCP tool | Very Low | High | 3-ext | ⬜ |
| Axe-core + deep accessibility | Low | High | 4 | ⬜ |
| Motion & animation accessibility (A9) | Low | High | 5b | ⬜ |
| Font loading detection (A10) | Low–Medium | Medium–High | 5c | ⬜ |
| Form validation detection (A11) | Low | High | 5d | ⬜ |
| HAR recording & replay | Medium | High | 5 | ⬜ |
| GitHub PR inline diffs | Medium | High | 6 | ⬜ |
| Azure & GitHub PR AI Validator | Medium | Very High | 7 | ⬜ |
| Advanced security audits | Low–Medium | High | 8 | ⬜ |
| PDF report export | Medium | High | 8 | ⬜ |
| Video recording | Medium | High | 8 | ⬜ |
| One-command Chrome launcher | Low | High | 8 | ⬜ |
| Performance metrics time-series | Medium | High | 9 | ✅ Complete (2026-06-05, v9.5.4) |
| Web dashboard with trends | High | Very High | 10 | ⬜ |
| Advanced user flows | Medium | Medium–High | 11 | ⬜ |

---

## Harness Impact

| Metric | v9.5.0 (Sprint 0.5 Tier 3) | v9.5.2 (Sprint 1) | **v9.5.5 (Sprint 3 — current)** | vX1 target |
| --- | --- | --- | --- | --- |
| Detection categories | 54 | 55 (A7) | **58 (A7+D9+A8+Perf)** | 70+ |
| Test blocks | 126 | 127 (+[127]) | **130 (+[128]+[129]+[130])** | 110+ |
| Hard assertions | 528 | 535 | **581** | 500+ |
| Harness gate | 525/528 | 532/535 | **578/581** | 581/581 (OSS PRs) |
| MCP tools exposed | 6 | 6 | **7 (argus_design_audit)** | 8+ |
| npm version | 9.5.0 | 9.5.2 | **9.5.5** | — |
| MCP Registry | Live (9.5.1) | Pending | **✅ Live (auto-syncs)** | — |
| Sprints (vX1 total) | — | Sprint 0 ✅ · Sprint 0.5 ✅ · Sprints 1+2 ✅ | **Sprint 0 ✅ · Sprint 0.5 ✅ · Sprints 1+2+3+9 ✅** | 18+ |

---

## Open Questions for vX1

1. **Figma MCP vs REST API**: MCP is cleaner for Claude-native workflows; REST gives more control and no extra dependency.
2. **pixelmatch vs. resemblejs**: pixelmatch is faster; resemblejs has built-in anti-aliasing ignoring. Which fits CDP screenshots better?
3. **Video storage**: Local `reports/recordings/` for self-hosted; Cloudflare R2 for SaaS tier (already in `deployment-strategy.md`).
4. **Dashboard framework**: Separate app or extend the landing page repo?
5. **AI filtering model**: Claude API (hosted) or local model to avoid per-run latency/cost?
