/**
 * PR Diff Analyzer — maps GitHub PR changed files to affected Argus routes.
 *
 * parsePrUrl(prUrl)               → { owner, repo, prNumber }
 * fetchPrFiles(prUrl, token)      → string[] of changed file paths
 * mapFilesToRoutes(files, routes) → Route[] subset likely affected by the diff
 *
 * Pure functions + one async fetch — no Chrome, no MCP, no AI verdict.
 * AI verdict logic ships separately in the private argus-pro repo.
 */

/**
 * Parse a GitHub PR URL into its owner/repo/prNumber components.
 *
 * Accepted formats:
 *   https://github.com/owner/repo/pull/123
 *   https://github.com/owner/repo/pull/123/files
 *
 * @param {string} prUrl
 * @returns {{ owner: string, repo: string, prNumber: number }}
 */
export function parsePrUrl(prUrl) {
  const match = String(prUrl).match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/,
  );
  if (!match) throw new Error(`Invalid GitHub PR URL: ${prUrl}`);
  return { owner: match[1], repo: match[2], prNumber: parseInt(match[3], 10) };
}

/**
 * Fetch the list of file paths changed by a GitHub pull request (up to 100 files).
 *
 * @param {string} prUrl        - GitHub PR URL (any format accepted by parsePrUrl)
 * @param {string} [githubToken] - GitHub token; omit for public repos
 * @returns {Promise<string[]>}  - Changed file paths relative to the repo root
 */
export async function fetchPrFiles(prUrl, githubToken) {
  const { owner, repo, prNumber } = parsePrUrl(prUrl);
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'argusqa-os',
    ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
  };

  const allFiles = [];
  const MAX_PAGES = 3; // caps at 300 files; avoids runaway requests on mega-PRs

  for (let page = 1; page <= MAX_PAGES; page++) {
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`;
    const res = await fetch(apiUrl, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GitHub API ${res.status}: ${body || res.statusText}`);
    }
    const files = await res.json();
    allFiles.push(...files.map(f => f.filename));
    if (files.length < 100) break; // last page reached
  }

  if (allFiles.length >= 300) {
    console.log('::warning::PR has 300+ changed files — Argus analyzed the first 300. Routes affected by later files may be missed.');
  }

  return allFiles;
}

/**
 * Files that are never relevant to app routes — CI configs, docs, repo metadata.
 * Changes to ONLY these files cause mapFilesToRoutes to return [] (skip audit).
 */
const EXCLUDED_PATTERNS = [
  /^\.github\//i,
  /^docs?\//i,
  /\.md$/i,
  /^(LICENSE|CHANGELOG|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY)(\..*)?$/i,
  /^\.gitignore$/i,
  /^\.gitattributes$/i,
];

/**
 * Patterns that indicate an infrastructure-level file whose change can affect
 * every route — framework configs, root layouts, global stylesheets, package.json.
 * Exported for reuse by root-cause-linker.js (MIT).
 */
export const INFRA_PATTERNS = [
  /next\.config\./i,
  /vite\.config\./i,
  /tailwind\.config\./i,
  /postcss\.config\./i,
  /webpack\.config\./i,
  /global(s)?\.(css|scss|less)$/i,
  /(^|[/\\])(layout|_app|_document|root)\.(tsx?|jsx?)$/i,
  /(^|[/\\])app\.(tsx?|jsx?)$/i,
  /(^|[/\\])main\.(tsx?|jsx?)$/i,
  /package\.json$/i,
];

/**
 * Map a list of changed file paths to the subset of Argus route configs that
 * are likely affected, using heuristic slug matching.
 *
 * Heuristic rules (applied in order):
 *   1. Any infrastructure file → return ALL routes (full audit)
 *   2. File path contains a slug that matches a route path segment → include that route
 *   3. No matches → return ALL routes (conservative fallback — never miss a regression)
 *
 * @param {string[]} changedFiles - Relative file paths from fetchPrFiles
 * @param {Array<{ path: string, name: string }>} routes - Route configs from targets.js
 * @returns {Array<{ path: string, name: string }>}
 */
export function mapFilesToRoutes(changedFiles, routes) {
  if (!routes || routes.length === 0) return [];
  if (!changedFiles || changedFiles.length === 0) return routes;

  // Strip files that are never app-route-relevant (CI configs, docs, repo metadata)
  const appFiles = changedFiles.filter(
    f => !EXCLUDED_PATTERNS.some(re => re.test(f)),
  );

  // README-only / CI-only PR — skip the audit entirely
  if (appFiles.length === 0) return [];

  // Infrastructure change → full audit
  if (appFiles.some(f => INFRA_PATTERNS.some(re => re.test(f)))) {
    return routes;
  }

  // Build a flat set of lowercase slugs from app-relevant changed files
  const fileSlugs = new Set(
    appFiles.flatMap(f =>
      f.toLowerCase()
        .replace(/\.[^./\\]+$/, '')
        .split(/[/\\._-]+/)
        .filter(s => s.length > 1),
    ),
  );

  // Extract meaningful segments from a route path (e.g. "/checkout/review" → ["checkout","review"])
  const routeSegments = (route) =>
    route.path
      .toLowerCase()
      .split('/')
      .map(s => s.replace(/[^a-z0-9]/g, ''))
      .filter(s => s.length > 1);

  const matched = routes.filter(route =>
    routeSegments(route).some(seg => fileSlugs.has(seg)),
  );

  // Conservative fallback: if nothing matched, audit everything
  return matched.length > 0 ? matched : routes;
}
