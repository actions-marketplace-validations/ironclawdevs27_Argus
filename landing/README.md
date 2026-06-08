# Argus — Landing Page

Product marketing site for Argus. Runs independently from the main Argus QA harness.

## Tech Stack

| Layer | Library |
|---|---|
| Framework | React 19 |
| Build tool | Vite 8 |
| Styling | Tailwind CSS + inline styles |
| Animations | Framer Motion 12 |
| Forms backend | Supabase Postgres (REST via `@supabase/supabase-js`) |

## Local Development

```bash
cd landing
npm install
cp .env.example .env.local   # fill in your Supabase credentials
npm run dev                  # http://localhost:5173
```

## Environment Variables

Copy `.env.example` to `.env.local` (gitignored) and fill in:

```bash
VITE_SUPABASE_URL=https://<project-ref>.supabase.co   # bare project URL — no /rest/v1 suffix
VITE_SUPABASE_ANON_KEY=eyJ...                         # anon public key from Supabase dashboard
```

If either variable is missing the app still renders, but form submissions are silently dropped (a warning is logged to the console).

## Supabase Setup

1. Create a new Supabase project at [supabase.com](https://supabase.com).
2. Open **SQL Editor** and run:

```sql
-- Waitlist signups
CREATE TABLE IF NOT EXISTS waitlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  plan text NOT NULL DEFAULT 'free',
  created_at timestamptz DEFAULT now(),
  source text
);
ALTER TABLE waitlist ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public insert" ON waitlist FOR INSERT TO anon WITH CHECK (true);
GRANT INSERT ON waitlist TO anon;

-- Enterprise contact requests
CREATE TABLE IF NOT EXISTS enterprise_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL,
  company text NOT NULL,
  team_size text,
  region text,
  use_case text,
  workflow text,
  message text,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE enterprise_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public insert" ON enterprise_contacts FOR INSERT TO anon WITH CHECK (true);
GRANT INSERT ON enterprise_contacts TO anon;
```

> **Note**: If you created the project with "Automatically expose new tables" disabled, you must run the `GRANT INSERT` statements even if the RLS policies already exist. PostgREST requires schema-level permission (`GRANT`) in addition to row-level permission (RLS policy).

3. Copy your **Project URL** and **anon public key** from Project Settings → API into `.env.local`.

## Build

```bash
npm run build    # outputs to landing/dist/
npm run preview  # serve the production build locally
```

`landing/dist/` is gitignored. **Live deployment**: [argus-qa.com](https://argus-qa.com) via Cloudflare Pages (project: `argus-qa`). Background video served from Cloudflare R2 (`pub-4a48bc28d90e4425a6fb87b164225d13.r2.dev`).

To redeploy:

```bash
cd landing
npm run build
npx wrangler pages deploy dist --project-name argus-qa
```

## Component Structure

All UI lives in `src/App.jsx` as a single-file app. Hero section is built inline inside `App()`:

| Component | Purpose |
|---|---|
| `Logo` | SVG icon — purple ring + dot |
| `BetaBadge` | "BETA" pill badge |
| `SectionLabel` | Reusable section label chip |
| `FeaturesSection` | Feature grid (12 cards with icons) |
| `DetectionSection` | Detection category accordion |
| `SetupSection` | Setup / code snippet tabs |
| `ComparisonTable` | Pricing comparison table (3-column) |
| `PricingSection` | Pricing cards + comparison table |
| `DocsSection` | Collapsible docs accordion |
| `Footer` | Nav links + copyright |
| `WaitlistModal` | Email + plan selector → inserts into `waitlist` table |
| `EnterpriseModal` | name, email, company, team_size, region, use_case, workflow, message → inserts into `enterprise_contacts` table |

`src/supabase.js` exports the singleton Supabase client (or `null` if env vars are absent).

## Sprint 0 Mobile & SEO Status (2026-05-26)

| Issue | Status | Notes |
|---|---|---|
| Comparison table scroll | ✅ Already handled | `overflowX: 'auto'` was already on the inner wrapper |
| Touch targets < 44px | ✅ Fixed | All 4 interactive buttons raised to 44×44px |
| Video poster fallback | ✅ Fixed | `Argus_bg.png` → `landing/public/argus-poster.png`; `poster="/argus-poster.png"` on `<video>` tag |
| Modal soft keyboard (iOS) | ✅ Fixed | Both modal wrappers now have `maxHeight: 100dvh` + `overflowY: auto` |
| `prefers-reduced-motion` | ✅ Fixed | `<MotionConfig reducedMotion="user">` wraps the entire app |
| `@media` edge cases | ✅ Fixed | `100dvh` via `@supports` in `index.css`; stat row / detection grid / nav handle narrow viewports natively |
| SEO — OG / Twitter / JSON-LD | ✅ Added | `index.html` has full OG tags, Twitter card, canonical, JSON-LD schema |
| `robots.txt` + `sitemap.xml` | ✅ Added | Both in `landing/public/` |
| OG social card | ✅ Done | `og-image-v2.jpg` — 1200×630 JPEG, cover-mode scaled from `argus-poster.png`, branded overlay, black-outlined purple stat numbers (original 54 / 84 / 367 — baked into image asset); `og-image.jpg` gitignored |
| Mobile stats layout | ✅ Fixed | Stats row stacks vertically on mobile (`flex-col sm:flex-row`); slide widget reduced from 8 → 6 slides; `clamp()`-based fluid typography |
| Deployment | ✅ Live | `npx wrangler pages deploy dist --project-name argus-qa`; custom domain `argus-qa.com` active |

## Stats Update (2026-05-31)

Hero stats and docs section updated to reflect gap-close completion (blocks [94]–[126]):

| Field | Old | New |
|---|---|---|
| `stats[1].num` (TEST BLOCKS) | `93` | `126` |
| `stats[2].num` (ASSERTIONS RUN) | `394` | `528` |
| Docs § "Test Coverage" tagline | `93 blocks, 394 hard assertions` | `126 blocks, 528 hard assertions` |
| Docs § "Breakdown" | Ended at Blocks 79–93 | Added Blocks 94–126 bullet |
| Docs § "Running" code | `394 hard assertions`, `391/394` | `528 hard assertions`, `525/528` |
| "How we built it" caption | `84 test blocks` | `126 test blocks` |

## Stats Update (2026-06-02 — Sprint 2 v9.5.3)

Hero stats and docs section updated to reflect Sprint 2 (block [128] — D9 Design Fidelity):

| Field | Old | New |
|---|---|---|
| `stats[1].num` (TEST BLOCKS) | `127` | `128` |
| `stats[2].num` (ASSERTIONS RUN) | `535` | `544` |
| Docs § "Test Coverage" tagline | `127 blocks, 535 hard assertions` | `128 blocks, 544 hard assertions` |
| Docs § "Running" code | `535 hard assertions`, `532/535` | `544 hard assertions`, `541/544` |
| "How we built it" caption | `127 test blocks` | `128 test blocks` |

## Stats Update (2026-06-04 — Sprint 2 maximum potential)

Block [128] expanded from 9 → 24 assertions. D9 now has 12 finding types. Hero and docs updated:

| Field | Old | New |
|---|---|---|
| `stats[2].num` (ASSERTIONS RUN) | `544` | `559` |
| Docs § "Test Coverage" tagline | `128 blocks, 544 hard assertions` | `128 blocks, 559 hard assertions` |
| Docs § "Running" code | `544 hard assertions`, `541/544` | `559 hard assertions`, `556/559` |

## Stats Update (2026-06-04 — D9 gap fixes: shadow color+spread, per-corner radius, position drift, selector fallback)

Block [128] expanded to 30 assertions. D9 now has 13 mismatch finding types. Hero and docs updated:

| Field | Old | New |
|---|---|---|
| `stats[2].num` (ASSERTIONS RUN) | `559` | `565` |
| Docs § "Test Coverage" tagline | `128 blocks, 559 hard assertions` | `128 blocks, 565 hard assertions` |
| Docs § "Running" code | `559 hard assertions`, `556/559` | `565 hard assertions`, `562/565` |

## Stats Update (2026-06-05 — Sprint 9 v9.5.4)

Sprint 9 — Web Vitals & Bundle Size: `web-vitals-analyzer.js` (block [129], headless LCP/CLS/FCP/TTI/TTFB + bundle size regression). Hero and docs updated:

| Field | Old | New |
|---|---|---|
| `stats[1].num` (TEST BLOCKS) | `128` | `129` |
| `stats[2].num` (ASSERTIONS RUN) | `565` | `572` |
| Docs § "Test Coverage" tagline | `128 blocks, 565 hard assertions` | `129 blocks, 572 hard assertions` |
| Docs § "Running" code | `565 hard assertions`, `562/565` | `572 hard assertions`, `569/572` |
| "How we built it" caption | `128 test blocks` | `129 test blocks` |

## Stats Update (2026-06-06 — Sprint 3 v9.5.5)

Sprint 3 — A8 Visual Regression: `visual-diff-analyzer.js` (block [130], pixelmatch baseline comparison). Hero and docs updated:

| Field | Old | New |
|---|---|---|
| `stats[0].num` (DETECTION TYPES) | `58` | `58` (unchanged from Sprint 9 recount) |
| `stats[1].num` (TEST BLOCKS) | `129` | `130` |
| `stats[2].num` (ASSERTIONS RUN) | `572` | `581` |
| Docs § "Test Coverage" tagline | `129 blocks, 572 hard assertions` | `130 blocks, 581 hard assertions` |
| Docs § "Running" code | `572 hard assertions`, `569/572` | `581 hard assertions`, `578/581` |
| Feature table `All 56 detection categories` | `56` | `58` |

## Stats Update (2026-06-06 — Sprint 4 v9.5.6)

Sprint 4 — A12 Deep Accessibility: `a11y-deep-analyzer.js` (block [131], axe-core 4.12 + CVD color blind simulation). Hero and docs updated:

| Field | Old | New |
|---|---|---|
| `stats[0].num` (DETECTION TYPES) | `58` | `59` |
| `stats[1].num` (TEST BLOCKS) | `130` | `131` |
| `stats[2].num` (ASSERTIONS RUN) | `581` | `590` |
| Docs § "Test Coverage" tagline | `130 blocks, 581 hard assertions` | `131 blocks, 590 hard assertions` |
| Docs § "Running" code | `581 hard assertions`, `578/581` | `590 hard assertions`, `587/590` |
| Feature table `All 58 detection categories` | `58` | `59` |

## Stats Update (2026-06-06 — Sprint 3 Extension v9.5.7)

Sprint 3 Extension — argus_visual_diff MCP tool: wired existing visual-diff-analyzer as 8th MCP tool. No new detection categories or fixture pages.

| Field | Old | New |
|---|---|---|
| MCP tools | 7 | **8** (argus_visual_diff added) |
| Hard assertions | 590 | **592** ([80m]+[80n] registration + [117c/d] threshold) |
| Harness gate | 587/590 | **589/592** |
| Version | 9.5.6 | **9.5.7** |

## Stats Update (2026-06-07 — Sprints 5/5b/5c/5d v9.5.8)

Sprints 5/5b/5c/5d — N1 HAR Network Baseline, A9 Motion & Animation, A10 Font Loading, A11 Form Validation: `har-recorder.js`, `motion-analyzer.js`, `font-analyzer.js`, `form-analyzer.js` (blocks [132]–[135], 4 new fixture pages). Hero and docs updated:

| Field | Old | New |
|---|---|---|
| `stats[0].num` (DETECTION TYPES) | `59` | `63` |
| `stats[1].num` (TEST BLOCKS) | `131` | `135` |
| `stats[2].num` (ASSERTIONS RUN) | `592` | `616` |
| Docs § "Test Coverage" tagline | `131 blocks, 592 hard assertions` | `135 blocks, 616 hard assertions` |
| Docs § "Running" code | `592 hard assertions`, `589/592` | `616 hard assertions`, `613/616` |
| Feature table detection count | `59` | `63` |
| "How we built it" caption | `131 test blocks` | `135 test blocks` |

## Stats Update (2026-06-08 — Sprint 7 v9.6.0)

Sprint 7 — PR Diff Analyzer: `pr-diff-analyzer.js` + `argus_pr_validate` 9th MCP tool + `action.yml` GitHub Action wrapper (block [137], 8 assertions). No new detection categories or fixture pages. Hero and docs updated:

| Field | Old | New |
|---|---|---|
| `stats[1].num` (TEST BLOCKS) | `136` | `137` |
| `stats[2].num` (ASSERTIONS RUN) | `626` | `634` |
| MCP tools | 8 | **9** (`argus_pr_validate` added) |
| Docs § "Test Coverage" tagline | `136 blocks, 626 hard assertions` | `137 blocks, 634 hard assertions` |
| Docs § "Running" code | `626 hard assertions`, `623/626` | `634 hard assertions`, `631/634` |
| "How we built it" caption | `136 test blocks` | `137 test blocks` |
| Block [137] bullet | — | Added to Breakdown section |

---

## Stats Update (2026-06-07 — Sprint 6 v9.5.9)

Sprint 6 — GitHub Check Runs: `github-reporter.js` extended with `createCheckRun`/`completeCheckRun` (GitHub Checks API), `generateReleaseNotes()`, `ARGUS_CRITICAL_THRESHOLD` gate, `ARGUS_DIFF_IMAGE_URL`, `GITHUB_CHECK_NAME`; block [136] (10 assertions). No new detection categories or fixture pages. Hero and docs updated:

| Field | Old | New |
|---|---|---|
| `stats[1].num` (TEST BLOCKS) | `135` | `136` |
| `stats[2].num` (ASSERTIONS RUN) | `616` | `626` |
| Docs § "Test Coverage" tagline | `135 blocks, 616 hard assertions` | `136 blocks, 626 hard assertions` |
| Docs § "Running" code | `616 hard assertions`, `613/616` | `626 hard assertions`, `623/626` |
| "How we built it" caption | `135 test blocks` | `136 test blocks` |
